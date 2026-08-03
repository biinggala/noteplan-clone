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

## Claude Code에 등록

```bash
claude mcp add noteplan -- node /Users/biinggala/Documents/Noteplan-clone/mcp-server/dist/index.js
```

등록 후 Claude에게 "내 최근 노트 보여줘", "#journal 태그 노트 찾아줘",
"오늘 데일리 노트에 이거 추가해줘" 처럼 요청하면 도구를 사용합니다.

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

## 다음 단계 (로드맵)
1. ✅ 읽기+쓰기+수정 도구 (지금)
2. ✅ 자기 계정 로그인 기반 인증 — 지인 공유 가능 (지금)
3. pgvector 의미검색 — 저장 시 임베딩 생성, 유사도 검색 도구 추가
4. 활성도(salience) 모델 — 최근성·링크수·열람 기반 중요도 가중 → 검색 랭킹에 블렌딩
5. 정체성 프로필 자동 증류 — ambient personalization
