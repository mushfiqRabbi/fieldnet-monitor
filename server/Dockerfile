FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY migrations ./migrations
COPY src ./src
COPY test ./test
RUN npm run build
EXPOSE 8000
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
