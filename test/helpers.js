'use strict';
process.env.NODE_ENV = 'test';
const { createApp } = require('../src/app');

async function start() {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

/** Tiny cookie-jar client so each "user" keeps their own session. */
function client(base) {
  let cookie = '';
  return async function call(path, { method = 'GET', body, csrf = true, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-requested-with': 'pantrypilot' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: res.status, headers: res.headers, json, text };
  };
}

const future = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

module.exports = { start, client, future };
