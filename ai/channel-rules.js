const ROSARIO_WHATSAPP_PREFIX = '549341';

function normalizePhone(value) {
  if (!value) return '';
  return String(value).replace(/^ig:/, '').replace(/\D/g, '');
}

function isInstagramChannel(channelPhone) {
  return String(channelPhone || '').startsWith('ig:');
}

function isRosarioPhone(phone) {
  return normalizePhone(phone).startsWith(ROSARIO_WHATSAPP_PREFIX);
}

function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectRosarioConfirmation(text) {
  const t = stripAccents(text).toLowerCase();
  if (!t.trim()) return false;

  const positivePatterns = [
    /\bsi\b.*\b(rosario|voy|puedo|acerco|acercarme|acercar|ir|llevar|queda|sirve)\b/,
    /\b(rosario)\b.*\b(vivo|estoy|soy|puedo|voy|acerco|queda|sirve)\b/,
    /\b(vivo|estoy|soy)\s+en\s+rosario\b/,
    /\b(me\s+)?(puedo\s+)?acerc(o|arme)\b/,
    /\bpuedo\s+(ir|llevarlo|llevar|acercarme)\b/,
    /\bme\s+(queda\s+bien|sirve)\b/,
    /\bvoy\s+(a\s+ir|para|hasta)?\s*(rosario|al\s+taller)?\b/,
    /\bno\s+hay\s+problema\b/,
    /\bperfecto\b.*\b(rosario|voy|puedo|acerco|sirve)\b/,
  ];

  return positivePatterns.some((re) => re.test(t));
}

function appointmentPhone({ channelPhone, providedPhone }) {
  const provided = normalizePhone(providedPhone);
  if (provided) return provided;
  if (isInstagramChannel(channelPhone)) return '';
  return normalizePhone(channelPhone);
}

function validateAppointmentChannelRules({ channelPhone, providedPhone, rosarioLocationConfirmed = false }) {
  const finalPhone = appointmentPhone({ channelPhone, providedPhone });

  if (isInstagramChannel(channelPhone) && !finalPhone) {
    return {
      ok: false,
      code: 'missing_whatsapp_phone_for_instagram',
      message: 'Antes de agendar desde Instagram, pedile al cliente su número de WhatsApp para poder enviarle el recordatorio del turno.',
    };
  }

  if (finalPhone && !isRosarioPhone(finalPhone) && !rosarioLocationConfirmed) {
    return {
      ok: false,
      code: 'missing_rosario_location_confirmation',
      message: 'Antes de agendar, avisale que LC Performance está en Rosario, Santa Fe, y confirmá si puede acercarse o si está en Rosario aunque tenga característica de otra ciudad. Si confirma, recién ahí agendá.',
    };
  }

  return { ok: true, phone: finalPhone };
}

function buildChannelRulesPrompt({ channelPhone, businessAddress = '', rosarioLocationConfirmed = false } = {}) {
  const isIg = isInstagramChannel(channelPhone);
  const phone = normalizePhone(channelPhone);
  const hasRosarioPrefix = phone && isRosarioPhone(phone);
  const addressLine = businessAddress ? ` Dirección: ${businessAddress}.` : '';

  let prompt = `REGLAS CRÍTICAS DE CANAL Y UBICACIÓN:
- LC Performance está en Rosario, Santa Fe.${addressLine}
- En el PRIMER mensaje de bienvenida, mencioná siempre que el taller está en Rosario, Santa Fe${businessAddress ? ' y la dirección' : ''}, sin cambiar el nombre/persona del asistente definido en el prompt oficial del panel.
- No pidas teléfono cuando el cliente escribe por WhatsApp: ya se conoce por el canal.
- Si el cliente escribe por Instagram, antes de crear un turno pedile su número de WhatsApp para poder mandarle el recordatorio 24 hs antes.
- La característica de Rosario para WhatsApp Argentina es ${ROSARIO_WHATSAPP_PREFIX}... . Usala solo como señal de duda, NO como bloqueo.
- Si el número del cliente no empieza con ${ROSARIO_WHATSAPP_PREFIX}, avisale una sola vez que el taller está en Rosario, Santa Fe, y preguntale si puede acercarse o si está en Rosario aunque tenga número de otra ciudad.
- Si el cliente confirma que vive/está en Rosario o que puede acercarse al taller, continuá normalmente y NO vuelvas a preguntarlo en esta conversación.`;

  if (isIg) {
    prompt += '\n\nCONTEXTO DEL CANAL: Este cliente viene de Instagram. No tenés su WhatsApp real todavía salvo que lo haya escrito en la conversación. No crees turnos sin pedirlo.';
  } else if (phone && !hasRosarioPrefix && !rosarioLocationConfirmed) {
    prompt += '\n\nCONTEXTO DE UBICACIÓN: El número de WhatsApp no tiene característica de Rosario. Antes de confirmar/agendar turno, recordá que el taller está en Rosario y pedí confirmación de que puede acercarse o está en Rosario. Hacelo de forma natural, no invasiva.';
  } else if (rosarioLocationConfirmed) {
    prompt += '\n\nCONTEXTO DE UBICACIÓN: El cliente ya confirmó que está en Rosario o puede acercarse. No vuelvas a preguntarlo; seguí con el flujo normal.';
  }

  return prompt;
}

module.exports = {
  ROSARIO_WHATSAPP_PREFIX,
  normalizePhone,
  isInstagramChannel,
  isRosarioPhone,
  detectRosarioConfirmation,
  appointmentPhone,
  validateAppointmentChannelRules,
  buildChannelRulesPrompt,
};
