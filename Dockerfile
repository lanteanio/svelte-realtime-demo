# --- Build stage ---
FROM node:22-trixie-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Production stage ---
FROM node:22-trixie-slim

WORKDIR /app

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "build"]
