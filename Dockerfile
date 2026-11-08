# Build the web app, then run the API server, which also serves web/dist. ONE image for the local standalone and for the SE deployment
# (owner-approved exception 2026-11-07): the SE manifests in k8s/ run this same image in hosted mode. No MODE and no hosted flag are baked in: Real if it is
# configured, else Mock, and the toggle switches at runtime. Build for the cluster with:
# NOTE: the SE cluster nodes are arm64 (Graviton). Check: kubectl --context <ctx> get nodes -L kubernetes.io/arch
#   docker --context orbstack buildx build --platform linux/arm64 -t ghcr.io/<owner>/pingone-events-lab:<immutable-tag> --load .
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci
COPY web web
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=7802
COPY package.json package-lock.json ./
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
COPY server/diagrams server/diagrams
COPY docs/elasticsearch-index-template.json docs/elasticsearch-index-template.json
COPY --from=build /app/web/dist web/dist
# The event store lives here (the compose file mounts a named volume; the SE manifests mount a volume claim). Owned by the unprivileged user.
# Files copied from a build context keep that machine's modes (git does not record them): make everything readable by the unprivileged user.
RUN chmod -R a+rX /app && mkdir -p /data && chown node:node /data
ENV PEV_DATA_DIR=/data
USER node
EXPOSE 7802
# Inside the container the server must listen on all interfaces, so PEV_BIND is set here on purpose.
# The compose file publishes the port on 127.0.0.1 only; do not publish it more widely.
ENV PEV_BIND=0.0.0.0
CMD ["node", "server/src/index.js"]
