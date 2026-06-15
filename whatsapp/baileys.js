const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  isJidBroadcast,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { saveMessage, isPaused, pauseContact, isBlocked } = require('../database/db');
const { processMessage } = require('../ai/openrouter');

const SESSION_DIR = path.join(__dirname, '..', 'sessions');

// Frases que activan el handoff a humano
const HUMAN_TRIGGERS = [
  'hablar con lucas', 'quiero un humano', 'humano', 'persona real',
  'hablar con una persona', 'atencion humana', 'atención humana',
  'agente', 'hablar con alguien', 'no quiero el bot',
];

let sock = null;
let connectionState = { status: 'disconnected', qr: null };
let reconnectTimeout = null;

function getConnectionState() {
  return connectionState;
}

async function startWhatsApp() {
  clearTimeout(reconnectTimeout);

  const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[WA] Usando Baileys v${version.join('.')} | ¿Última versión? ${isLatest}`);

  // Logger silencioso (solo errores) para no ensuciar la consola
  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false, // Lo mandamos al dashboard via Socket.io
    browser: ['LC Performance Bot', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  // ─── Credenciales ───────────────────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ─── Estado de conexión ─────────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR generado, enviando al Dashboard...');
      try {
        const qrDataUrl = await qrcode.toDataURL(qr, { width: 300 });
        connectionState = { status: 'qr', qr: qrDataUrl };
        global.io?.emit('whatsapp:qr', qrDataUrl);
        global.io?.emit('whatsapp:status', connectionState);
      } catch (err) {
        console.error('[WA] Error generando QR:', err.message);
      }
    }

    if (connection === 'open') {
      console.log('[WA] ✅ Conectado a WhatsApp');
      connectionState = { status: 'connected', qr: null };
      global.io?.emit('whatsapp:status', connectionState);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`[WA] Conexión cerrada. Razón: ${reason}`);

      connectionState = { status: 'disconnected', qr: null };
      global.io?.emit('whatsapp:status', connectionState);

      // Lógica de reconexión
      const shouldReconnect =
        reason !== DisconnectReason.loggedOut &&
        reason !== DisconnectReason.forbidden;

      if (shouldReconnect) {
        const delay = reason === DisconnectReason.connectionReplaced ? 10000 : 5000;
        console.log(`[WA] Reconectando en ${delay / 1000}s...`);
        reconnectTimeout = setTimeout(startWhatsApp, delay);
      } else {
        console.log('[WA] Sesión cerrada por el usuario o prohibida. Borrando sesión...');
        // Si el usuario cerró sesión desde el teléfono, limpiar credenciales
        const fs = require('fs');
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          fs.mkdirSync(SESSION_DIR);
        }
        reconnectTimeout = setTimeout(startWhatsApp, 3000);
      }
    }
  });

  // ─── Mensajes entrantes ─────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Ignorar mensajes propios, de grupos y broadcasts
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.endsWith('@g.us')) continue;
      if (isJidBroadcast(msg.key.remoteJid)) continue;

      const phone = msg.key.remoteJid;

      // Excepciones: números personales que deben ignorarse por completo
      // (no se guardan, no aparecen en el panel y no se responden).
      if (isBlocked(phone)) {
        console.log(`[WA] Número en excepciones, ignorando: ${phone}`);
        continue;
      }

      const text  = extractTextFromMessage(msg);

      if (!text) continue;

      console.log(`[WA] Mensaje de ${phone}: "${text.substring(0, 80)}"`);

      // Guardar en DB y emitir al dashboard
      saveMessage(phone, 'incoming', text);
      global.io?.emit('chat:new_message', { phone, direction: 'incoming', content: text, timestamp: new Date().toISOString() });

      // Verificar si es un trigger de handoff humano
      const textNormalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const isHumanRequest = HUMAN_TRIGGERS.some(t => textNormalized.includes(t));

      if (isHumanRequest) {
        pauseContact(phone);
        const pauseMsg = '🤝 Entendido, voy a avisarle a Lucas para que te atienda personalmente. Por favor esperá unos minutos.';
        await sendMessage(phone, pauseMsg);
        global.io?.emit('chat:paused', { phone, reason: 'human_request' });
        global.io?.emit('notification', { type: 'handoff', phone, message: `El cliente ${phone} pidió atención humana.` });
        continue;
      }

      // Si el bot está pausado para este número, no responder
      if (isPaused(phone)) {
        console.log(`[WA] Bot pausado para ${phone}, ignorando mensaje`);
        continue;
      }

      // Indicador de "escribiendo..."
      await sock.sendPresenceUpdate('composing', phone);

      // Procesar con IA
      try {
        const reply = await processMessage(phone, text);
        await sendMessage(phone, reply);
      } catch (err) {
        console.error('[WA] Error procesando mensaje con IA:', err.message);
        await sendMessage(phone, 'Lo siento, tuve un error técnico. Por favor escribí "hablar con Lucas" para atención directa.');
      } finally {
        await sock.sendPresenceUpdate('paused', phone);
      }
    }
  });
}

/**
 * Envía un mensaje de texto y lo guarda en la DB
 */
async function sendMessage(phone, text) {
  if (!sock) throw new Error('WhatsApp no está conectado');

  try {
    await sock.sendMessage(phone, { text });
    saveMessage(phone, 'outgoing', text);
    global.io?.emit('chat:new_message', {
      phone,
      direction: 'outgoing',
      content: text,
      timestamp: new Date().toISOString(),
    });
    console.log(`[WA] Enviado a ${phone}: "${text.substring(0, 60)}..."`);
  } catch (err) {
    console.error(`[WA] Error enviando mensaje a ${phone}:`, err.message);
    throw err;
  }
}

/**
 * Extrae texto de los distintos tipos de mensaje de Baileys
 */
function extractTextFromMessage(msg) {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    null
  );
}

module.exports = { startWhatsApp, sendMessage, getConnectionState };
