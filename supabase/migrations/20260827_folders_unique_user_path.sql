-- PARA 기본 폴더가 앱 재시작마다 중복 생성된 문제의 정리 + DB 측 방어선.
-- Supabase SQL Editor에서 한 번 실행한다.
--
-- 실행 전에 supabase/queries/inspect_duplicate_folders.sql 로 무엇이 지워지는지
-- 먼저 확인할 것. (읽기 전용)
--
-- 안전장치 3개:
--   1. 삭제 전에 folders 전체를 backup 스키마에 복사한다 (public 밖 = API 노출 안 됨)
--   2. 전체가 하나의 트랜잭션 — 검증 실패 시 아무것도 반영되지 않는다
--   3. "폴더를 잃은 노트" 수가 늘어나면 예외를 던져 스스로 롤백한다
--
-- 삭제 대상은 같은 (user_id, path)를 가진 중복 행뿐이며, 각 그룹에서 id가 가장
-- 작은 행 1개는 반드시 남는다. notes 테이블은 이 스크립트에서 읽기만 한다.
-- 노트는 notes.folder(경로 문자열)로 폴더에 연결되므로 중복 행 제거로 잃는
-- 노트/파일은 없다.

begin;

-- ── 0) 되돌릴 수 있는 백업 ───────────────────────────────────────────────────
create schema if not exists backup;

create table if not exists backup.folders_20260827 as
  select * from folders;

-- 복원이 필요하면 (문제가 생겼을 때만). 아래 unique 인덱스가 중복 복원을 막으므로
-- 인덱스를 먼저 지워야 한다 — 이 순서 그대로 실행할 것:
--   begin;
--   drop index if exists folders_user_id_path_key;
--   delete from folders;
--   insert into folders select * from backup.folders_20260827;
--   commit;
-- 확인이 끝난 뒤 정리:  drop table backup.folders_20260827;

-- ── 1) 중복 정리 + 검증 ──────────────────────────────────────────────────────
do $$
declare
  orphans_before int;
  orphans_after  int;
  folders_before int;
  removed        int;
begin
  select count(*) into folders_before from folders;

  select count(*) into orphans_before
  from notes n
  where n.folder is not null
    and not exists (
      select 1 from folders f where f.user_id = n.user_id and f.path = n.folder
    );

  -- 1a) 지워질 행을 부모로 가진 하위 폴더를 "남는 행"으로 재연결.
  --     parent_id에 ON DELETE CASCADE가 걸려 있어도 하위 폴더가 함께
  --     삭제되지 않도록, 삭제보다 먼저 수행한다.
  update folders f
  set parent_id = r.keep_id
  from (
    select
      id,
      first_value(id) over (partition by user_id, path order by id) as keep_id
    from folders
  ) r
  where f.parent_id = r.id
    and r.id <> r.keep_id;

  -- 1b) 각 (user_id, path) 그룹에서 id가 가장 작은 행만 남기고 삭제
  with ranked as (
    select id, row_number() over (partition by user_id, path order by id) as rn
    from folders
  )
  delete from folders
  where id in (select id from ranked where rn > 1);

  get diagnostics removed = row_count;

  select count(*) into orphans_after
  from notes n
  where n.folder is not null
    and not exists (
      select 1 from folders f where f.user_id = n.user_id and f.path = n.folder
    );

  if orphans_after > orphans_before then
    raise exception
      '중단(롤백): 폴더를 잃은 노트가 % → % 로 늘어났습니다', orphans_before, orphans_after;
  end if;

  if exists (
    select 1 from folders group by user_id, path having count(*) > 1
  ) then
    raise exception '중단(롤백): 정리 후에도 중복 경로가 남아 있습니다';
  end if;

  raise notice
    '폴더 % 행 → % 행 (중복 % 건 삭제). 폴더를 잃은 노트 증가 없음 (% 건 유지).',
    folders_before, folders_before - removed, removed, orphans_before;
end $$;

-- ── 2) 재발 방지: 같은 유저의 같은 경로는 한 번만 ────────────────────────────
create unique index if not exists folders_user_id_path_key
  on folders (user_id, path);

commit;
