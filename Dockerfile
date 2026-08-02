# Troop Check-In — container image.
#
# Build:   docker build -t troop-checkin .
# Multi-arch (amd64 for PCs/NAS, arm64 for Pi 4/5 running 64-bit OS):
#   docker buildx build --platform linux/amd64,linux/arm64 -t troop-checkin .
# Run:     see docker-compose.yml (recommended) or:
#   docker run -d -p 3000:3000 -v tc-data:/app/data -v tc-config:/app/config troop-checkin
# then open http://<host>:3000 — the first-run /setup wizard does the rest.
#
# better-sqlite3 ships prebuilt binaries for linux amd64/arm64, so no
# compiler toolchain is needed in the image.
FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# dependency layer (cached until package*.json changes)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
COPY LICENSE README.md .env.example ./

# All state on two mounted volumes:
#   /app/data   — database, signatures, backups (the PII; this is what you back up)
#   /app/config — the .env the /setup wizard writes (kept OUT of /app/data on
#                 purpose: data-volume backups then contain only ciphertext,
#                 never the CRED_KEY that decrypts stored credentials)
ENV DATA_DIR=/app/data \
    ENV_FILE=/app/config/.env \
    PORT=3000
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config
VOLUME ["/app/data", "/app/config"]

USER node
EXPOSE 3000

# migrations are idempotent — safe on every start, keeps upgrades to
# "pull new image, restart"
CMD ["sh", "-c", "node server/migrate.js && node server/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
