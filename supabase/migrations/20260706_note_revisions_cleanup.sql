-- note_revisions 30일 지난 것 자동 정리 (매일 새벽 3시, pg_cron).
-- Supabase 대시보드 → SQL Editor에서 이 파일 전체를 1회 실행하세요.
-- (재실행해도 안전 — cron.schedule은 같은 jobname이면 스케줄을 갱신함)

create extension if not exists pg_cron with schema extensions;

select cron.schedule(
  'note_revisions_cleanup',
  '0 3 * * *',  -- 매일 03:00 (UTC)
  $$
    delete from note_revisions
    where captured_at < (extract(epoch from now()) * 1000 - 30 * 24 * 3600 * 1000)
  $$
);
