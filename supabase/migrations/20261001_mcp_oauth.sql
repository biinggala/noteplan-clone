-- 원격 MCP 서버의 OAuth 2.1 지원 (claude.ai·폰 앱 커넥터는 URL만 받고 OAuth로 로그인한다).
--
-- 20260901_mcp_tokens.sql 의 mcp_tokens 를 그대로 확장한다. 한 행 = 한 번의
-- 연결 승인(grant). 행이 거치는 상태:
--
--   ① 동의 대기   consent_hash 있음           (구글 로그인 직후, 사용자가 [허용] 누르기 전)
--   ② 코드 발급   code_hash 있음              ([허용] 직후, 클라이언트가 /token 호출 전)
--   ③ 활성        token_hash·refresh_hash 유효 (이후 1시간마다 refresh 로 회전)
--
-- 토큰·코드·nonce 는 전부 원문 대신 SHA-256 해시만 저장한다. 서버는 여전히
-- service_role 없이 SECURITY DEFINER 함수로만 이 상태를 바꾼다.

alter table public.mcp_tokens
  add column if not exists token_expires_at   timestamptz,   -- null = 만료 없음 (기존 PAT)
  add column if not exists client_id_hash     text,
  add column if not exists redirect_uri       text,
  add column if not exists code_challenge     text,
  add column if not exists oauth_state        text,
  add column if not exists consent_hash       text unique,
  add column if not exists consent_expires_at timestamptz,
  add column if not exists code_hash          text unique,
  add column if not exists code_expires_at    timestamptz,
  add column if not exists refresh_hash       text unique;

-- ── 접근 토큰 확인: 만료·미완성 행 제외 ─────────────────────────────────────
-- ①·② 단계 행은 token_hash 가 아무도 모르는 난수 해시지만, 그래도 활성 행만
-- 통과시키도록 조건을 명시한다 (방어선 한 겹 더).
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
     and t.revoked_at is null
     and t.consent_hash is null
     and t.code_hash is null
     and (t.token_expires_at is null or t.token_expires_at > now());

  if t_user_id is null then
    return;   -- 없는/취소된/만료된 토큰을 구분해 주지 않는다
  end if;

  update public.mcp_tokens set last_used_at = now() where token_hash = p_hash;
  return next;
end;
$$;

-- ── 동의: ① → ② (허용) 또는 취소 (거부). nonce 는 한 번만 쓰인다 ─────────────
create or replace function public.mcp_oauth_consent(
  p_consent_hash text, p_allow boolean, p_code_hash text, p_code_ttl_seconds integer)
returns table (t_redirect_uri text, t_state text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with u as (
    update public.mcp_tokens t
       set consent_hash       = null,
           consent_expires_at = null,
           code_hash          = case when p_allow then p_code_hash end,
           code_expires_at    = case when p_allow then now() + make_interval(secs => p_code_ttl_seconds) end,
           revoked_at         = case when p_allow then null else now() end
     where t.consent_hash = p_consent_hash
       and t.consent_expires_at > now()
       and t.revoked_at is null
    returning t.redirect_uri, t.oauth_state
  )
  select u.redirect_uri, u.oauth_state from u;
end;
$$;

-- ── 코드 교환: ② → ③. 조건이 전부 맞아야 하고, 맞으면 코드는 그 자리에서 소멸 ──
-- PKCE(code_challenge)·client·redirect_uri 를 WHERE 에서 한 번에 확인하므로,
-- 동시에 두 번 교환해도 하나만 성공한다. 틀린 verifier 는 코드를 태우지 않는다.
create or replace function public.mcp_oauth_redeem_code(
  p_code_hash text, p_client_id_hash text, p_redirect_uri text, p_challenge text,
  p_token_hash text, p_refresh_hash text, p_token_ttl_seconds integer)
returns table (t_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with u as (
    update public.mcp_tokens t
       set code_hash        = null,
           code_expires_at  = null,
           token_hash       = p_token_hash,
           refresh_hash     = p_refresh_hash,
           token_expires_at = now() + make_interval(secs => p_token_ttl_seconds)
     where t.code_hash = p_code_hash
       and t.code_expires_at > now()
       and t.client_id_hash = p_client_id_hash
       and t.redirect_uri = p_redirect_uri
       and t.code_challenge = p_challenge
       and t.revoked_at is null
    returning t.user_id
  )
  select u.user_id from u;
end;
$$;

-- ── 리프레시: 접근 토큰과 리프레시 토큰을 함께 회전. 옛 리프레시 토큰은 즉시 무효 ──
create or replace function public.mcp_oauth_refresh(
  p_refresh_hash text, p_client_id_hash text,
  p_new_token_hash text, p_new_refresh_hash text, p_token_ttl_seconds integer)
returns table (t_user_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with u as (
    update public.mcp_tokens t
       set token_hash       = p_new_token_hash,
           refresh_hash     = p_new_refresh_hash,
           token_expires_at = now() + make_interval(secs => p_token_ttl_seconds),
           last_used_at     = now()
     where t.refresh_hash = p_refresh_hash
       and t.client_id_hash = p_client_id_hash
       and t.revoked_at is null
    returning t.user_id
  )
  select u.user_id from u;
end;
$$;

revoke all on function public.mcp_oauth_consent(text, boolean, text, integer) from public;
revoke all on function public.mcp_oauth_redeem_code(text, text, text, text, text, text, integer) from public;
revoke all on function public.mcp_oauth_refresh(text, text, text, text, integer) from public;
grant execute on function public.mcp_oauth_consent(text, boolean, text, integer) to anon, authenticated;
grant execute on function public.mcp_oauth_redeem_code(text, text, text, text, text, text, integer) to anon, authenticated;
grant execute on function public.mcp_oauth_refresh(text, text, text, text, integer) to anon, authenticated;
