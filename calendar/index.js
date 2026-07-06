/**
 * calendar/index.js — Fachada de calendario.
 *
 * Fuente de verdad: SIEMPRE la tabla `appointments` (estados, recordatorios y
 * reseñas viven ahí). Si Google Calendar está configurado, además se espeja el
 * turno como evento en Google para que Lucas lo vea en su agenda.
 *
 * La disponibilidad la gobierna siempre el modelo de capacidad del taller
 * (capacidad/día + horarios de entrega), porque refleja la realidad del local.
 */
const google = require('./google-calendar');
const local = require('./local-calendar');
const db = require('../database/db');
const { notifyLucas } = require('../whatsapp/notify');
const { ensureCustomer, getInternalCustomerContext, cancelFollowups } = require('../supabase/client');

/** ¿Está Google Calendar configurado (credenciales + token)? */
function usingGoogle() {
  return google.isCalendarConfigured();
}

/** El calendario siempre está disponible: el sistema propio no requiere setup. */
function isConfigured() {
  return true;
}

/** Suma una hora a un "HH:MM" → "HH:MM" (para la duración por defecto del evento). */
function addOneHour(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(Number);
  const end = new Date(2000, 0, 1, h + 1, m);
  return `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

async function getAvailability(dateStr) {
  return local.getAvailability(dateStr);
}

/**
 * Crea un turno. data: { client_phone, client_name, car_info, service, date,
 * start_time, end_time? }. Inserta en la DB (fuente de verdad), espeja en
 * Google si está configurado, y avisa a Lucas.
 */
async function createAppointment(data) {
  const res = await local.createAppointment({
    client_phone: data.client_phone,
    client_name: data.client_name,
    car_info: data.car_info,
    service: data.service,
    date: data.date,
    start_time: data.start_time,
    source: usingGoogle() ? 'google' : 'local',
  });
  if (!res.success) return res;

  await ensureCustomer(data.client_phone, { display_name: data.client_name }).catch(() => {});
  await cancelFollowups(data.client_phone, 'appointment_created');

  // Espejo en Google Calendar (no bloqueante: si falla, el turno propio queda igual)
  if (usingGoogle() && data.start_time) {
    try {
      const ev = await google.createAppointment({
        summary: `Turno: ${data.client_name || ''} - ${data.car_info || ''}`,
        description:
          `Cliente: ${data.client_name || ''}\nVehículo: ${data.car_info || ''}` +
          (data.service ? `\nServicio: ${data.service}` : ''),
        dateStr: data.date,
        startTime: data.start_time,
        endTime: data.end_time || addOneHour(data.start_time),
        clientPhone: data.client_phone,
      });
      if (ev?.eventId) db.updateAppointment(res.appointmentId, { google_event_id: ev.eventId });
      res.link = ev?.link;
    } catch (err) {
      console.error('[CAL] No se pudo espejar en Google (sigo con el turno propio):', err.message);
    }
  }

  // Aviso a Lucas (se omite si lo creó el propio Lucas a mano)
  if (data.notifyOwner !== false) {
    const tel = db.normalizePhone(data.client_phone);
    const memory = await getInternalCustomerContext(data.client_phone);
    const last = memory?.services?.[0];
    const privateBrief = last
      ? `\nAntecedente interno: ${last.service_date} — ${last.work_performed}` +
        (last.vehicle_condition ? ` | Estado: ${last.vehicle_condition}` : '') +
        (last.mileage ? ` | ${last.mileage} km` : '') +
        (last.unresolved_items ? ` | Pendiente: ${last.unresolved_items}` : '')
      : '';
    const lucasMsg =
      `🗓️ *Nuevo turno agendado*\n` +
      `Cliente: ${data.client_name || '—'}\n` +
      `Vehículo: ${data.car_info || '—'}\n` +
      (data.service ? `Servicio: ${data.service}\n` : '') +
      `Día: ${data.date}${data.start_time ? ` a las ${data.start_time} hs` : ''}\n` +
      `Tel: ${tel}${privateBrief}`;
    notifyLucas(lucasMsg).catch(() => {});
  }

  return res;
}

/**
 * Reagenda un turno a otra fecha/hora. Valida cupo del nuevo día, resetea el
 * recordatorio y re-espeja en Google si corresponde.
 */
async function rescheduleAppointment(id, newDate, newTime) {
  const appt = db.getAppointmentById(id);
  if (!appt) return { success: false, message: 'No encontré ese turno.' };

  if (newDate && newDate !== appt.date && !local.dayHasRoom(newDate)) {
    return { success: false, message: `El ${newDate} no tiene lugar (cerrado o completo).` };
  }
  const date = newDate || appt.date;
  const time = newTime || appt.time;

  db.updateAppointment(id, { date, time, status: 'scheduled', reminder_sent: 0 });

  // Re-espejar en Google (borrar el evento viejo y crear uno nuevo)
  if (appt.google_event_id) {
    try { await google.deleteEvent(appt.google_event_id); } catch (e) { /* noop */ }
  }
  let newEventId = '';
  if (usingGoogle() && time) {
    try {
      const ev = await google.createAppointment({
        summary: `Turno: ${appt.client_name || ''} - ${appt.car_info || ''}`,
        description: `Cliente: ${appt.client_name || ''}\nVehículo: ${appt.car_info || ''}`,
        dateStr: date,
        startTime: time,
        endTime: addOneHour(time),
        clientPhone: appt.client_phone,
      });
      newEventId = ev?.eventId || '';
    } catch (e) {
      console.error('[CAL] No se pudo re-espejar en Google:', e.message);
    }
  }
  db.updateAppointment(id, { google_event_id: newEventId });

  return { success: true, appointment: db.getAppointmentById(id) };
}

/** Cancela un turno (por id de la DB). Borra el evento de Google si existía. */
async function cancelAppointment(id) {
  const appt = db.getAppointmentById(id);
  if (!appt) return { success: false, message: 'No encontré ese turno.' };
  db.updateAppointment(id, { status: 'cancelled' });
  if (appt.google_event_id) {
    try {
      await google.deleteEvent(appt.google_event_id);
    } catch (err) {
      console.error('[CAL] No se pudo borrar el evento de Google:', err.message);
    }
  }

  // Avisar al cliente que su turno fue cancelado
  try {
    const { sendMessage, getConnectionState } = require('../whatsapp/baileys');
    const { recipientJid, prettyDate } = require('../whatsapp/jid-helper');
    const jid = recipientJid(appt.client_phone);
    if (jid && getConnectionState().status === 'connected') {
      const nombre = appt.client_name ? ` ${appt.client_name}` : '';
      const fecha = appt.date ? prettyDate(appt.date) : '';
      const hora = appt.time ? ` a las ${appt.time} hs` : '';
      const detalle = fecha ? ` para el ${fecha}${hora}` : '';
      const msg =
        `Hola${nombre}, tu turno en LC Performance${detalle} fue cancelado.` +
        `
Si querés reagendar, escribime y coordinamos otro día y horario.` +
        `
¡Saludos!`;
      await sendMessage(jid, msg).catch(() => {});
      db.saveMessage(jid, 'outgoing', msg);
      global.io?.emit('chat:message', { phone: jid, direction: 'outgoing', content: msg, timestamp: new Date().toISOString() });
    }
  } catch (err) {
    console.error('[CAL] No se pudo notificar cancelación al cliente:', err.message);
  }

  return { success: true, appointment: db.getAppointmentById(id) };
}

module.exports = {
  usingGoogle,
  isConfigured,
  getAvailability,
  createAppointment,
  cancelAppointment,
  rescheduleAppointment,
};
