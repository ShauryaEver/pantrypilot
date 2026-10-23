# Multi-stage build: small, non-root runtime image for Cloud Run.
FROM node:22-slim AS deps
WORKDIR /app
COPY package*.json ./
# Falls back to npm install if package-lock.json is out of sync with package.json
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
