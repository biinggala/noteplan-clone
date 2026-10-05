-- 구글 캘린더 refresh token 을 서버에 보관한다 (google-token-refresh Edge Function 전용).
--
-- 왜: 예전엔 refresh token(캘린더 읽기·쓰기, 사용자가 철회하기 전까지 유효)을
-- 브라우저 localStorage 에 평문으로 두었다. 페이지에서 도는 스크립트 하나만 있으면
-- (XSS, 악성 의존성, 브라우저 확장) 훔쳐갈 수 있었다.
--
-- 이 테이블은 클라이언트(anon/authenticated)에게 아무 권한도 주지 않는다.
-- RLS 를 켜고 정책을 하나도 만들지 않으므로, service role 을 쓰는 Edge Function
-- 만 읽고 쓸 수 있다. 사용자는 자기 토큰조차 직접 읽을 수 없다 — 함수가 대신
-- access token 으로 바꿔 줄 뿐이다.
--
-- 함수가 이 테이블이 없을 때도 예전처럼(보관 없이) 동작하므로 배포 순서는 상관없다.

create table if not exists public.google_tokens (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at    timestamptz not null default now()
);

alter table public.google_tokens enable row level security;
revoke all on public.google_tokens from anon, authenticated;
