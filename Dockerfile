# --- Build stage ---
# node:22-trixie-slim pinned by digest. Tags are mutable; pinning ensures
# reproducible builds and prevents a surprise base-image swap landing in a
# subsequent rebuild. Bump the digest manually when the operator decides to
# pull in upstream security fixes (the existing `docker compose build` does
# not auto-resolve to newer image versions once pinned).
FROM node:22-trixie-slim@sha256:19e006436508fe491c9f9f0e673b3bf9a68a6946b5d273088c1dc207574ae4ed AS build

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# vite build + SvelteKit's analyze step imports src/live/demos/news.js at
# module-load time. That file fail-closes on `NODE_ENV=production` when
# DEMO_NEWS_WEBHOOK_SECRET is unset (the legacy static fallback was a
# repo-checked string, so production refuses to start with it). The ARG
# carries the build-stub value from docker-compose.yml so the analyze
# import does not throw; the real runtime value lands via the compose
# `environment:` block and replaces the stub on every fresh container
# start.
ARG DEMO_NEWS_WEBHOOK_SECRET
ENV DEMO_NEWS_WEBHOOK_SECRET=$DEMO_NEWS_WEBHOOK_SECRET
RUN npm run build

# --- Production stage ---
# Same digest as the build stage. Bump in lockstep.
FROM node:22-trixie-slim@sha256:19e006436508fe491c9f9f0e673b3bf9a68a6946b5d273088c1dc207574ae4ed

# gosu lets the entrypoint drop from root to the `node` user after the
# cert-copy step. The official node image already ships a `node` UID 1000.
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ONLY production dependencies in the runtime image. The build stage
# uses devDeps (vite, svelte-check, playwright, etc.) - none of which are
# needed at runtime and all of which inflate the image size + attack surface.
# `npm ci --omit=dev` reads the same package-lock.json so versions are pinned
# identically to the build stage. Slight cost: a second npm install during
# rebuilds; offset by a meaningfully smaller image and zero devDeps shipped.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# Non-privileged port; docker-compose maps the host's 443 here.
ENV PORT=3443
EXPOSE 3443

# Runs as root initially so entrypoint.sh can copy the letsencrypt privkey
# (mode 0600 root) into a node-readable location, then `exec gosu node` to
# drop privileges before running the app.
ENTRYPOINT ["./entrypoint.sh"]
