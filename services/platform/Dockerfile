# The platform container. Build from the repository root (compose sets the context):
#   docker build -f services/platform/Dockerfile .
# `turbo prune` keeps only platform and the modules it uses, so a change elsewhere does not rebuild this image.
# Node runs the TypeScript sources directly (type stripping), so there is no compile step.
FROM node:26-slim AS base
RUN npm install --global pnpm@12.4.2 turbo@2.11.13 && npm cache clean --force
WORKDIR /repo

FROM base AS prune
COPY . .
RUN turbo prune platform --docker

FROM base AS install
COPY --from=prune /repo/out/json/ ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=prune /repo/out/full/ ./

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=install --chown=node:node /repo ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "services/platform/src/main.ts"]
