# Public demo image: dashboard + API (public), collector and demo services (container-local).
FROM node:22-bookworm-slim
WORKDIR /app
ENV CI=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@12.9.1
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "scripts/public-demo.ts"]
