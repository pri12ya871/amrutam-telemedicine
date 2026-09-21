# syntax=docker/dockerfile:1

# Multi-stage. The build stage carries TypeScript, dev dependencies and source;
# none of that reaches the runtime image, which keeps both the attack surface
# and the pull time down.

FROM node:20-alpine AS build
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of
# source changes — the difference between a 5-second and a 60-second rebuild.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json openapi.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Drop dev dependencies before they are copied into the runtime image.
RUN npm prune --omit=dev


FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Node does not read cgroup memory limits by default, so a container limit is
# invisible to the heap and the process is OOM-killed instead of GCing.
ENV NODE_OPTIONS="--max-old-space-size=384"

# Signal handling: without an init, PID 1 is node and SIGTERM handling during
# `docker stop` is unreliable — which breaks graceful shutdown.
# `apk upgrade` pulls the current security patches for the base image's own
# packages — OpenSSL in particular, which lags in published node:alpine tags.
# Without it the image ships known-fixed CVEs simply because the base tag was
# built before the patch landed.
RUN apk add --no-cache tini \
  && apk upgrade --no-cache --available

# Remove npm from the runtime image.
#
# The container runs `node dist/index.js` and never installs a package, so a
# package manager here is pure attack surface: npm bundles its own copies of
# tar, pacote and sigstore, and their CVEs were the only findings in the image
# scan. Deleting it removes a real (if small) risk and ~15MB, rather than
# suppressing the finding with an ignore file.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# The node image ships an unprivileged `node` user. Running as root inside a
# container is a container-escape amplifier for no benefit.
USER node

EXPOSE 3000

# Readiness is checked by the orchestrator too, but an image-level healthcheck
# means `docker compose up` alone reports honest status.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
