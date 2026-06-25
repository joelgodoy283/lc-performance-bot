/**
 * ai/assistant.js — Modo asistente de Lucas.
 *
 * Cuando un mensaje llega del número de Lucas (config `lucas_number`), en vez de
 * atenderlo como cliente se lo procesa acá: prompt y herramientas distintas para
 * gestionar la agenda (consultar/crear/cancelar/reagendar turnos, ver contactos
 * del día, marcar cuándo queda listo un auto).
 */
const {
  getConfig, getConversationState, saveConversationState,
  getAppointmentById, getAppointmentsBetween, getMessagesBetween,
  updateAppointment, normalizePhone,
} = require('../database/db');
const cal = require('../calendar');
const local = require('../calendar/local-calendar');
const { callOpenRouter, currentDateLine } = require('./openrouter');

const TZ = 'America/Argentina/Buenos_Aires';
const MAX_HISTORY_MESSAGES = 20;

// ─── Prompt ──────────────────────────────────────────────────────────────────

function buildAssistantPrompt() {
  const base = getConfig('assistant_prompt') || 'Sos el asistente personal de Lucas, dueño de LC Performance.';
  const { texto, iso } = currentDateLine();
  return `${base}

FECHA Y HORA ACTUAL:
Hoy es ${texto}. En ISO: ${iso}. Usá SIEMPRE esta fecha para interpretar "hoy", "mañana", "el viernes", etc., y pasá las fechas a las herramientas en formato YYYY-MM-DD.`;
}

// ─── Herramientas del asistente ───────────────────────────────────────────────

const ASSISTANT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_appointments',
      description: 'Lista los turnos de un día (o un rango de días). Si no se pasa fecha, usa hoy. Devolvé los ids para poder operar después.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día a consultar YYYY-MM-DD. Si se omite, hoy.' },
          date_to: { type: 'string', description: 'Opcional: fin del rango YYYY-MM-DD para listar varios días.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_day_contacts',
      description: 'Lista los contactos/clientes que escribieron al taller por WhatsApp en un día, con su conversación, para que puedas resumirle a Lucas quiénes fueron y qué pidieron. Si no se pasa fecha, usa hoy.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Día YYYY-MM-DD. Si se omite, hoy.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela un turno por su id. Por defecto le avisa al cliente y le ofrece otra fecha con prioridad. Confirmá con Lucas antes de usarla.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number', description: 'Id del turno (obtenido de list_appointments).' },
          reason: { type: 'string', description: 'Motivo opcional, se incluye en el aviso al cliente.' },
          notify_client: { type: 'boolean', description: 'Si avisar al cliente. Default true.' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_appointment_manual',
      description: 'Crea un turno manualmente (cuando Lucas coordina por otro medio). Necesita el teléfono del cliente.',
      parameters: {
        type: 'object',
        properties: {
          client_name: { type: 'string' },
          client_phone: { type: 'string', description: 'Número de WhatsApp del cliente (con código de país).' },
          car_info: { type: 'string', description: 'Marca, modelo, año y/o problema.' },
          service: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: 'string', description: 'HH:MM (horario de entrega).' },
        },
        required: ['client_name', 'client_phone', 'date', 'start_time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reagenda un turno existente a otra fecha y/u hora. Por defecto le avisa al cliente.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          new_date: { type: 'string', description: 'YYYY-MM-DD' },
          new_time: { type: 'string', description: 'HH:MM (opcional, mantiene la anterior si no se pasa).' },
          notify_client: { type: 'boolean', description: 'Si avisar al cliente. Default true.' },
        },
        required: ['appointment_id', 'new_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_ready_date',
      description: 'Registra/ajusta el día en que un vehículo va a estar listo (ej: "el auto de Fulano está para el viernes"). Sirve para coordinar el aviso de retiro y el pedido de reseña.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          ready_date: { type: 'string', description: 'YYYY-MM-DD en que el auto queda listo.' },
        },
        required: ['appointment_id', 'ready_date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_attendance',
      description: 'Marca si un cliente asistió o no a su turno (lo usás cuando Lucas te confirma quién vino). Si no asistió, libera el cupo.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          attended: { type: 'boolean', description: 'true si vino, false si no se presentó.' },
        },
        required: ['appointment_id', 'attended'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_estimated_finish',
      description: 'Carga la hora estimada en que un vehículo va a estar listo HOY (la que dice Lucas). A esa hora se le va a preguntar a Lucas si terminó.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          time: { type: 'string', description: 'Hora estimada de finalización HH:MM (24h).' },
        },
        required: ['appointment_id', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_finished',
      description: 'Marca un vehículo como TERMINADO cuando Lucas lo confirma. Le avisa automáticamente al cliente que puede pasar a retirarlo. Usala SIEMPRE que Lucas confirme que terminó un auto.',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
        },
        required: ['appointment_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_reschedule_to_client',
      description: 'Le escribe al cliente ofreciéndole los próximos cupos con prioridad para reagendar (ej: tras una inasistencia, si Lucas te lo pide).',
      parameters: {
        type: 'object',
        properties: {
          appointment_id: { type: 'number' },
          reason: { type: 'string', description: 'Motivo opcional para el mensaje.' },
        },
        required: ['appointment_id'],
      },
    },
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function prettyDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00-03:00`);
  return new Intl.DateTimeFormat('es-AR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric' }).format(d);
}

function fmtAppt(a) {
  return {
    id: a.id, date: a.date, time: a.time, status: a.status,
    client_name: a.client_name, car_info: a.car_info, service: a.service,
    estimated_finish: a.estimated_finish || null, ready_date: a.ready_date || null,
    phone: a.client_phone,
  };
}

function slotOptionsText(options) {
  if (!options.length) return 'En los próximos días no tengo cupos libres; te contacto cuando se libere uno.';
  return options.map((o) => `• ${prettyDate(o.date)}: ${o.slots.join(', ')} hs`).join('\n');
}

/** Envía un mensaje a un cliente (lazy-require de baileys para evitar ciclos). */
async function sendToClient(phoneDigits, text) {
  const num = normalizePhone(phoneDigits);
  if (!num) return false;
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    console.warn('[ASSISTANT] WhatsApp no conectado; no se pudo escribir al cliente.');
    return false;
  }
  try {
    await sendMessage(`${num}@s.whatsapp.net`, text);
    return true;
  } catch (err) {
    console.error('[ASSISTANT] Error escribiendo al cliente:', err.message);
    return false;
  }
}

/** Mensaje al cliente ofreciéndole reagendar con prioridad. */
function priorityOfferText(appt, reason) {
  const options = local.nextAvailableSlots(3);
  const reasonTxt = reason ? ` (${reason})` : '';
  return (
    `Hola${appt.client_name ? ' ' + appt.client_name : ''}, te escribimos de *LC Performance*.${reasonTxt ? reasonTxt : ''} ` +
    `Queremos reagendar tu turno y te damos *prioridad*. Tenemos lugar:\n${slotOptionsText(options)}\n\n` +
    `¿Cuál te queda cómodo? Respondé y te lo agendo.`
  );
}

/** Mensaje al cliente avisando que el vehículo está listo para retirar. */
function pickupText(appt) {
  return (
    `✅ ¡Hola${appt.client_name ? ' ' + appt.client_name : ''}! Te escribimos de *LC Performance*: ` +
    `tu ${appt.car_info || 'vehículo'} ya está listo. Podés pasar a retirarlo por Bv. Seguí 2122 (Rosario) ` +
    `en nuestro horario de atención. ¡Gracias por confiar en nosotros! 🔧`
  );
}

/**
 * Envía un mensaje proactivo a Lucas y lo deja en el historial de su asistente,
 * para que cuando responda, el modelo tenga el contexto de lo que se le preguntó.
 */
async function sendToLucasAndRemember(text) {
  const num = normalizePhone(getConfig('lucas_number'));
  if (!num) return false;
  const jid = `${num}@s.whatsapp.net`;
  const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
  if (getConnectionState().status !== 'connected') {
    console.warn('[ASSISTANT] WhatsApp no conectado; no se pudo escribir a Lucas.');
    return false;
  }
  try {
    await sendMessage(jid, text);
    const state = getConversationState(jid);
    const history = [...state.history, { role: 'assistant', content: text }].slice(-MAX_HISTORY_MESSAGES);
    saveConversationState(jid, history, state.step, state.car_info, false);
    return true;
  } catch (err) {
    console.error('[ASSISTANT] Error escribiendo a Lucas:', err.message);
    return false;
  }
}

// ─── Ejecutor de herramientas ─────────────────────────────────────────────────

async function executeAssistantTool(toolName, args) {
  try {
    if (toolName === 'list_appointments') {
      const from = args.date || local.todayAR();
      const to = args.date_to || from;
      const appts = getAppointmentsBetween(from, to);
      return JSON.stringify({ from, to, count: appts.length, appointments: appts.map(fmtAppt) });
    }

    if (toolName === 'list_day_contacts') {
      const date = args.date || local.todayAR();
      const startUTC = new Date(`${date}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const endUTC = new Date(`${local.addDays(date, 1)}T00:00:00-03:00`).toISOString().slice(0, 19).replace('T', ' ');
      const msgs = getMessagesBetween(startUTC, endUTC);
      const byPhone = new Map();
      for (const m of msgs) {
        const num = normalizePhone(m.phone);
        if (!byPhone.has(num)) byPhone.set(num, []);
        byPhone.get(num).push({ dir: m.direction, content: m.content });
      }
      const contacts = [...byPhone.entries()].map(([phone, list]) => ({
        phone,
        total: list.length,
        incoming: list.filter((x) => x.dir === 'incoming').length,
        messages: list.slice(-12), // últimas para resumir
      }));
      return JSON.stringify({ date, contacts_count: contacts.length, contacts }).slice(0, 7000);
    }

    if (toolName === 'cancel_appointment') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      if (appt.status === 'cancelled') return JSON.stringify({ success: false, error: 'Ese turno ya estaba cancelado.' });

      const res = await cal.cancelAppointment(args.appointment_id);
      if (!res.success) return JSON.stringify(res);

      let clientNotified = false;
      if (args.notify_client !== false) {
        const options = local.nextAvailableSlots(3);
        const reasonTxt = args.reason ? ` (${args.reason})` : '';
        const msg =
          `Hola${appt.client_name ? ' ' + appt.client_name : ''}, te escribimos de *LC Performance*. ` +
          `Tuvimos que cancelar tu turno del ${prettyDate(appt.date)}${appt.time ? ' a las ' + appt.time + ' hs' : ''}${reasonTxt}. ` +
          `Disculpá las molestias 🙏\n\nTe damos *prioridad* para reagendarlo. Tenemos lugar:\n${slotOptionsText(options)}\n\n` +
          `¿Cuál te queda cómodo? Respondé y te lo agendo.`;
        clientNotified = await sendToClient(appt.client_phone, msg);
      }
      return JSON.stringify({
        success: true, cancelled_id: appt.id, client_notified: clientNotified,
        message: `Turno de ${appt.client_name || appt.client_phone} (${appt.date}) cancelado.${clientNotified ? ' Le avisé al cliente y le ofrecí reagendar con prioridad.' : ''}`,
      });
    }

    if (toolName === 'create_appointment_manual') {
      const res = await cal.createAppointment({
        client_name: args.client_name, client_phone: args.client_phone,
        car_info: args.car_info, service: args.service,
        date: args.date, start_time: args.start_time,
        notifyOwner: false, // lo está creando el propio Lucas
      });
      return JSON.stringify(res);
    }

    if (toolName === 'reschedule_appointment') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const res = await cal.rescheduleAppointment(args.appointment_id, args.new_date, args.new_time);
      if (!res.success) return JSON.stringify(res);

      let clientNotified = false;
      if (args.notify_client !== false) {
        const a = res.appointment;
        const msg =
          `Hola${a.client_name ? ' ' + a.client_name : ''}, te escribimos de *LC Performance*. ` +
          `Reprogramamos tu turno para el ${prettyDate(a.date)}${a.time ? ' a las ' + a.time + ' hs' : ''}. ` +
          `Si no te queda bien, avisanos y lo reacomodamos. ¡Gracias!`;
        clientNotified = await sendToClient(a.client_phone, msg);
      }
      return JSON.stringify({ success: true, appointment: fmtAppt(res.appointment), client_notified: clientNotified });
    }

    if (toolName === 'set_ready_date') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, { ready_date: args.ready_date });
      return JSON.stringify({
        success: true,
        message: `Anotado: el ${appt.car_info || 'vehículo'} de ${appt.client_name || appt.client_phone} queda listo el ${args.ready_date}.`,
      });
    }

    if (toolName === 'set_attendance') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const who = appt.client_name || appt.client_phone;
      if (args.attended === false) {
        updateAppointment(args.appointment_id, { status: 'no_show' });
        return JSON.stringify({
          success: true, status: 'no_show',
          message: `Marqué que ${who} no asistió y liberé el cupo. ¿Querés que le escriba para reagendar con prioridad?`,
        });
      }
      updateAppointment(args.appointment_id, { status: 'attended' });
      return JSON.stringify({ success: true, status: 'attended', message: `Anotado: ${who} asistió.` });
    }

    if (toolName === 'set_estimated_finish') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, { estimated_finish: args.time, status: 'in_progress', finish_check_sent: 0 });
      return JSON.stringify({
        success: true,
        message: `Listo, ${appt.car_info || 'el vehículo'} de ${appt.client_name || appt.client_phone} estimado para las ${args.time}. Te aviso a esa hora para confirmar.`,
      });
    }

    if (toolName === 'mark_finished') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      updateAppointment(args.appointment_id, {
        status: 'finished',
        finished_at: new Date().toISOString(),
        ready_date: appt.ready_date || local.todayAR(),
      });
      const notified = await sendToClient(appt.client_phone, pickupText(appt));
      updateAppointment(args.appointment_id, { pickup_notified: notified ? 1 : 0 });
      return JSON.stringify({
        success: true, client_notified: notified,
        message: `Marqué terminado el ${appt.car_info || 'vehículo'} de ${appt.client_name || appt.client_phone}.` +
          (notified ? ' Le avisé al cliente que puede pasar a retirarlo.' : ' (No pude avisar al cliente: WhatsApp desconectado.)'),
      });
    }

    if (toolName === 'offer_reschedule_to_client') {
      const appt = getAppointmentById(args.appointment_id);
      if (!appt) return JSON.stringify({ success: false, error: 'No existe ese turno.' });
      const notified = await sendToClient(appt.client_phone, priorityOfferText(appt, args.reason));
      return JSON.stringify({
        success: true, client_notified: notified,
        message: notified
          ? `Le escribí a ${appt.client_name || appt.client_phone} ofreciéndole reagendar con prioridad.`
          : 'No pude escribirle al cliente (WhatsApp desconectado).',
      });
    }

    return JSON.stringify({ error: `Herramienta desconocida: ${toolName}` });
  } catch (err) {
    console.error(`[ASSISTANT] Error en ${toolName}:`, err.message);
    return JSON.stringify({ success: false, error: `No se pudo ejecutar: ${err.message}` });
  }
}

// ─── Procesamiento del mensaje de Lucas ───────────────────────────────────────

async function processAssistantMessage(phone, userText) {
  const systemPrompt = buildAssistantPrompt();
  const state = getConversationState(phone);

  const history = [...state.history, { role: 'user', content: userText }].slice(-MAX_HISTORY_MESSAGES);

  let reply;
  try {
    reply = await callOpenRouter(history, systemPrompt, {
      clientPhone: phone,
      tools: ASSISTANT_TOOLS,
      executeToolFn: executeAssistantTool,
    });
  } catch (err) {
    console.error('[ASSISTANT] Error llamando a OpenRouter:', err.response?.data || err.message);
    reply = 'Uh, tuve un problema técnico procesando eso. Probá de nuevo en un momento.';
  }

  saveConversationState(phone, [...history, { role: 'assistant', content: reply }], state.step, state.car_info, false);
  return reply;
}

module.exports = {
  processAssistantMessage, buildAssistantPrompt, ASSISTANT_TOOLS, executeAssistantTool,
  sendToLucasAndRemember,
};
