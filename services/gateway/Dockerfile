FROM node:24.22.3-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app

FROM base AS builder
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY services/gateway/package.json services/gateway/
RUN pnpm install --frozen-lockfile --filter @iteso/gateway...
COPY services/gateway services/gateway
RUN pnpm --filter @iteso/gateway build
RUN pnpm --filter @iteso/gateway deploy --prod --legacy /app/deploy

FROM node:24.22.3-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/deploy/package.json ./
COPY --from=builder /app/deploy/node_modules ./node_modules
COPY --from=builder /app/services/gateway/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
