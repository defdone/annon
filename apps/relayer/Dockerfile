# The Annon relayer. Build from the repository root (settings: apps/relayer/README.md):
#   docker build -f apps/relayer/Dockerfile -t annon-relayer .
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/annon/package.json packages/annon/
COPY packages/annon-mcp/package.json packages/annon-mcp/
COPY apps/relayer/package.json apps/relayer/
RUN pnpm install --frozen-lockfile --prod --filter @defdone/annon --filter @defdone/annon-relayer
COPY packages/annon/src packages/annon/src
COPY apps/relayer/*.ts apps/relayer/ts-hook.mjs apps/relayer/
WORKDIR /repo/apps/relayer
ENV NODE_ENV=production NODE_NO_WARNINGS=1
USER node
CMD ["node", "--import", "./ts-hook.mjs", "server.ts"]
