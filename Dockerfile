# ghost-mcp-secure — container image for the REMOTE (HTTP + OAuth) server.
# Designed for Google Cloud Run (reads $PORT, scales to zero). No build step.
FROM node:22-alpine

WORKDIR /app

# Install only the pinned production deps (reproducible via package-lock.json).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Application source (no build — what you read is what runs).
COPY src ./src

ENV NODE_ENV=production
# Cloud Run overrides PORT at runtime; 8080 is the default it injects.
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "src/http-server.js"]
