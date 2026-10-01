# NotePlan MCP server

내 노트(Supabase)를 Claude(데스크톱/Code)에 **검색·조회·연결·작성** 도구로 노출하는 로컬 MCP 서버.
"두 번째 뇌"의 읽기+쓰기 루프를 여는 첫 단계 — 임베딩 없이 태그/백링크/키워드/최근성만으로도 즉시 유용.

## 도구
| 도구 | 설명 |
|---|---|
| `search_notes` | 제목·본문 키워드 검색 (요약 + id) |
| `get_note` | 노트 전체 조회 (id / title / date) |
| `list_recent` | 최근 수정 노트 (type 필터 가능) |
| `list_by_tag` | 태그 포함 노트 (계층 태그 포함) |
| `get_backlinks` | 이 노트를 `[[링크]]`한 노트들 (지식 그래프) |
| `create_note` | 새 노트 생성 (PARA folder 지정 가능) |
| `append_to_note` | 기존 노트 본문에 추가 |
| `update_note` | 기존 본문 수정 (find+replace 권장, 전체 교체도 가능) |
| `append_to_daily` | 데일리 노트에 추가 (없으면 생성) |

## 설정 (1회)

```bash
cd mcp-server
npm install
npm run build
npm run login
```

`npm run login`이 브라우저를 열어 **앱과 같은 Google 계정**으로 로그인시킨다.
로그인 결과(refresh token)는 `~/.noteplan-mcp/session.json` 에 저장된다(권한 600, 이 저장소 바깥).

친구도 자기 계정으로 이 저장소를 그대로 clone해서 `npm run login`만 하면
자기 노트만 보는 자기 전용 서버가 된다 — 별도 설정 필요 없음.

## Claude Code에 등록 — ① 로컬 (stdio)

같은 컴퓨터에서만 쓸 때. URL이 없고, Claude가 이 프로세스를 직접 실행한다.

```bash
claude mcp add noteplan -- node /Users/biinggala/Documents/Noteplan-clone/mcp-server/dist/index.js
```

등록 후 Claude에게 "내 최근 노트 보여줘", "#journal 태그 노트 찾아줘",
"오늘 데일리 노트에 이거 추가해줘" 처럼 요청하면 도구를 사용합니다.

## Claude Code에 등록 — ② URL (원격 HTTP)

폰·다른 컴퓨터·웹 Claude에서도 쓰고 싶을 때. 서버를 한 번 띄워두고 URL로 붙는다.
**먼저 [SECURITY.md](./SECURITY.md) 를 읽으세요** — 자격증명 보관 위치가
내 디스크에서 서버로 옮겨가고, 그에 따른 위험과 필수 설정이 정리돼 있다.

### 서버 띄우기

```bash
# 1) DB 준비: Supabase SQL Editor 에서
#    supabase/migrations/20260901_mcp_tokens.sql 실행

# 2) 서버 환경변수 (호스팅 플랫폼에 설정)
MCP_SESSION_KEY=$(openssl rand -base64 32)     # 저장 세션 암호화 키 — 필수
MCP_ALLOWED_HOSTS=mcp.example.com              # Host 검사 (없으면 검사 비활성)
MCP_ALLOWED_EMAILS=me@example.com              # 등록 허용 계정 (비우면 누구나)

# 3) 실행 (HTTPS 종단 뒤에)
npm run build && npm run serve                 # 기본 :8787
```

엔드포인트는 `POST /mcp` (MCP), `POST /enroll` (등록), `GET /healthz` 뿐이다.
`/healthz` 는 값은 감추고 **무엇이 빠졌는지**만 알려준다 (`MCP_SESSION_KEY` 가
없으면 503):

```json
{ "ok": true, "checks": { "session_key": true, "allowed_hosts": false, ... },
  "warnings": ["MCP_ALLOWED_HOSTS 없음 — Host 검사 비활성"] }
```

### 어디에 올릴까

| 방법 | 필요한 것 |
|---|---|
| **Render** (권장) | 대시보드 → New → Blueprint → 이 저장소(브랜치 `main`). 루트의 `render.yaml` 을 읽는다. 입력할 값은 `MCP_ALLOWED_EMAILS` 하나 — 키는 Render 가 만들고, 공개 주소·허용 Host 는 Render 가 넣어 주는 `RENDER_EXTERNAL_URL` 을 서버가 그대로 쓴다 |
| **Fly / Railway / Cloud Run** | 저장소의 `Dockerfile` 사용 (`rootDir` = `mcp-server`) |
| **맥 + 터널** (임시) | `npm run serve` + `cloudflared tunnel --url http://localhost:8787` |

서버리스(Vercel Functions 등)에도 올라가지만 권하지 않는다 — 인스턴스가 계속
바뀌어서 레이트리밋과 refresh 직렬화(single-flight)가 인스턴스별로 쪼개진다.
상주 프로세스 쪽이 이 용도에 맞다.

### 배포 직후 점검

```bash
npm run smoke -- --server https://mcp.example.com
npm run smoke -- --server https://mcp.example.com --token npmcp_...   # 토큰까지 확인
```

설정 경고, 무인증 401, 엉터리 토큰 401, `GET /mcp` 405, (토큰이 있으면)
`initialize` 핸드셰이크와 도구 9개까지 확인한다. 노트 내용은 출력하지 않는다.

### 내 계정 등록 + 토큰 받기

```bash
npm run enroll -- --server https://mcp.example.com --label "맥북"
```

`enroll` 은 **이 등록만을 위한 새 로그인**을 브라우저로 진행한다. 로컬 stdio
서버가 쓰는 `~/.noteplan-mcp/session.json` 은 건드리지 않는다.

> **왜 세션을 따로 쓰나.** Supabase는 refresh 할 때마다 refresh_token 을 새로
> 발급하고 옛것을 죽인다(로테이션). 로컬 서버와 원격 서버가 같은 토큰을 나눠
> 쓰면 먼저 쓴 쪽이 다른 쪽을 죽여서 양쪽 다
> `Invalid Refresh Token: Already Used` 로 실패한다. 굳이 공유하려면
> `--use-saved-session` 이 있지만 권하지 않는다.

출력된 명령을 그대로 실행하면 등록된다:

```bash
claude mcp add --transport http noteplan https://mcp.example.com/mcp \
  --header "Authorization: Bearer npmcp_..."
```

토큰은 발급 시 **한 번만** 보인다(서버에는 해시만 남는다). 유출이 의심되면
`mcp_tokens` 의 해당 행 `revoked_at` 을 채우면 즉시 막힌다.

### claude.ai · 폰 앱에서 쓰기 — URL만 (OAuth)

claude.ai 커스텀 커넥터는 URL 만 받는다(헤더 칸이 없다). 이 서버는 OAuth 를
지원하므로 **URL 하나만 넣으면 구글 로그인 → 승인 화면이 뜨고 연결된다.**
토큰을 복사할 필요가 없다. 설정은 한 번만:

1. **DB** — Supabase SQL Editor 에서 `supabase/migrations/20261001_mcp_oauth.sql` 실행
2. **Supabase 리다이렉트 허용** — Dashboard → Authentication → URL Configuration
   → Redirect URLs 에 `https://내-주소/oauth/callback` 추가.
   **빠뜨리면 구글 로그인 후 NotePlan 앱 화면으로 튕긴다.**
3. **서버 환경변수** — 바깥에서 보이는 정확한 주소:
   ```bash
   export MCP_PUBLIC_URL=https://내-주소       # 끝에 / 없이, /mcp 없이
   npm run serve
   ```
4. **확인** — `npm run smoke -- --server https://내-주소` 에서
   `✓ OAuth 메타데이터 — 활성` 이 떠야 한다 (주소가 틀리면 여기서 잡힌다)
5. **연결** — claude.ai → 설정 → 커넥터 → 커스텀 커넥터 추가 → URL 에
   `https://내-주소/mcp` → 구글 로그인 → 승인 화면에서 [허용]

승인 화면은 어떤 앱이 어느 계정의 노트를 읽고 쓰려는지 보여준다.
**직접 시작한 연결이 아니면 거부하세요** — 남이 보낸 링크로 승인하면 그 사람의
Claude 에 내 노트가 연결된다 (SECURITY.md 13.4).

| 환경변수 | 뜻 |
|---|---|
| `MCP_PUBLIC_URL` | 바깥 주소. 없으면 OAuth 비활성 (헤더 토큰만) |
| `MCP_OAUTH_REDIRECT_HOSTS` | 돌아갈 수 있는 호스트. 기본 `claude.ai,claude.com,localhost,127.0.0.1` |
| `MCP_ALLOWED_EMAILS` | 승인할 수 있는 계정 (헤더 등록·OAuth 공통) |

### 로컬과 원격의 차이

| | stdio | URL |
|---|---|---|
| 접속 | 프로세스 실행 | `https://…/mcp` + PAT 헤더, 또는 URL만 (OAuth) |
| 세션 위치 | `~/.noteplan-mcp/session.json` | 서버 DB(암호화) + 서버 키 |
| 사용자 격리 | 프로세스 = 1명 | 요청마다 인증·클라이언트 분리 (RLS가 최종 방어) |
| 폰에서 사용 | 불가 | 가능 |

## 보안

- **service_role 키를 쓰지 않는다.** 그 키는 Postgres RLS를 완전히 우회하는
  프로젝트 전체 마스터키라, 나눠주면 받은 사람이 (코드와 무관하게) 다른
  사용자의 노트까지 볼 수 있게 된다. 이전 버전은 이 키를 썼고, 그래서
  친구에게 그대로 공유할 수 없었다.
- 대신 각자 자기 Google 계정으로 로그인한 세션을 쓴다. 이후 모든 쿼리는
  Postgres RLS(`notes` 테이블의 `auth.uid() = user_id` 정책)가 자동으로
  로그인한 자기 자신의 행에만 묶는다 — 코드가 필터를 빼먹는 버그가 있어도
  DB 자체가 막는다.
- Supabase URL과 anon key는 소스에 그대로 들어있다. 이건 비밀이 아니다 —
  앱의 웹 번들에도 이미 공개돼 있고(`NEXT_PUBLIC_` 접두어), 실제 보안 경계는
  키의 비밀유지가 아니라 RLS다.
- `~/.noteplan-mcp/session.json` (refresh token)은 이 컴퓨터에서 로그인한
  사람 본인의 노트에만 쓸 수 있다. 남과 공유하면 그 세션으로 로그인한 것과
  같으니 주고받지 말 것.
- (이전 버전을 쓰던 사람) 기존 `mcp-server/.env`의 `SUPABASE_SERVICE_ROLE_KEY`는
  더 이상 안 쓴다. 파일을 지워도 되고, 찜찜하면 Supabase 대시보드에서
  키를 재발급(rotate)해도 된다.

- 원격(URL) 모드의 위협 모델·완화·남은 위험은 [SECURITY.md](./SECURITY.md) 에
  따로 정리했다. 요약: 남의 노트가 보이는 사고(요청 간 세션 혼입)는 구조적으로
  막고 테스트로 지키지만, "서버가 refresh token을 보관한다"는 새 위험은
  완화만 가능하다.

## 테스트

```bash
npm test    # 타입 검사 + 격리 18개 + OAuth 23개 + 공식 SDK 클라이언트 3개
```

가짜 Supabase(실제 RLS처럼 JWT의 sub로만 행을 노출)를 띄워 놓고, 다른 사용자의
노트가 절대 섞이지 않는지 확인한다.

## 다음 단계 (로드맵)
1. ✅ 읽기+쓰기+수정 도구
2. ✅ 자기 계정 로그인 기반 인증 — 지인 공유 가능
3. ✅ URL(원격 HTTP) 접속 — 폰·웹에서도 사용
4. ✅ OAuth — claude.ai·앱 커넥터에 URL만 넣고 연결 (지금)
5. 리프레시 재사용 감지 · 읽기 전용 토큰 (SECURITY.md 12항)
6. pgvector 의미검색 — 저장 시 임베딩 생성, 유사도 검색 도구 추가
7. 활성도(salience) 모델 — 최근성·링크수·열람 기반 중요도 가중 → 검색 랭킹에 블렌딩
8. 정체성 프로필 자동 증류 — ambient personalization
