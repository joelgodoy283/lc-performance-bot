# LC Performance — Bot de WhatsApp + Dashboard

Chatbot de WhatsApp con IA para el taller mecánico **LC Performance**, con panel de control web.

## Stack
- **Node.js + Express + Socket.io** — backend y tiempo real
- **sql.js** — SQLite puro JS (sin compilación nativa)
- **@whiskeysockets/baileys** — conexión a WhatsApp (QR)
- **OpenRouter** — IA con tool-calling
- **Google Calendar API** — agenda de turnos
- **node-cron** — resumen diario automático (19:00 ART)
- **EJS + CSS/JS puro** — dashboard

## Funcionalidades del panel
- 📱 Conexión WhatsApp / 📸 Instagram (QR + estado)
- 💬 Chat en vivo (intervenir como humano, pausar el bot por contacto)
- 🛠️ **Servicios** — tabla (Nombre, Descripción, Monto, Detalles) que la IA usa para responder precios
- 🚫 **Excepciones** — números que el bot ignora por completo (no responde ni registra)
- 🤖 **Configurar IA** — system prompt editable + resumen diario automático
- 📅 **Turnos** — Google Calendar

---

## Puesta en marcha local

```bash
npm install
cp .env.example .env   # completá las variables
npm start              # http://localhost:3000
```

Variables en `.env` (ver `.env.example`):
- `OPENROUTER_API_KEY`, `DASHBOARD_PASSWORD`, `SESSION_SECRET`
- Google Calendar: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (+ `node calendar/authorize.js`)

---

## Deploy en VPS (Ubuntu/Debian)

```bash
# 1. Node 18+ (ejemplo con nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20

# 2. Clonar el repo
git clone git@github.com:USUARIO/lc-performance-bot.git
cd lc-performance-bot

# 3. Dependencias y configuración
npm install
cp .env.example .env
nano .env                      # completar claves

# 4. Mantenerlo vivo con PM2
npm install -g pm2
pm2 start server.js --name lc-bot
pm2 save
pm2 startup                    # seguir la instrucción que imprime
```

### QR de WhatsApp en el VPS
El QR se muestra en el **dashboard web**, no en la terminal. Accedé a
`http://IP_DEL_VPS:3000` (o detrás de Nginx con dominio) y escaneá desde
**WhatsApp → Dispositivos vinculados**.

### Reverse proxy (opcional, recomendado)
Poné Nginx delante para servir en el puerto 80/443 con tu dominio y HTTPS
(Let's Encrypt / certbot). El bot escucha en `PORT` (default 3000).

### Datos persistentes
`lc_performance.db` (servicios, chats, excepciones, config) y `sessions/`
(sesión de WhatsApp) se generan en el servidor y **no** están en el repo.
Hacé backup de ambos periódicamente.

---

## Notas
- Nunca se commitean secretos: `.env`, `*.db`, `sessions/`, `token.json`,
  `credentials.json` están en `.gitignore`.
- El resumen diario se envía al número configurado en *Configurar IA* a las
  19:00 hora Argentina. El destino debe ser **distinto** al número del bot.
