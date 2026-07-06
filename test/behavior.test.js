const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `lc-performance-test-${process.pid}.db`);
const db = require('../database/db');

test.before(async () => { await db.initDB(); });

test('el prompt de Configurar IA queda marcado como autoridad máxima', () => {
  db.setConfig('ai_prompt', 'PROMPT OFICIAL DE PRUEBA: nunca prometas precios.');
  db.setConfig('share_prices', 'true');
  const { buildSystemPrompt, PROMPT_AUTHORITY } = require('../ai/openrouter');
  const prompt = buildSystemPrompt();
  assert.match(prompt, /INICIO DEL PROMPT OFICIAL/);
  assert.match(prompt, /PROMPT OFICIAL DE PRUEBA/);
  assert.equal(prompt.split(PROMPT_AUTHORITY).length - 1, 2);
});

test('el seguimiento requiere pregunta y excluye mensajes inadecuados', () => {
  db.setConfig('followup_enabled', 'true');
  const { shouldFollowUp } = require('../jobs/followups');
  assert.equal(shouldFollowUp('¿Querés que te busque un turno?'), true);
  assert.equal(shouldFollowUp('Tu turno quedó confirmado.'), false);
  assert.equal(shouldFollowUp('¿Nos dejás una reseña?', 'review'), false);
});

test('las 3 horas se respetan y fuera de horario pasa al próximo horario hábil', () => {
  const { firstRunAt } = require('../jobs/followups');
  assert.equal(firstRunAt(new Date('2026-06-29T12:00:00-03:00')).toISOString(), '2026-06-29T18:00:00.000Z');
  assert.equal(firstRunAt(new Date('2026-07-03T16:00:00-03:00')).toISOString(), '2026-07-04T12:00:00.000Z');
});

test('la contraseña guardada en el panel tiene prioridad sobre la del entorno', () => {
  process.env.DASHBOARD_PASSWORD = 'ClaveDelEntorno';
  db.setConfig('dashboard_password', 'ClaveNuevaSegura');
  assert.equal(db.getDashboardPassword(), 'ClaveNuevaSegura');
});

test('Instagram exige WhatsApp real antes de crear turno', () => {
  const { validateAppointmentChannelRules } = require('../ai/channel-rules');
  const res = validateAppointmentChannelRules({ channelPhone: 'ig:178412345' });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'missing_whatsapp_phone_for_instagram');
});

test('número no Rosario requiere confirmación y luego permite avanzar', () => {
  const { validateAppointmentChannelRules } = require('../ai/channel-rules');
  const blocked = validateAppointmentChannelRules({ channelPhone: '549115551234@s.whatsapp.net' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'missing_rosario_location_confirmation');

  const allowed = validateAppointmentChannelRules({
    channelPhone: '549115551234@s.whatsapp.net',
    rosarioLocationConfirmed: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.phone, '549115551234');
});

test('detecta confirmación natural de ubicación en Rosario', () => {
  const { detectRosarioConfirmation } = require('../ai/channel-rules');
  assert.equal(detectRosarioConfirmation('Sí, vivo en Rosario pero tengo número de Buenos Aires'), true);
  assert.equal(detectRosarioConfirmation('No hay problema, puedo acercarme al taller'), true);
  assert.equal(detectRosarioConfirmation('Quiero un turno para mañana'), false);
});
