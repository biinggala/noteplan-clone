#!/usr/bin/env bash
# NotePlan 원격 MCP 서버를 Google Cloud Run 에 배포한다.
#
#   cd mcp-server && npm run deploy:cloudrun
#
# 처음 실행: 세션 키를 Secret Manager 에 만들고 → 빌드·배포 → 배정된 주소를
#           MCP_PUBLIC_URL / MCP_ALLOWED_HOSTS 로 넣는다.
# 다시 실행: 같은 키·같은 주소로 새 코드만 올린다 (연결이 끊기지 않는다).
#
# 바꿀 수 있는 값 (환경변수):
#   GCP_PROJECT              기본: gcloud config 의 현재 프로젝트
#   REGION                   기본: asia-northeast3 (서울)
#   SERVICE                  기본: noteplan-mcp
#   MCP_ALLOWED_EMAILS       연결을 허용할 계정 (없으면 물어본다)
#   MCP_OAUTH_REDIRECT_HOSTS 기본: claude.ai,claude.com,localhost,127.0.0.1,agent.meta.ai
set -euo pipefail

REGION="${REGION:-asia-northeast3}"
SERVICE="${SERVICE:-noteplan-mcp}"
SECRET="${SERVICE}-session-key"
REDIRECT_HOSTS="${MCP_OAUTH_REDIRECT_HOSTS:-claude.ai,claude.com,localhost,127.0.0.1,agent.meta.ai}"

say()  { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || fail "gcloud 가 없습니다. 설치: brew install --cask google-cloud-sdk  → 그다음 gcloud auth login"
command -v openssl >/dev/null 2>&1 || fail "openssl 이 없습니다."
gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q . \
  || fail "gcloud 에 로그인돼 있지 않습니다. gcloud auth login 을 먼저 실행하세요."

PROJECT="${GCP_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
[ -n "$PROJECT" ] || fail "GCP 프로젝트를 모릅니다. GCP_PROJECT=프로젝트ID npm run deploy:cloudrun 으로 지정하세요 (목록: gcloud projects list)"

EMAILS="${MCP_ALLOWED_EMAILS:-}"
if [ -z "$EMAILS" ]; then
  read -r -p "연결을 허용할 이메일 (쉼표로 여러 개): " EMAILS
fi
[ -n "$EMAILS" ] || fail "허용할 이메일이 필요합니다."

cd "$(dirname "$0")"   # mcp-server — Dockerfile 이 있는 곳

echo
echo "  프로젝트  $PROJECT"
echo "  리전      $REGION"
echo "  서비스    $SERVICE"
echo "  허용 계정 $EMAILS"
echo "  콜백 호스트 $REDIRECT_HOSTS"
if [ "${YES:-}" != "1" ]; then
  read -r -p "이대로 배포할까요? [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) fail "취소했습니다." ;; esac
fi

say "필요한 API 켜기 (이미 켜져 있으면 그냥 넘어갑니다)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com --project "$PROJECT"

say "세션 키 (Secret Manager: $SECRET)"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  echo "  이미 있음 — 그대로 씁니다 (기존 연결 유지)"
else
  # 키는 화면에도 파일에도 남기지 않고 바로 Secret Manager 로 보낸다
  openssl rand -base64 32 | tr -d '\n' \
    | gcloud secrets create "$SECRET" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
  echo "  새로 만들었습니다"
fi
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" \
  --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor >/dev/null
echo "  Cloud Run 이 읽을 수 있게 권한 부여: $RUN_SA"

# 이미 배포된 적이 있으면 주소를 미리 안다 → 이번 배포에 그대로 넣는다
URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --format='value(status.url)' 2>/dev/null || true)"

ENVFILE="$(mktemp)"
trap 'rm -f "$ENVFILE"' EXIT
{
  echo "MCP_ALLOWED_EMAILS: \"${EMAILS}\""
  echo "MCP_OAUTH_REDIRECT_HOSTS: \"${REDIRECT_HOSTS}\""
  if [ -n "$URL" ]; then
    echo "MCP_PUBLIC_URL: \"${URL}\""
    echo "MCP_ALLOWED_HOSTS: \"${URL#https://}\""
  fi
} > "$ENVFILE"

say "빌드 + 배포 (Dockerfile 사용, 처음엔 몇 분 걸립니다)"
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --source . \
  --allow-unauthenticated \
  --env-vars-file "$ENVFILE" \
  --set-secrets "MCP_SESSION_KEY=${SECRET}:latest" \
  --quiet

if [ -z "$URL" ]; then
  URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
  [ -n "$URL" ] || fail "배포는 됐지만 주소를 읽지 못했습니다. gcloud run services describe $SERVICE --region $REGION 로 확인하세요."
  say "배정된 주소를 서버 설정에 넣기 ($URL)"
  # OAuth issuer 와 Host 검사가 이 주소를 기준으로 동작한다
  gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
    --update-env-vars "MCP_PUBLIC_URL=${URL},MCP_ALLOWED_HOSTS=${URL#https://}" --quiet
fi

cat <<DONE

✓ 배포 완료

  MCP 주소 (커넥터에 넣을 것)
    ${URL}/mcp

  Supabase → Authentication → URL Configuration → Redirect URLs 에 추가
    ${URL}/oauth/callback

  확인
    npm run smoke -- --server ${URL}

DONE
