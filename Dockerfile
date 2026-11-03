# One image for every Node service (gateway, facilitator, reconciler, ingest); the start command
# selects the app. Pinned by digest: the base image can only change in a reviewed commit.
FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
RUN corepack enable && apk add --no-cache tini
WORKDIR /app

# Manifests first so the dependency layer is cached across source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/ais/package.json packages/ais/
COPY packages/policy-sdk/package.json packages/policy-sdk/
COPY packages/reconcile/package.json packages/reconcile/
COPY packages/shared/package.json packages/shared/
COPY apps/facilitator/package.json apps/facilitator/
COPY apps/gateway/package.json apps/gateway/
COPY apps/ingest/package.json apps/ingest/
COPY apps/mcp/package.json apps/mcp/
RUN pnpm install --frozen-lockfile --prod=false

COPY packages ./packages
COPY apps ./apps
COPY db ./db

ENV NODE_ENV=production
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@mx/gateway", "start"]
