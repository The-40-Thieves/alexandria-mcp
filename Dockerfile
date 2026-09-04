# Minimal image for the docker/mcp-registry submission (servers/alexandria).
# Docker builds this from the pinned commit at the repo root, so this file
# must be committed as `Dockerfile` before the registry PR is opened.
# Runtime deps are pure JS; SQLite comes from node:sqlite (built in), so
# node:24-alpine needs no build toolchain.
FROM node:24-alpine

WORKDIR /app

# Install with dev deps (typescript is needed for the build), build, then
# drop the dev deps so the final layer ships only runtime packages.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY docs ./docs
COPY README.md LICENSE CHANGELOG.md ./
RUN npm run build && npm prune --omit=dev

# data/ holds the quota ledger, result cache, and undici http-cache SQLite
# files; the server falls back to in-memory stores if it cannot create them.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    TRANSPORT=stdio

CMD ["node", "dist/index.js"]
