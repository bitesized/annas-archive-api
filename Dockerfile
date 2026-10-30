# Pinned to a patch release: earlier Node 24 builds are vulnerable to
# CVE-2026-111497 (Brotli decoder RCE). Bump deliberately, never below this.
FROM node:24.22.1-alpine

WORKDIR /app

# Install deps first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

USER node

CMD ["npm", "start"]
