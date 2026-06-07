FROM node:20-slim AS builder

RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY apps/server/package*.json ./apps/server/
COPY packages/shared-types/package*.json ./packages/shared-types/

RUN npm install
COPY . .

# Build shared types, web frontend, and server
RUN npm run build -w packages/shared-types
RUN cd apps/web && npm install && npm run build
RUN npx prisma generate --schema=apps/server/prisma/schema.prisma
RUN npm run build -w apps/server

FROM node:20-slim

RUN apt-get update -qq && apt-get install -y -qq openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app .

EXPOSE 10008

CMD ["node", "apps/server/dist/index.js"]
