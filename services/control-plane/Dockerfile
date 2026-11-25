FROM node:24.22.3-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY services/control-plane/package.json services/control-plane/
RUN pnpm install --frozen-lockfile --filter @iteso/control-plane...
COPY services/control-plane services/control-plane
RUN pnpm --filter @iteso/control-plane build
RUN pnpm --filter @iteso/control-plane deploy --prod --legacy /app/deploy

FROM node:24.22.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/deploy/package.json ./
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/services/control-plane/dist ./dist
COPY --from=builder /app/services/control-plane/drizzle ./drizzle
USER node
EXPOSE 3100
CMD ["node", "dist/main.js"]
