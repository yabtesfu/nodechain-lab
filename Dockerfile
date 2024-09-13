# syntax=docker/dockerfile:1

# ---- Stage 1: build the React dashboard ----
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/index.html web/vite.config.js ./
COPY web/src ./src
RUN npm run build

# ---- Stage 2: the node runtime ----
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies for a lean image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source + the built dashboard (served at / when web/dist exists).
COPY src ./src
COPY --from=web /web/dist ./web/dist

EXPOSE 3000
CMD ["node", "src/server.js"]
