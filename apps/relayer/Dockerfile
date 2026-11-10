# The Annon relayer. Build from the repository root (settings: apps/relayer/README.md):
#   docker build -f apps/relayer/Dockerfile -t annon-relayer .
FROM node:24-slim
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/annon/package.json packages/annon/
COPY apps/relayer/package.json apps/relayer/
RUN pnpm install --frozen-lockfile --prod --filter @defdone/annon --filter @defdone/annon-relayer
COPY packages/annon/src packages/annon/src
COPY apps/relayer/server.ts apps/relayer/ts-hook.mjs apps/relayer/
WORKDIR /repo/apps/relayer
ENV NODE_ENV=production NODE_NO_WARNINGS=1
USER node
CMD ["node", "--import", "./ts-hook.mjs", "server.ts"]
