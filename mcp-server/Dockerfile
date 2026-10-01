# 원격 MCP 서버 이미지. Fly.io / Railway / Cloud Run 등 Docker를 받는 곳 공용.
# (Render 는 Docker 없이 저장소 루트의 render.yaml 로 배포된다)
FROM node:22-alpine

WORKDIR /app

# 의존성 먼저 — 소스만 바뀔 때 이 레이어는 캐시된다
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# 필수: MCP_SESSION_KEY (openssl rand -base64 32)
# 권장: MCP_ALLOWED_HOSTS, MCP_ALLOWED_EMAILS  — SECURITY.md 11항
CMD ["node", "dist/serve.js"]
