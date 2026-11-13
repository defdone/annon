# syntax=docker/dockerfile:1.19
# The Annon demo host. Build from the repository root (settings: apps/demo-host/README.md):
#   docker build -f apps/demo-host/Dockerfile -t annon-demo-host .
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/annon/package.json packages/annon/
COPY packages/annon-mcp/package.json packages/annon-mcp/
COPY apps/relayer/package.json apps/relayer/
COPY apps/demo-host/package.json apps/demo-host/
RUN pnpm install --frozen-lockfile --prod --filter @defdone/annon --filter @defdone/annon-demo-host
COPY --exclude=**/*.test.ts packages/annon/src packages/annon/src
COPY --exclude=**/*.test.ts apps/demo-host/*.ts apps/demo-host/ts-hook.mjs apps/demo-host/
WORKDIR /repo/apps/demo-host
ENV NODE_ENV=production NODE_NO_WARNINGS=1
USER node
CMD ["node", "--import", "./ts-hook.mjs", "server.ts"]
