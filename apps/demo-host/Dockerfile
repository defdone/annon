# The Annon demo host. Build from the repository root (settings: apps/demo-host/README.md):
#   docker build -f apps/demo-host/Dockerfile -t annon-demo-host .
FROM node:24-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/annon/package.json packages/annon/
COPY packages/annon-mcp/package.json packages/annon-mcp/
COPY apps/relayer/package.json apps/relayer/
COPY apps/demo-host/package.json apps/demo-host/
RUN pnpm install --frozen-lockfile --prod --filter @defdone/annon --filter @defdone/annon-demo-host
COPY packages/annon/src packages/annon/src
COPY apps/demo-host/server.ts apps/demo-host/ts-hook.mjs apps/demo-host/
WORKDIR /repo/apps/demo-host
ENV NODE_ENV=production NODE_NO_WARNINGS=1
USER node
CMD ["node", "--import", "./ts-hook.mjs", "server.ts"]
