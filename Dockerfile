FROM node:20-slim

# Dependências do Chrome para o Puppeteer/whatsapp-web.js
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

CMD ["npx", "ts-node", "src/index.ts"]
