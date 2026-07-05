-- 노트 버전 히스토리: notes 테이블 UPDATE 시 이전 내용을 자동으로 note_revisions에 저장.
-- 앱/MCP/서버 어느 경로로 덮어써지든 DB 레벨에서 무조건 붙잡아두기 위한 안전망.
-- Supabase 대시보드 → SQL Editor에서 이 파일 전체를 1회 실행하세요.

create table if not exists note_revisions (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references notes(id) on delete cascade,
  user_id uuid not null,
  content text not null,
  tags text[] not null default '{}',
  mentions text[] not null default '{}',
  backlinks text[] not null default '{}',
  revised_at bigint not null,   -- 이 버전이 "현재"였던 시점 (old.updated_at)
  captured_at bigint not null   -- 이 리비전을 기록한 시점 (덮어써진 순간)
);

create index if not exists note_revisions_note_id_idx
  on note_revisions (note_id, revised_at desc);

alter table note_revisions enable row level security;

drop policy if exists "own revisions" on note_revisions;
create policy "own revisions" on note_revisions
  for select using (auth.uid() = user_id);

create or replace function capture_note_revision() returns trigger as $$
begin
  if old.content is distinct from new.content then
    insert into note_revisions (note_id, user_id, content, tags, mentions, backlinks, revised_at, captured_at)
    values (old.id, old.user_id, old.content, old.tags, old.mentions, old.backlinks, old.updated_at, (extract(epoch from now()) * 1000)::bigint);
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_capture_note_revision on notes;
create trigger trg_capture_note_revision
  before update on notes
  for each row execute function capture_note_revision();

-- (선택) 오래된 리비전 정리 — 원하면 90일 지난 것 주기적으로 삭제:
-- delete from note_revisions where captured_at < (extract(epoch from now()) * 1000 - 90*24*3600*1000);
