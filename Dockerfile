# One image for all Node services; the command selects the app.
FROM node:22-alpine
RUN corepack enable && apk add --no-cache tini
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY db ./db
RUN pnpm install --frozen-lockfile --prod=false
ENV NODE_ENV=production
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["pnpm", "--filter", "@mx/gateway", "start"]
