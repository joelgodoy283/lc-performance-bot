const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
process.env.DB_PATH = path.join(os.tmpdir(), `lc-performance-channel-extra-${process.pid}.db`);

const db = require('../database/db');

test.before(async () => { await db.initDB(); });

test('reconoce números de Rosario en formatos 341, 54341 y 549341', () => {
  const { isRosarioPhone, validateAppointmentChannelRules } = require('../ai/channel-rules');
  assert.equal(isRosarioPhone('3417284477@s.whatsapp.net'), true);
  assert.equal(isRosarioPhone('543417284477@s.whatsapp.net'), true);
  assert.equal(isRosarioPhone('5493417284477@s.whatsapp.net'), true);

  const res = validateAppointmentChannelRules({ channelPhone: '3417284477@s.whatsapp.net' });
  assert.equal(res.ok, true);
});

test('@lid no se interpreta como característica no-Rosario, pero exige teléfono real para agendar', () => {
  const { validateAppointmentChannelRules, appointmentPhone, hasCheckablePhonePrefix } = require('../ai/channel-rules');
  const lid = '23789452342345@lid';
  assert.equal(hasCheckablePhonePrefix(lid), false);
  assert.equal(appointmentPhone({ channelPhone: lid }), '');

  const blocked = validateAppointmentChannelRules({ channelPhone: lid });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'missing_real_phone_for_whatsapp_lid');

  const allowed = validateAppointmentChannelRules({ channelPhone: lid, providedPhone: '3417284477' });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.phone, '3417284477');
});

test('si se conoce el teléfono real, el turno guarda ese número y no el @lid', () => {
  const lid = '23789452342345@lid';
  const realPhone = '3417284477';
  const appt = db.createAppointment({
    client_phone: realPhone,
    client_name: 'Cliente LID',
    car_info: 'Auto prueba',
    date: '2099-01-05',
    time: '09:00',
  });
  assert.equal(appt.client_phone, realPhone);
  assert.notEqual(appt.client_phone, lid);
});


test('getMessages recupera historial aunque el dashboard pida solo dígitos', () => {
  db.saveMessage('5493417284477@s.whatsapp.net', 'incoming', 'hola desde jid');
  const rows = db.getMessages('5493417284477');
  assert.equal(rows.length >= 1, true);
  assert.equal(rows.at(-1).content, 'hola desde jid');
});
