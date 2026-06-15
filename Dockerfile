# LC Performance Bot — imagen Node
# Node 22: incluye WebSocket global (lo necesita @supabase/supabase-js)
FROM node:22-alpine

WORKDIR /app

# Dependencias primero (mejor cache). Todas las deps son JS puro
# (sql.js es WASM, baileys/qrcode/googleapis son JS) → no hace falta toolchain nativo.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Código de la app
COPY . .

# Datos persistentes (DB, sesión de WhatsApp, token de Google) van a /data (volumen)
ENV DB_PATH=/data/lc_performance.db \
    SESSION_DIR=/data/sessions \
    GOOGLE_TOKEN_PATH=/data/token.json \
    NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
