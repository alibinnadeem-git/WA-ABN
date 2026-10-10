FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
# Railway mounts /data root-owned at runtime; gosu drops privilege after fixing mount ownership.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Persistent /data is configured as a Railway volume or Docker Compose mount.
# Railway rejects the Dockerfile VOLUME instruction; never declare it here.
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/podium-entrypoint
ENTRYPOINT ["/usr/local/bin/podium-entrypoint"]
CMD ["node", "dist/index.js"]
