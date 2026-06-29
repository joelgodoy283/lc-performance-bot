const crypto = require('crypto');
const { initDB, setConfig } = require('../database/db');

(async () => {
  await initDB();
  const password = process.argv[2] || crypto.randomBytes(12).toString('base64url');
  if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
  setConfig('dashboard_password', password);
  console.log(`Contraseña temporal del panel: ${password}`);
})().catch(err => { console.error(err.message); process.exit(1); });
