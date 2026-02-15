# Stage 1: Build - instalo as dependências aqui
FROM node:20-alpine AS builder

WORKDIR /app

# Copio só o package.json primeiro pra aproveitar cache
COPY package*.json ./
RUN npm install --omit=dev

# Stage 2: Imagem final de produção
FROM node:20-alpine AS production

# Crio usuário sem root por segurança
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Trago os node_modules do stage anterior
COPY --from=builder /app/node_modules ./node_modules

# Copio meu código
COPY tracing.js ./
COPY server.js ./

# Rodo como usuário normal
USER appuser

# Variáveis de ambiente
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Healthcheck pro Docker saber se tá vivo
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "-r", "./tracing.js", "server.js"]
