# 원격(URL) MCP 서버 보안 점검

`npm run serve` 로 URL을 열면 무엇이 위험해지는지, 어디까지 막았고 무엇이
남았는지 정리한 문서. 결론부터: **가장 큰 사고 유형(남의 노트가 보이는 것)은
구조적으로 막았고 테스트로 지키고 있다. 대신 "서버가 사용자 자격증명을
보관한다"는 새 위험이 생겼다 — 이건 URL로 여는 순간 피할 수 없는 성질이다.**

## 0. 무엇이 달라졌나 — 신뢰 경계의 이동

| | stdio (기존) | URL (새로 추가) |
|---|---|---|
| 실행 주체 | 내 컴퓨터의 Claude가 프로세스를 띄움 | 인터넷의 서버 프로세스 |
| 사용자 수 | 1 프로세스 = 1 사용자 | 한 프로세스가 여러 사용자 요청 처리 |
| 자격증명 위치 | `~/.noteplan-mcp/session.json` (0600, 내 디스크) | 서버 DB(암호문) + 서버 환경변수(키) |
| 털렸을 때 | 그 컴퓨터 쓰는 사람만큼의 피해 | 등록한 사람 **전원**의 노트 읽기·쓰기 |

세 번째 줄이 이 변경의 본질이다. 원격 서버는 사용자를 대신해 Supabase에
접속해야 하므로 refresh token을 들고 있어야 한다. 아래 3항에서 완화책을
설명하지만, "서버 관리자를 신뢰한다"는 전제는 사라지지 않는다.

## 1. 요청 간 세션 혼입 → 남의 노트 노출 · **막음**

가장 위험했던 지점이고, 기존 코드 구조가 실제로 여기에 취약했다.

```ts
// 예전 index.ts — 모듈 로드 시점에 딱 한 번
const { db, userId: USER_ID } = await getAuthedClient()
const base = () => db.from('notes').select('*').eq('user_id', USER_ID)
```

stdio에서는 프로세스가 곧 한 사람이라 문제가 없다. 그런데 이 전역을 그대로
두고 HTTP를 붙이면, **먼저 접속한 사람의 세션으로 이후 모든 사용자의 요청이
처리된다.** B가 자기 토큰으로 붙어도 A의 노트가 그대로 응답에 실린다.

지금 구조:

- 도구는 전역을 참조하지 않고 인자로 받은 컨텍스트만 쓴다 (`src/tools.ts:53`,
  `registerTools(server, ctx)`)
- 요청마다 인증 → 요청마다 새 Supabase 클라이언트 → 요청마다 새 MCP 서버
  (`src/http.ts:167-171`)
- 캐시하는 것은 PAT별 세션 토큰뿐이고, 클라이언트 객체는 캐시하지 않는다

**검증**: `test/remote-isolation.test.ts` 18개. 가짜 Supabase는 실제 RLS처럼
**JWT의 sub로만** 행을 보여주고 클라이언트가 보낸 `user_id=eq.…` 필터는
신뢰하지 않는다. 그래서 서버가 엉뚱한 세션을 쓰면 남의 노트가 응답에 나오고
테스트가 깨진다.

이 테스트가 실제로 버그를 잡는지도 확인했다 — `clientForPat`에 전역 캐시
한 줄(예전 구조)을 일부러 넣으니 4개가 깨졌다:

```
not ok 4 - 각 PAT는 자기 노트만 본다
not ok 5 - 교차 순서로 불러도 세션이 섞이지 않는다
not ok 6 - 동시 요청에서도 섞이지 않는다
not ok 8 - 쓰기도 자기 계정으로만 나간다     ← B의 쓰기가 A 계정으로 저장됨
```

## 2. 클라이언트가 남의 user_id를 주장하기 · **막음**

`user_id`를 요청 본문에서 절대 받지 않는다. 등록 시 access token을 Supabase에
물어봐서(`auth.getUser`) 주인을 알아내고, 토큰 행 삽입도 **그 사용자 본인의
JWT로** 나간다 → RLS `with check (auth.uid() = user_id)` 가 DB에서 한 번 더 막는다.

실제 PostgreSQL 16에서 확인:

```
① B가 A의 user_id로 토큰 행 위조 → ERROR: new row violates row-level security policy
④ 등록 요청에 user_id: B 를 끼워넣어도 → 발급된 토큰은 A 것 (테스트 14)
```

## 3. 서버가 refresh token을 보관한다 · **구조적 위험, 완화**

URL로 여는 순간 불가피하다(Claude는 정적 헤더만 보내므로, 만료 1시간인
access token을 매번 새로 받아올 주체가 서버여야 한다). 완화:

- refresh token은 **AES-256-GCM으로 봉인**해 저장 (`src/crypto.ts`). 키는 서버
  환경변수 `MCP_SESSION_KEY` 에만 있다 → **DB만 새는 것으로는 쓸 수 없다**
- access token은 저장하지 않는다 (첫 요청에서 새로 받는다) — 보관 표면 축소
- 토큰 행마다 `revoked_at` — 유출 의심 시 즉시 차단
- 로테이션 경쟁 방지: PAT별 single-flight (`src/remote-auth.ts`) — 동시 요청이
  각자 refresh해 서로의 토큰을 죽이는 사고(로컬 버전 주석의 그 사고)를 막는다

**남은 위험**: 서버가 완전히 털리면(환경변수 + DB 동시) 등록한 사람 전원의
노트를 읽고 쓸 수 있다. 이건 완화만 가능하고 제거는 불가능하다. 그래서
호스트를 노트 자체와 같은 등급으로 취급해야 한다.

### 곁가지: 로컬 서버와 세션을 공유하면 둘 다 죽는다

`enroll` 은 등록 전용으로 새 로그인을 한다. 로컬 stdio 서버와 같은
refresh_token 을 공유하면 로테이션 때문에 서로를 무효화해서 양쪽 다
`Invalid Refresh Token: Already Used` 로 실패한다. 보안 문제라기보다 가용성
문제지만, 증상이 "세션 만료"로 보여 원인을 찾기 어렵다.

### 곁가지: 등록에 남의 refresh token 을 끼워넣는 경우

A가 (어딘가에서 훔친) B의 refresh token 으로 자기 이름으로 등록하면, 토큰 행의
주인은 A인데 그 안에 봉인된 세션은 B가 된다. 이 경우 첫 사용 시점에
`refreshOnce` 가 **저장하기 전에** 세션 주인과 행 주인을 비교해 403으로 끊는다
(`src/remote-auth.ts`). B의 노트는 응답에 실리지 않는다 (테스트 15).

다만 이 시점에 Supabase 쪽에서는 이미 로테이션이 일어나 B의 원래 refresh
token 이 무효화된다 — B는 재로그인해야 한다. 데이터 유출은 아니지만 방해는
된다. 애초에 B의 refresh token 이 새어 있어야 성립하는 시나리오다.

## 4. service_role 키를 여전히 쓰지 않음 · **막음**

토큰 조회는 서버가 DB를 직접 읽어야 해서 원래대로면 service_role이 필요했다.
그 키는 RLS를 통째로 우회하는 프로젝트 마스터키라, 서버에 두면 서버 침해가
**등록하지 않은 사용자까지 포함한 전체 유출**로 번진다.

대신 `SECURITY DEFINER` 함수 두 개만 열었다 (`supabase/migrations/20260901_mcp_tokens.sql`):

- `mcp_redeem_token(hash)` → `(user_id, 봉인된 세션)`
- `mcp_store_session(hash, cipher)` → 로테이션 결과 저장

노출면이 좁다: 256비트 토큰의 **해시를 알아야** 하고, 돌려받는 건 서버 키
없이는 못 여는 **암호문**이다. 테이블 자체는 anon에게 권한이 없다.

PostgreSQL 16 실측:

| 시나리오 | 결과 |
|---|---|
| anon 이 `mcp_tokens` 직접 SELECT | `ERROR: permission denied` |
| B가 A의 토큰 행 조회 | 0행 (RLS) |
| A가 자기 행 조회 | 1행 |
| anon + 정확한 해시로 `mcp_redeem_token` | 1행 (암호문) |
| anon + 틀린 해시 | 0행 |
| 취소된(`revoked_at`) 토큰 | 0행 |
| 취소된 토큰에 `mcp_store_session` | 반영 안 됨 (되살리기 불가) |

## 5. PAT 유출 = 그 사람 노트 전체 · **남은 위험**

PAT 하나면 그 사용자의 노트를 읽고 쓸 수 있다. 지금은 범위(읽기 전용 등)도
만료도 없다. 그리고 PAT는 Claude 설정 파일에 평문으로 저장된다.

지금 있는 방어: 원문 미저장(SHA-256 해시만), 기기별 발급, `last_used_at`
기록(이상 사용 탐지), `revoked_at` 즉시 차단, 로그에 원문 미기록(끝 4자만).

**권고**: 읽기 전용 스코프와 만료(예: 90일)를 추가하는 것. 지금 PR에서는
검토 범위를 넘겨 넣지 않았다 — 아래 9항.

## 6. 무인증 접근 / 세션 ID 탈취 · **막음**

- 인증 없으면 401 + `WWW-Authenticate` (테스트 1) — 응답에 노트 내용이 섞이지
  않는지도 확인한다
- **stateless** (`sessionIdGenerator: undefined`, `src/http.ts:174`) — `Mcp-Session-Id`
  를 아예 발급하지 않으므로, 원격 MCP에서 흔한 "세션 ID 추측/재사용으로 남의
  컨텍스트에 올라타기"가 구조적으로 불가능하다. `GET /mcp` 는 405 (테스트 10)

## 7. 전송 구간 · **막음(설정 필요)**

PAT와 (등록 시) refresh token이 평문으로 흐르면 중간에서 가져가는 순간 끝이다.
`requireTls()` 가 `x-forwarded-proto`/소켓을 보고 평문 요청을 400으로 거절한다.
`MCP_ALLOW_INSECURE=1` 일 때만 예외(로컬 테스트용)이고, 그 경우 시작 시 경고를 찍는다.

**한계**: `x-forwarded-proto` 는 앞단 프록시가 정직하게 세팅해 줄 때만 의미가
있다. 프록시 없이 서버를 직접 노출하면 공격자가 이 헤더를 위조해 우회할 수
있다. 즉 이 검사는 방어가 아니라 **"TLS 종단 뒤에 둔다"는 배포 전제를 어겼을 때
알아차리게 하는 장치**다. 반드시 플랫폼 TLS나 리버스 프록시 뒤에 두세요.

## 8. DNS rebinding / 브라우저발 요청 · **설정해야 실제로 막힌다**

`enableDnsRebindingProtection: true` 로 켜 뒀지만, SDK는 **허용목록이 있을 때만
실제로 검사한다** (`webStandardStreamableHttp.js:113,122` — 목록이 비면 통과).
그래서 `MCP_ALLOWED_HOSTS` 가 없으면 시작 시 경고를 찍는다. 배포 시 반드시:

```
MCP_ALLOWED_HOSTS=mcp.example.com
MCP_ALLOWED_ORIGINS=https://claude.ai        # 브라우저 클라이언트를 쓸 때만
```

## 9. 남용·자원 고갈 · **완화**

- 본문 1MB 제한 (메모리 고갈). 깨진 JSON 은 400 (테스트 16)
- IP·PAT별 분당 요청 제한(기본 120, `MCP_RATE_LIMIT`). **인스턴스 메모리
  기준**이라 여러 인스턴스로 뜨면 그만큼 느슨하다 → 앞단(Cloudflare 등)에서
  거는 게 정석
- `/enroll` 은 이메일 허용목록(`MCP_ALLOWED_EMAILS`)으로 좁힐 수 있다. 비워두면
  계정이 있는 누구나 등록 가능하다 — 각자 자기 노트만 보이지만, "나와 친구
  몇 명"만 쓰는 서버라면 채워두는 편이 낫다 (테스트 11)

## 10. 이 서버와 무관하게 먼저 확인해야 하는 것 · **확인 필요**

**여기까지의 모든 격리는 `notes`/`folders` 의 RLS에 전부 기대고 있다.** RLS가
꺼져 있으면 위 설계는 의미가 없다(코드의 `user_id` 필터만 남는데, 그건 버그
한 줄로 뚫린다). Supabase SQL Editor에서 확인:

```sql
-- 셋 다 true 여야 한다
select relname, relrowsecurity from pg_class
 where relname in ('notes','folders','mcp_tokens');

-- auth.uid() = user_id 형태의 조건이 select/insert/update/delete 에 있어야 한다
select tablename, policyname, cmd, qual, with_check from pg_policies
 where tablename in ('notes','folders','mcp_tokens');
```

또 하나, 이 PR과 무관한 선재 사항: `note:<id>` **Realtime broadcast 채널**은
기본 설정에서 RLS로 보호되지 않는다. 현재 실어 보내는 건 `{typing, author}`
뿐이고 채널 이름에 노트 UUID가 필요해 위험은 낮지만, 이 채널로 본문을
보내기 시작하면 그때부터는 유출 경로가 된다. Realtime Authorization을 켜 두는
편이 안전하다.

## 11. 배포 체크리스트

```bash
MCP_SESSION_KEY=$(openssl rand -base64 32)   # 32바이트. 서버 환경변수에만
MCP_ALLOWED_HOSTS=mcp.example.com
MCP_ALLOWED_EMAILS=me@example.com,friend@example.com
# MCP_ALLOW_INSECURE 는 절대 켜지 말 것 (로컬 테스트 전용)
```

- [ ] HTTPS 종단(플랫폼 TLS 또는 리버스 프록시) 뒤에 둔다
- [ ] 플랫폼 로그가 요청 헤더를 남기지 않게 한다 (Authorization = PAT)
- [ ] `supabase/migrations/20260901_mcp_tokens.sql` 적용
- [ ] 위 10항 RLS 확인 쿼리 실행
- [ ] `MCP_SESSION_KEY` 를 잃으면 저장된 세션을 못 열어 전원 재등록해야 한다 — 백업
- [ ] 키를 교체할 땐 재등록이 필요하다 (복호화 실패 시 안내 메시지가 나간다)

## 12. 다음 단계 권고 (지금 PR에 없음)

1. **읽기 전용 PAT** — `mcp_tokens.scopes` 추가, 쓰기 도구는 스코프 있을 때만 등록.
   유출 시 피해를 "읽기"로 묶는다. 가장 값싼 개선.
2. **PAT 만료** — `expires_at` + 갱신 명령.
3. **OAuth 2.1** (MCP 인증 스펙) — 서버가 자격증명을 오래 들고 있지 않아도 되는
   방향. Claude는 지원하지만 Supabase를 인가 서버로 쓰려면 동적 클라이언트
   등록 문제를 풀어야 한다.
4. **엣지 레이트리밋 + 감사 로그** — 토큰별 요청량 이상치 알림.
