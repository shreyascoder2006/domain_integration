# No dependencies to install: the app uses only Node's standard library.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_FILE=/app/data/db.json
COPY package.json ./
COPY lib ./lib
COPY public ./public
COPY server.js ./
# The data directory must be a persistent volume: orders, billing state and encrypted credentials live there.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
