# Hosted CraftStory MCP server (Streamable HTTP + OAuth). Build context: this repo.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8788
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8788/healthz || exit 1
CMD ["node", "dist/http.js"]
