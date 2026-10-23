'use strict';
// Structured JSON logs: Cloud Logging parses `severity` and `message` natively, so entries are filterable in the console.
const config = require('../config');
function log(severity, message, fields = {}) {
  if (config.isTest) return;
  const line = { severity, message, time: new Date().toISOString(), ...fields };
  (severity === 'ERROR' ? console.error : console.log)(config.isProd ? JSON.stringify(line) : `${severity} ${message} ${Object.keys(fields).length ? JSON.stringify(fields) : ''}`);
}
module.exports = { info: (m, f) => log('INFO', m, f), warn: (m, f) => log('WARNING', m, f), error: (m, f) => log('ERROR', m, f) };
