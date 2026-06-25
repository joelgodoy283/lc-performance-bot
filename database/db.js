/**
 * database/db.js — SQLite via sql.js (puro JavaScript, sin compilación nativa)
 *
 * sql.js trabaja en memoria y persiste al disco manualmente.
 * Se llama saveDB() después de cada operación de escritura.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'lc_performance.db');

let db    = null;  // instancia sql.js
let SQL   = null;  // módulo sql.js cargado

const DEFAULT_PROMPT = `Sos Juan Mecánico, el asistente virtual con Inteligencia Artificial de LC Performance, un taller especializado en mecánica automotriz avanzada y reprogramaciones ECU ubicado en Rosario, Santa Fe (Argentina). El taller trabaja desde 1996, con más de 500 trabajos realizados y garantía en cada intervención.

PRESENTACIÓN OBLIGATORIA:
En el PRIMER mensaje a un cliente nuevo SIEMPRE presentate como "Juan Mecánico, asistente virtual con Inteligencia Artificial de LC Performance". Aclará que si en cualquier momento prefiere hablar con una persona, puede escribir "hablar con Lucas" o "quiero un humano" y lo derivás.

DATOS DEL TALLER:
- Dirección: Bv. Seguí 2122, Rosario – Santa Fe (CP 2000).
- Teléfono / WhatsApp: 341 247 7055.
- Instagram: @lc_performance1996
- Reputación: 4.9★ en Google, más de 500 trabajos, +7K seguidores.

HORARIO DE ATENCIÓN:
- Lunes a viernes: 8:15 a 17:15 hs
- Sábados: 9:00 a 13:00 hs
- Domingos: cerrado
Nunca ofrezcas ni agendes turnos fuera de estos horarios.

SERVICIOS QUE OFRECEMOS:
Respondé SOLO sobre estos servicios reales. Si te preguntan por algo que no figura acá ni en la sección "SERVICIOS DEL TALLER" de más abajo, decí que lo consultás con Lucas.
- Reprogramación de Motor (ECU): optimización completa de la ECU para maximizar potencia, torque y eficiencia. Disponible en Stage 1, 2 y 3 según el objetivo.
- Diagnóstico Profesional: scanner de última generación para detectar fallas eléctricas y electrónicas (OBD, ECU, sistema eléctrico). Se diagnostica antes de tocar el vehículo.
- EGR / DPF OFF: desactivación o eliminación por software de la válvula EGR y del filtro de partículas DPF. Más potencia y menos puntos de falla, sin modificaciones físicas.
- Mecánica Automotriz: servicio integral de motor, suspensión y frenos con equipamiento profesional.
- Service de Caja Automática: diagnóstico, mantenimiento y reparación de cajas automáticas (AT) — cambio de aceite ATF, filtros y revisión completa del sistema.
- Lubricantes Premium: distribuidor oficial de Mannol y Liqui Moly (sintéticos de alta performance).

Detalle de Stages (reprogramación):
- Stage 1: solo reprogramación ECU, sin modificaciones físicas. Ideal para autos de serie. Mejora aproximada de 15–30 % de potencia.
- Stage 2: reprogramación + mejoras en admisión y/o escape. Mejora aproximada de 30–50 %.
- Stage 3: reprogramación avanzada con modificaciones internas del motor (mecánica forjada). Mejora de 50 %+. Es un proyecto de alto rendimiento.
Podés mencionar estos rangos de mejora de rendimiento; tené en cuenta que son porcentajes de mejora, NO precios.

PROCESO DE DIAGNÓSTICO INICIAL:
Antes de agendar un turno, recolectá estos datos del cliente. Pedilos TODOS en una sola pregunta, de forma clara y ordenada:
1. Nombre del cliente
2. Marca del vehículo (ej: Ford, Volkswagen, Toyota)
3. Modelo del vehículo (ej: Focus, Gol, Corolla)
4. Año del vehículo
5. Kilometraje aproximado
6. Descripción del problema o servicio que necesita
No le pidas el número de teléfono: ya lo tenés porque te escribe por WhatsApp.
Una vez que tengas los 6 datos, ofrecé agendar un turno.

AGENDAMIENTO DE TURNOS (Google Calendar):
Tenés herramientas para consultar la disponibilidad y crear turnos en el calendario del taller. Seguí SIEMPRE este flujo, sin saltearte pasos:
1. Solo después de tener los 6 datos del diagnóstico inicial, ofrecé agendar.
2. Preguntá qué día y franja horaria prefiere el cliente.
3. Validá el horario contra el horario de atención. Si cae fuera o es domingo, avisá y ofrecé alternativas dentro del horario.
4. Consultá la disponibilidad real del taller para ese día con la herramienta de disponibilidad ANTES de confirmar un horario. Si ese día está completo u ocupado en esa franja, ofrecé otra opción.
5. Confirmá TODOS los datos con el cliente antes de crear el turno (nombre, vehículo, servicio, día y hora). Recién con su confirmación explícita, creá el turno con la herramienta de calendario. Usá una duración de 1 hora salvo que el cliente indique otra cosa. No hace falta que pidas ni pases el teléfono: el sistema lo adjunta automáticamente.
6. Una vez agendado con éxito, confirmale el día y la hora exactos del turno y recordale la dirección (Bv. Seguí 2122).
7. Si la herramienta falla o no devuelve confirmación, NO inventes que quedó agendado: decile que vas a derivar la reserva a Lucas para confirmarla.

TONO: Profesional, amigable y empático. Lenguaje claro, sin tecnicismos excesivos. Tuteá al cliente. Hablá en español rioplatense (argentino), natural y directo.

LÍMITES:
- No des presupuestos exactos sin ver el vehículo físicamente.
- No inventes servicios, datos ni disponibilidad que no estén en esta información.
- Si el cliente quiere hablar con una persona, indicale que escriba "hablar con Lucas" o "quiero un humano" y derivá.
- Ante cualquier consulta que no puedas responder con esta información, decí honestamente que lo consultás con Lucas.`;

// ─── Persistencia ──────────────────────────────────────────────────────────

function saveDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ─── Helpers internos para ejecutar queries ────────────────────────────────

/**
 * Ejecuta un statement sin retorno (INSERT / UPDATE / DELETE / DDL)
 */
function run(sql, params = []) {
  db.run(sql, params);
  saveDB();
}

/**
 * Trae UN row como objeto plano, o undefined si no hay resultados
 */
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

/**
 * Trae TODOS los rows como array de objetos planos
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// ─── Inicialización ────────────────────────────────────────────────────────

async function initDB() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('[DB] Base de datos cargada desde', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('[DB] Base de datos nueva en', DB_PATH);
  }

  // Crear tablas si no existen
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      phone     TEXT NOT NULL,
      direction TEXT NOT NULL,
      content   TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS paused_contacts (
      phone     TEXT PRIMARY KEY,
      paused_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_state (
      phone      TEXT PRIMARY KEY,
      history    TEXT DEFAULT '[]',
      step       TEXT DEFAULT 'initial',
      car_info   TEXT DEFAULT '{}',
      is_new     INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      price       TEXT DEFAULT '',
      notes       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS blocked_contacts (
      phone      TEXT PRIMARY KEY,
      note       TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Guardar para persistir la estructura
  saveDB();

  // Insertar prompt por defecto si no existe
  const existing = queryOne('SELECT key FROM config WHERE key = ?', ['ai_prompt']);
  if (!existing) {
    run('INSERT INTO config (key, value) VALUES (?, ?)', ['ai_prompt', DEFAULT_PROMPT]);
  }

  console.log('[DB] ✅ Base de datos inicializada correctamente');
}

function getDB() {
  if (!db) throw new Error('Base de datos no inicializada. Llamar initDB() primero.');
  return db;
}

// ─── Config ────────────────────────────────────────────────────────────────

function getConfig(key) {
  const row = queryOne('SELECT value FROM config WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setConfig(key, value) {
  const existing = queryOne('SELECT key FROM config WHERE key = ?', [key]);
  if (existing) {
    run("UPDATE config SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);
  } else {
    run('INSERT INTO config (key, value) VALUES (?, ?)', [key, value]);
  }
}

// ─── Mensajes ──────────────────────────────────────────────────────────────

function saveMessage(phone, direction, content) {
  run('INSERT INTO messages (phone, direction, content) VALUES (?, ?, ?)', [phone, direction, content]);
}

function getMessages(phone, limit = 50) {
  // sql.js no soporta parámetros nombrados fácilmente, usamos valores directos para LIMIT
  const rows = queryAll(
    `SELECT * FROM (SELECT * FROM messages WHERE phone = ? ORDER BY rowid DESC LIMIT ${parseInt(limit)}) ORDER BY rowid ASC`,
    [phone]
  );
  return rows;
}

function getMessagesSince(isoCutoff) {
  return queryAll(
    'SELECT * FROM messages WHERE timestamp >= ? ORDER BY phone, rowid',
    [isoCutoff]
  );
}

function getRecentChats() {
  return queryAll(`
    SELECT m.phone,
           m.content   AS last_message,
           m.direction AS last_direction,
           m.timestamp AS last_at,
           (SELECT COUNT(*) FROM messages WHERE phone = m.phone) AS total_msgs,
           CASE WHEN pc.phone IS NOT NULL THEN 1 ELSE 0 END AS is_paused
    FROM messages m
    LEFT JOIN paused_contacts pc ON pc.phone = m.phone
    WHERE m.id = (
      SELECT MAX(id) FROM messages WHERE phone = m.phone
    )
    ORDER BY m.timestamp DESC
    LIMIT 50
  `);
}

// ─── Pausa ─────────────────────────────────────────────────────────────────

function pauseContact(phone) {
  const exists = queryOne('SELECT phone FROM paused_contacts WHERE phone = ?', [phone]);
  if (exists) {
    run("UPDATE paused_contacts SET paused_at = datetime('now') WHERE phone = ?", [phone]);
  } else {
    run('INSERT INTO paused_contacts (phone) VALUES (?)', [phone]);
  }
}

function resumeContact(phone) {
  run('DELETE FROM paused_contacts WHERE phone = ?', [phone]);
}

function isPaused(phone) {
  const row = queryOne('SELECT phone FROM paused_contacts WHERE phone = ?', [phone]);
  return !!row;
}

// ─── Estado de conversación ────────────────────────────────────────────────

function getConversationState(phone) {
  const row = queryOne('SELECT * FROM conversation_state WHERE phone = ?', [phone]);
  if (!row) return { phone, history: [], step: 'initial', car_info: {}, is_new: true };
  return {
    ...row,
    history:  JSON.parse(row.history  || '[]'),
    car_info: JSON.parse(row.car_info || '{}'),
    is_new:   row.is_new === 1 || row.is_new === true,
  };
}

function saveConversationState(phone, history, step, car_info, is_new) {
  const historyJson  = JSON.stringify(history);
  const carInfoJson  = JSON.stringify(car_info);
  const isNewInt     = is_new ? 1 : 0;

  const existing = queryOne('SELECT phone FROM conversation_state WHERE phone = ?', [phone]);
  if (existing) {
    run(
      "UPDATE conversation_state SET history=?, step=?, car_info=?, is_new=?, updated_at=datetime('now') WHERE phone=?",
      [historyJson, step, carInfoJson, isNewInt, phone]
    );
  } else {
    run(
      'INSERT INTO conversation_state (phone, history, step, car_info, is_new) VALUES (?, ?, ?, ?, ?)',
      [phone, historyJson, step, carInfoJson, isNewInt]
    );
  }
}

// ─── Servicios ─────────────────────────────────────────────────────────────

function getServices() {
  return queryAll('SELECT * FROM services ORDER BY id ASC');
}

function addService({ name, description = '', price = '', notes = '' }) {
  run(
    'INSERT INTO services (name, description, price, notes) VALUES (?, ?, ?, ?)',
    [name, description, price, notes]
  );
}

function updateService(id, { name, description = '', price = '', notes = '' }) {
  run(
    'UPDATE services SET name = ?, description = ?, price = ?, notes = ? WHERE id = ?',
    [name, description, price, notes, id]
  );
}

function deleteService(id) {
  run('DELETE FROM services WHERE id = ?', [id]);
}

// ─── Excepciones (contactos bloqueados) ────────────────────────────────────

function getBlockedContacts() {
  return queryAll('SELECT * FROM blocked_contacts ORDER BY created_at DESC');
}

function addBlockedContact(phone, note = '') {
  const normalized = normalizePhone(phone);
  if (!normalized) return;
  const exists = queryOne('SELECT phone FROM blocked_contacts WHERE phone = ?', [normalized]);
  if (exists) {
    run('UPDATE blocked_contacts SET note = ? WHERE phone = ?', [note, normalized]);
  } else {
    run('INSERT INTO blocked_contacts (phone, note) VALUES (?, ?)', [normalized, note]);
  }
}

function removeBlockedContact(phone) {
  run('DELETE FROM blocked_contacts WHERE phone = ?', [normalizePhone(phone)]);
}

function isBlocked(phone) {
  const row = queryOne('SELECT phone FROM blocked_contacts WHERE phone = ?', [normalizePhone(phone)]);
  return !!row;
}

// ─── Util ──────────────────────────────────────────────────────────────────

/** Devuelve solo los dígitos de un JID o número (para comparar excepciones). */
function normalizePhone(jidOrNumber) {
  if (!jidOrNumber) return '';
  return String(jidOrNumber).replace(/^ig:/, '').replace(/\D/g, '');
}

module.exports = {
  DEFAULT_PROMPT,
  initDB, getDB, saveDB,
  getConfig, setConfig,
  saveMessage, getMessages, getMessagesSince, getRecentChats,
  pauseContact, resumeContact, isPaused,
  getConversationState, saveConversationState,
  getServices, addService, updateService, deleteService,
  getBlockedContacts, addBlockedContact, removeBlockedContact, isBlocked,
  normalizePhone,
};
