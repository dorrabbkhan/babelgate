# Stage 1: build — compile TypeScript, tests excluded via tsconfig.build.json
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
COPY ui ./ui
RUN npm run build

# Stage 2: runtime — production deps only.
# Provider SDKs are devDeps (type-only imports), so npm ci --omit=dev
# skips ~50MB+ of SDK code.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# §3.4: the usage store lives on a volume at /data, writable by node.
ENV USAGE_DB=/data/usage.db
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1
CMD ["node", "dist/index.js"]
