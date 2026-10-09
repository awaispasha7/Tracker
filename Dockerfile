# The app has no runtime dependencies: Node runs the TypeScript sources directly (type stripping,
# Node >= 22.18) and uses the built-in node:sqlite. So the image is just Node plus our files.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    DB_PATH=/data/emptylegs.db

COPY package.json ./
COPY src ./src
COPY public ./public

# Railway (and most hosts) set PORT; the server listens on it.
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]
