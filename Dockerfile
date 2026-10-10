# One Record: a single Node process serving the API and the static pages.
# node:sqlite is built into Node 22, so there is nothing native to compile.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# install first so this layer is cached until the dependencies change
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY src ./src
COPY public ./public
COPY data/bundles ./data/bundles

# The SQLite file lives in /app/data. On first start it is created and filled from data/bundles.
# Anything written at runtime (share codes, access log, added records) is lost when the container is
# replaced unless /app/data is a mounted volume (or DB_PATH points at one).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/demo').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "server/index.js"]
