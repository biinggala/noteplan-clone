-- notes / folders 행 수준 보안(RLS) — "다른 유저의 노트를 볼 수 없다"를 코드로 고정한다.
--
-- 왜: 이 두 테이블을 만드는 마이그레이션이 저장소에 없다(대시보드에서 손으로 만듦).
-- 그래서 RLS가 켜져 있는지, 정책이 '본인 행만'인지 저장소만 봐서는 알 수 없었다.
-- anon 키는 앱 번들에 들어 있는 공개값이라, RLS가 꺼져 있거나 정책이 느슨하면
-- 누구든 GET /rest/v1/notes 로 모든 유저의 노트를 읽을 수 있다. 또 앱은 upsert
-- (onConflict:'id') 를 쓰므로, UPDATE 정책에 WITH CHECK 가 없으면 남의 노트 id 로
-- upsert 해서 내용을 덮어쓰고 user_id 까지 가로챌 수 있다.
--
-- 이 파일은 몇 번을 실행해도 결과가 같다(멱등).
--   1) 두 테이블의 기존 정책을 모두 지우고 (느슨한 정책이 하나라도 남으면 OR 로
--      합쳐져 구멍이 그대로 남는다)
--   2) select/insert/update/delete 각각 '본인 행만' 정책을 다시 만든다.
--   3) anon 역할의 테이블 권한을 회수한다 (로그인 전에는 아무것도 못 한다).
--
-- 데이터는 건드리지 않는다. 정책만 바꾼다.
-- user_id 가 text 든 uuid 든 동작하도록 양쪽을 ::text 로 비교한다.
--
-- 실행 후 확인 (Supabase SQL Editor):
--   select relname, relrowsecurity from pg_class where relname in ('notes','folders','note_revisions');
--     → 셋 다 relrowsecurity = true
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--    where tablename in ('notes','folders','note_revisions') order by 1, 3;
--     → 모든 qual / with_check 에 auth.uid() 비교가 들어 있어야 한다

begin;

-- ── 기존 정책 제거 ───────────────────────────────────────────────────────────
do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
     where schemaname = 'public' and tablename in ('notes', 'folders')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- ── notes ────────────────────────────────────────────────────────────────────
alter table public.notes enable row level security;

create policy notes_select_own on public.notes for select to authenticated
  using (user_id::text = (select auth.uid())::text);
create policy notes_insert_own on public.notes for insert to authenticated
  with check (user_id::text = (select auth.uid())::text);
create policy notes_update_own on public.notes for update to authenticated
  using (user_id::text = (select auth.uid())::text)
  with check (user_id::text = (select auth.uid())::text);
create policy notes_delete_own on public.notes for delete to authenticated
  using (user_id::text = (select auth.uid())::text);

revoke all on public.notes from anon;
grant select, insert, update, delete on public.notes to authenticated;
create index if not exists notes_user_id_idx on public.notes (user_id);

-- ── folders ──────────────────────────────────────────────────────────────────
alter table public.folders enable row level security;

create policy folders_select_own on public.folders for select to authenticated
  using (user_id::text = (select auth.uid())::text);
create policy folders_insert_own on public.folders for insert to authenticated
  with check (user_id::text = (select auth.uid())::text);
create policy folders_update_own on public.folders for update to authenticated
  using (user_id::text = (select auth.uid())::text)
  with check (user_id::text = (select auth.uid())::text);
create policy folders_delete_own on public.folders for delete to authenticated
  using (user_id::text = (select auth.uid())::text);

revoke all on public.folders from anon;
grant select, insert, update, delete on public.folders to authenticated;

-- ── note_revisions: 본인 것 읽기만. 쓰기는 트리거(capture_note_revision)만 ─────
-- FORCE RLS 는 걸지 않는다 — 걸면 트리거(테이블 소유자 권한)의 insert 도 막혀
-- 노트 저장이 전부 실패한다.
alter table public.note_revisions enable row level security;
revoke all on public.note_revisions from anon;
revoke insert, update, delete on public.note_revisions from authenticated;
grant select on public.note_revisions to authenticated;

-- SECURITY DEFINER 함수는 search_path 를 고정해 둔다 (다른 스키마의 같은 이름
-- 테이블로 바꿔치기 당하지 않게)
alter function public.capture_note_revision() set search_path = public;

-- 20260827 마이그레이션이 만든 폴더 백업 스키마 — API 로 보이지 않게
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'backup') then
    execute 'revoke all on schema backup from anon, authenticated';
  end if;
end $$;

commit;
