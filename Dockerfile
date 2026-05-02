# Stage 1: Build
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-slim
WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/package.json /app/package-lock.json ./

# Install only external optional deps (ink, react, cheerio are not bundled by esbuild)
RUN npm install --omit=dev --ignore-scripts --no-optional

# Non-root user
RUN chown -R agent:agent /app
RUN useradd -m agent
USER agent

ENTRYPOINT ["node", "dist/cli/main.js"]
