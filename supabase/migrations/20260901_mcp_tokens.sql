-- 원격(URL) MCP 서버용 개인 접속 토큰(PAT).
--
-- 배경: 로컬 stdio 서버는 각자 자기 컴퓨터의 세션 파일만 썼다. URL로 열면
-- 서버가 사용자를 대신해 Supabase에 접속해야 하므로 세션을 보관해야 한다.
-- 그 보관을 최대한 무해하게 만드는 설계:
--   • 토큰 원문은 저장하지 않는다 (SHA-256 해시만)
--   • 세션(refresh token)은 서버 환경변수 키로 AES-256-GCM 암호화한 뒤 저장
--   • 테이블은 RLS로 잠그고, 서버는 service_role 키 없이 SECURITY DEFINER
--     함수 두 개로만 접근한다 (인자가 사실상 비밀, 반환값은 암호문)

create table if not exists public.mcp_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  token_hash     text not null unique,
  label          text,
  session_cipher text not null,
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

create index if not exists mcp_tokens_user_id_idx on public.mcp_tokens (user_id);

alter table public.mcp_tokens enable row level security;

-- 사용자는 자기 토큰만 보고, 만들고, 취소한다.
-- (anon 키로는 아무 행도 보이지 않는다 — 아래 함수 경로만 열려 있다)
drop policy if exists mcp_tokens_select_own on public.mcp_tokens;
create policy mcp_tokens_select_own on public.mcp_tokens
  for select using (auth.uid() = user_id);

drop policy if exists mcp_tokens_insert_own on public.mcp_tokens;
create policy mcp_tokens_insert_own on public.mcp_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists mcp_tokens_update_own on public.mcp_tokens;
create policy mcp_tokens_update_own on public.mcp_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists mcp_tokens_delete_own on public.mcp_tokens;
create policy mcp_tokens_delete_own on public.mcp_tokens
  for delete using (auth.uid() = user_id);

-- 테이블 권한은 명시적으로 좁힌다.
--   • authenticated: 자기 행만 (위 RLS 정책이 실제 범위를 정한다)
--   • anon: 테이블 접근 전혀 없음 — 아래 함수 두 개로만 들어온다
-- (Supabase 기본 권한은 public 스키마 테이블을 anon 에게도 열어두고 RLS에만
--  기대는데, 여기선 한 겹 더 좁힌다. RLS 설정이 틀려도 anon 은 못 읽는다.)
grant select, insert, update, delete on public.mcp_tokens to authenticated;
revoke all on public.mcp_tokens from anon;

-- ── 서버가 쓰는 두 함수 ──────────────────────────────────────────────────────
-- PAT 해시로 (사용자, 봉인된 세션)을 꺼낸다. 취소된 토큰은 0행.
-- SECURITY DEFINER 지만 노출면은 좁다: 256비트 토큰의 해시를 알아야 하고,
-- 돌려주는 건 서버 키 없이는 못 여는 암호문이다.
create or replace function public.mcp_redeem_token(p_hash text)
returns table (t_user_id uuid, t_session_cipher text)
language plpgsql
security definer
set search_path = public
as $$
begin
  select t.user_id, t.session_cipher
    into t_user_id, t_session_cipher
    from public.mcp_tokens t
   where t.token_hash = p_hash
     and t.revoked_at is null;

  if t_user_id is null then
    return;   -- 없는 토큰과 취소된 토큰을 구분해 주지 않는다
  end if;

  update public.mcp_tokens set last_used_at = now() where token_hash = p_hash;
  return next;
end;
$$;

-- refresh token 로테이션 결과를 다시 봉인해 저장한다.
create or replace function public.mcp_store_session(p_hash text, p_cipher text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mcp_tokens
     set session_cipher = p_cipher,
         last_used_at = now()
   where token_hash = p_hash
     and revoked_at is null;
end;
$$;

revoke all on function public.mcp_redeem_token(text) from public;
revoke all on function public.mcp_store_session(text, text) from public;
grant execute on function public.mcp_redeem_token(text) to anon, authenticated;
grant execute on function public.mcp_store_session(text, text) to anon, authenticated;

-- ── 확인용 ───────────────────────────────────────────────────────────────────
-- 이 서버의 안전은 notes/folders 의 RLS에 전부 기대고 있다. 반드시 확인:
--   select relname, relrowsecurity from pg_class
--    where relname in ('notes','folders','mcp_tokens');   -- 셋 다 true 여야 함
--   select tablename, policyname, cmd, qual from pg_policies
--    where tablename in ('notes','folders');              -- auth.uid() = user_id 조건
