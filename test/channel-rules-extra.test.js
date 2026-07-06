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

test('@lid no se interpreta como característica no-Rosario', () => {
  const { validateAppointmentChannelRules, appointmentPhone, hasCheckablePhonePrefix } = require('../ai/channel-rules');
  const lid = '23789452342345@lid';
  assert.equal(hasCheckablePhonePrefix(lid), false);
  assert.equal(appointmentPhone({ channelPhone: lid }), lid);
  const res = validateAppointmentChannelRules({ channelPhone: lid });
  assert.equal(res.ok, true);
  assert.equal(res.phone, lid);
});

test('los turnos preservan @lid para poder responder por el mismo canal', () => {
  const lid = '23789452342345@lid';
  const appt = db.createAppointment({
    client_phone: lid,
    client_name: 'Cliente LID',
    car_info: 'Auto prueba',
    date: '2099-01-05',
    time: '09:00',
  });
  assert.equal(appt.client_phone, lid);
});


test('getMessages recupera historial aunque el dashboard pida solo dígitos', () => {
  db.saveMessage('5493417284477@s.whatsapp.net', 'incoming', 'hola desde jid');
  const rows = db.getMessages('5493417284477');
  assert.equal(rows.length >= 1, true);
  assert.equal(rows.at(-1).content, 'hola desde jid');
});
