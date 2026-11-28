FROM node:24.22.3-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/api-client/package.json packages/api-client/
COPY packages/ui/package.json packages/ui/
COPY apps/admin-web/package.json apps/admin-web/
RUN pnpm install --frozen-lockfile --filter @iteso/admin-web...

COPY packages/api-client packages/api-client
COPY packages/ui packages/ui
RUN pnpm --filter @iteso/api-client build && pnpm --filter @iteso/ui build

COPY apps/admin-web apps/admin-web
RUN pnpm --filter @iteso/admin-web build

FROM node:24.22.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME="0.0.0.0"

COPY --from=builder /app/apps/admin-web/.next/standalone ./
COPY --from=builder /app/apps/admin-web/.next/static ./apps/admin-web/.next/static
COPY --from=builder /app/apps/admin-web/public ./apps/admin-web/public

USER node
EXPOSE 3001
CMD ["node", "apps/admin-web/server.js"]
