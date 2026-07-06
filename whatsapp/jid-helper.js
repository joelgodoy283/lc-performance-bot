/**
 * whatsapp/jid-helper — Determina el JID de WhatsApp para enviar un mensaje.
 *
 * Si el contacto es un @lid (identificador interno), no podemos inferir el
 * teléfono real, así que usamos el @lid directamente como destino de envío.
 * Si es un número (con o sin sufijo), armamos el JID estándar.
 */
const TZ = 'America/Argentina/Buenos_Aires';

function recipientJid(contactKey) {
  const raw = String(contactKey || '').trim();
  if (!raw) return null;
  if (/@(s\.whatsapp\.net|c\.us|lid)$/i.test(raw)) return raw;
  return raw + '@s.whatsapp.net';
}

function prettyDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00-03:00');
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

module.exports = { recipientJid, prettyDate };
