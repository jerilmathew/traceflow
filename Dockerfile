# Public demo image: dashboard + read-only API (public port), with the collector
# and demo services listening only inside the container.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@12.9.1
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm build \
  && pnpm exec tsx scripts/build-public-demo.ts \
  && npm install --omit=dev --no-package-lock --no-audit --no-fund --prefix out

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/out ./
USER node
EXPOSE 8080
CMD ["node", "--max-old-space-size=96", "--max-semi-space-size=1", "scripts/public-demo.js"]
