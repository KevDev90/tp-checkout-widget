# Trustpilot proxy API for checkout UI extension (server.js)
FROM node:20-alpine

WORKDIR /app

COPY trustpilot-proxy/package.json trustpilot-proxy/package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
