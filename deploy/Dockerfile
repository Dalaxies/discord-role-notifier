# Only needed if you prefer Docker over the systemd install.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY templates ./templates
COPY web ./web

# The dashboard writes settings and the message file at runtime.
RUN mkdir -p /app/data && chown -R node:node /app/templates /app/data

# node images ship an unprivileged "node" user
USER node

CMD ["node", "src/index.js"]
