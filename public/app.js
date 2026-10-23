'use strict';
(() => {
  const UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'pack'];
  const CATEGORIES = ['produce', 'dairy', 'meat', 'seafood', 'grains', 'bakery', 'pantry', 'other'];
  const DIETS = ['none', 'vegetarian', 'vegan'];
  const ALLERGENS = ['peanut', 'tree_nut', 'dairy', 'egg', 'gluten', 'soy', 'fish', 'shellfish', 'sesame'];

  const $ = (id) => document.getElementById(id);
  const state = { user: null, parsed: [], mode: 'login', google: null };

  // XSS-safe element builder: only ever uses textContent, never innerHTML.
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };
  const label = (s) => s.replace('_', ' ');

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pantrypilot' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.user && path !== '/auth/login') { showAuth(); throw new Error('Session expired. Please log in again.'); }
    if (!res.ok) {
      const detail = data.issues?.[0] ? `${data.issues[0].path}: ${data.issues[0].message}` : '';
      throw new Error(data.error ? (detail ? `${data.error} (${detail})` : data.error) : `Request failed (${res.status})`);
    }
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }
  const guard = (btn, fn) => async (...a) => {
    btn.disabled = true;
    try { await fn(...a); } catch (e) { toast(e.message); } finally { btn.disabled = false; }
  };

  // ---------- navigation ----------
  function showAuth() {
    state.user = null;
    for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
    $('view-auth').classList.remove('hidden');
    $('tabs').classList.add('hidden');
    $('logout').classList.add('hidden');
  }
  function showApp() {
    $('view-auth').classList.add('hidden');
    $('tabs').classList.remove('hidden');
    $('logout').classList.remove('hidden');
    switchTab('pantry');
  }
  function switchTab(name) {
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
    for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
    $('view-' + name).classList.remove('hidden');
    ({ pantry: loadPantry, impact: loadImpact, settings: loadSettings }[name] || (() => {}))();
  }

  // ---------- auth ----------
  function setAuthMode(mode) {
    state.mode = mode;
    const reg = mode === 'register';
    $('auth-title').textContent = reg ? 'Create your account' : 'Welcome back';
    $('auth-submit').textContent = reg ? 'Sign up' : 'Log in';
    $('auth-switch').textContent = reg ? 'Have an account? Log in' : 'New here? Create an account';
    $('password').autocomplete = reg ? 'new-password' : 'current-password';
    $('auth-error').textContent = '';
  }
  $('auth-switch').addEventListener('click', () => setAuthMode(state.mode === 'login' ? 'register' : 'login'));
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('auth-submit');
    btn.disabled = true;
    try {
      const { user } = await api('/auth/' + state.mode, { method: 'POST', body: { email: $('email').value, password: $('password').value } });
      state.user = user;
      $('password').value = '';
      showApp();
    } catch (err) { $('auth-error').textContent = err.message; } finally { btn.disabled = false; }
  });
  // Google sign-in (Firebase Auth): shown only when the server reports Firebase is configured.
  async function googleToken() {
    if (!state.google) throw new Error('Google sign-in is not available');
    try { return await state.google.getIdToken(); } catch (e) { throw new Error(e?.code === 'auth/popup-closed-by-user' ? 'Sign-in cancelled' : 'Google sign-in failed'); }
  }
  $('google-btn').addEventListener('click', async () => {
    const btn = $('google-btn');
    btn.disabled = true;
    $('auth-error').textContent = '';
    try {
      const { user } = await api('/auth/google', { method: 'POST', body: { idToken: await googleToken() } });
      state.user = user;
      showApp();
    } catch (err) { $('auth-error').textContent = err.message; } finally { btn.disabled = false; }
  });
  (async () => {
    try {
      const cfg = await (await fetch('/api/config')).json();
      if (!cfg.firebase) return;
      state.google = await (await import('/firebase-login.js')).init(cfg.firebase);
      $('google-box').classList.remove('hidden');
    } catch (_) { /* Google sign-in is optional; password login still works */ }
  })();
  $('logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); showAuth(); });
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => switchTab(b.dataset.tab));

  // ---------- pantry ----------
  const fill = (sel, opts) => opts.forEach((o) => sel.append(h('option', { value: o }, label(o))));
  fill($('i-unit'), UNITS); fill($('i-cat'), CATEGORIES);
  $('i-exp').value = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);

  async function loadPantry() {
    const { items } = await api('/pantry');
    const list = $('pantry-list');
    clear(list);
    $('pantry-count').textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;
    $('pantry-empty').classList.toggle('hidden', items.length > 0);
    for (const it of items) {
      const urgency = it.days_left < 0 ? 'expired' : it.days_left <= 1 ? 'critical' : it.days_left <= 3 ? 'soon' : it.days_left <= 7 ? 'watch' : 'ok';
      const when = it.days_left < 0 ? `expired ${-it.days_left}d ago` : it.days_left === 0 ? 'expires today' : `${it.days_left}d left`;
      list.append(h('li', {},
        h('span', { class: 'name' }, it.name),
        h('span', { class: 'meta' }, `${it.quantity} ${it.unit} · ${it.category}`),
        h('span', { class: 'chip ' + urgency }, when),
        h('span', { class: 'btns' },
          h('button', { type: 'button', onclick: () => mark(it.id, 'used') }, 'Used'),
          h('button', { type: 'button', onclick: () => mark(it.id, 'wasted') }, 'Wasted'),
          h('button', { type: 'button', 'aria-label': 'Delete ' + it.name, onclick: () => remove(it.id) }, 'Delete'))));
    }
  }
  async function mark(id, status) {
    try { const r = await api('/pantry/' + id, { method: 'PATCH', body: { status } }); toast(r.kind === 'rescued' ? 'Rescued before it expired. Nice!' : 'Logged'); loadPantry(); } catch (e) { toast(e.message); }
  }
  async function remove(id) { try { await api('/pantry/' + id, { method: 'DELETE' }); loadPantry(); } catch (e) { toast(e.message); } }

  $('item-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/pantry', { method: 'POST', body: {
        name: $('i-name').value, quantity: Number($('i-qty').value), unit: $('i-unit').value,
        category: $('i-cat').value, expires_on: $('i-exp').value, cost: Number($('i-cost').value || 0) } });
      $('i-name').value = '';
      loadPantry();
    } catch (err) { toast(err.message); }
  });

  function renderParsed() {
    const box = $('r-preview');
    clear($('r-list'));
    if (!state.parsed.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    state.parsed.forEach((it, idx) => $('r-list').append(h('li', {},
      h('span', { class: 'name' }, it.name),
      h('span', { class: 'meta' }, `${it.quantity} ${it.unit} · ${it.category} · expires ${it.expires_on}`),
      h('button', { type: 'button', class: 'ghost', onclick: () => { state.parsed.splice(idx, 1); renderParsed(); } }, 'Remove'))));
  }
  $('r-parse').addEventListener('click', guard($('r-parse'), async () => {
    const text = $('r-text').value.trim();
    if (text.length < 3) throw new Error('Paste some receipt text first');
    const r = await api('/pantry/parse-text', { method: 'POST', body: { text } });
    state.parsed = r.items;
    if (!r.items.length) toast('No food items found');
    else toast(`Found ${r.items.length} items (${r.mode === 'gemini' ? 'Gemini' : 'offline parser'})`);
    renderParsed();
  }));
  $('r-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast('Image must be under 4MB');
    try {
      const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(file); });
      toast('Scanning with Gemini...');
      const r = await api('/pantry/parse-image', { method: 'POST', body: { mime: file.type, data: b64 } });
      state.parsed = r.items; renderParsed(); toast(`Found ${r.items.length} items`);
    } catch (err) { toast(err.message); }
  });
  $('r-add').addEventListener('click', guard($('r-add'), async () => {
    await api('/pantry/bulk', { method: 'POST', body: { items: state.parsed } });
    state.parsed = []; renderParsed(); $('r-text').value = ''; toast('Added to pantry'); loadPantry();
  }));

  // ---------- planner ----------
  const stat = (v, l) => h('div', { class: 'stat' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
  $('p-run').addEventListener('click', guard($('p-run'), async () => {
    $('p-run').textContent = 'Agents working...';
    try {
      const r = await api('/agent/plan', { method: 'POST', body: { days: Number($('p-days').value) } });
      renderPlan(r);
    } finally { $('p-run').textContent = 'Generate plan'; }
  }));
  function renderPlan(r) {
    $('plan-out').classList.remove('hidden');
    const b = $('plan-banner');
    const g = r.guardrail.violationsBlocked;
    b.className = 'banner ' + (g ? 'warn' : 'ok');
    b.textContent = (r.mode === 'gemini' ? 'Planned by Gemini. ' : r.mode === 'offline' ? 'Gemini unavailable, safe rule-based planner used. ' : '') +
      (g ? `Safety critic blocked ${g} unsafe meal suggestion${g > 1 ? 's' : ''}.` : 'Safety critic: all meals passed your diet and allergen rules.');
    clear($('plan-stats'));
    $('plan-stats').append(
      stat(Math.round(r.stats.coverage * 100) + '%', 'of expiring items used'),
      stat(String(r.stats.expiring.length), 'items to rescue'),
      stat(r.stats.projected_money.toFixed(2), 'money saved if you follow it'),
      stat(r.stats.projected_co2_kg.toFixed(1) + ' kg', 'CO₂e avoided (est.)'));
    clear($('plan-meals'));
    if (!r.plan.meals.length) $('plan-meals').append(h('div', { class: 'card' }, r.plan.tips[0] || 'Nothing to plan.'));
    for (const m of r.plan.meals) {
      $('plan-meals').append(h('article', { class: 'card meal' },
        h('div', { class: 'day' }, 'Day ' + m.day + ' · ' + m.minutes + ' min' + (m.kcal ? ' · ~' + m.kcal + ' kcal' : '')),
        h('h3', {}, m.title),
        h('div', { class: 'tags' }, m.uses.map((u) => h('span', { class: 'tag use' }, u)), m.extras.map((x) => h('span', { class: 'tag' }, '+ ' + x))),
        h('ol', {}, m.steps.map((s) => h('li', {}, s)))));
    }
    for (const t of r.plan.tips) $('plan-meals').append(h('div', { class: 'card muted' }, 'Tip: ' + t));
    clear($('plan-trace'));
    for (const t of r.trace) $('plan-trace').append(h('li', {}, h('b', {}, t.agent), ' — ', t.note, t.ms ? ` (${t.ms}ms)` : ''));
  }

  // ---------- impact ----------
  async function loadImpact() {
    const d = await api('/agent/impact');
    clear($('impact-stats'));
    $('impact-stats').append(
      stat(String(d.rescued_items), 'items rescued'),
      stat(d.money_saved.toFixed(2), 'money saved'),
      stat(d.co2_saved_kg.toFixed(1) + ' kg', 'CO₂e avoided (est.)'),
      stat(Math.round(d.waste_rate * 100) + '%', 'waste rate'));
    const chart = $('impact-chart');
    clear(chart);
    if (!d.weekly.length) chart.append(h('p', { class: 'muted' }, 'Mark pantry items as used or wasted to see your trend.'));
    const max = Math.max(1, ...d.weekly.map((w) => w.saved + w.wasted));
    for (const w of d.weekly) {
      const s = h('div', { class: 's' }); s.style.width = (w.saved / max) * 100 + '%';
      const x = h('div', { class: 'w' }); x.style.width = (w.wasted / max) * 100 + '%';
      chart.append(h('div', { class: 'bar-row' }, h('span', {}, 'Wk ' + w.week.split('-')[1]), h('div', { class: 'bar' }, s, x), h('span', {}, `${w.saved} / ${w.wasted}`)));
    }
  }

  // ---------- settings ----------
  fill($('s-diet'), DIETS);
  for (const a of ALLERGENS) $('s-allergens').append(h('label', {}, h('input', { type: 'checkbox', value: a }), label(a)));
  async function loadSettings() {
    const { user } = await api('/auth/me');
    state.user = user;
    $('d-pass-label').classList.toggle('hidden', !user.has_password);
    $('d-google-note').classList.toggle('hidden', user.has_password);
    $('s-diet').value = user.diet; $('s-house').value = user.household;
    for (const c of $('s-allergens').querySelectorAll('input')) c.checked = user.allergens.includes(c.value);
    const m = await api('/agent/metrics');
    const dl = $('metrics'); clear(dl);
    const rows = [['Requests', m.requests], ['p50 latency', m.latency_ms.p50 + ' ms'], ['p95 latency', m.latency_ms.p95 + ' ms'],
      ['AI engine', m.ai.mode], ['Database', m.ai.database],
      ['LLM calls', m.llm.calls], ['LLM cache hit rate', Math.round(m.llm.cache_hit_rate * 100) + '%'], ['LLM fallbacks', m.llm.fallbacks],
      ['Tokens used', m.llm.tokens_total.toLocaleString()], ['Est. AI cost', '$' + m.llm.est_cost_usd.toFixed(4)],
      ['Est. saved by cache', '$' + m.llm.est_saved_by_cache_usd.toFixed(4)], ['Your AI calls today', `${m.ai_used_today} / ${m.ai_daily_limit}`]];
    for (const [k, v] of rows) dl.append(h('dt', {}, k), h('dd', {}, String(v)));
  }
  $('profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const allergens = [...$('s-allergens').querySelectorAll('input:checked')].map((c) => c.value);
      await api('/auth/profile', { method: 'PUT', body: { diet: $('s-diet').value, allergens, household: Number($('s-house').value) } });
      toast('Profile saved');
    } catch (err) { toast(err.message); }
  });
  $('delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!confirm('Permanently delete your account and all data?')) return;
    try {
      const body = state.user?.has_password === false ? { idToken: await googleToken() } : { password: $('d-pass').value };
      await api('/auth/account', { method: 'DELETE', body });
      $('d-pass').value = ''; showAuth(); toast('Account deleted');
    } catch (err) { toast(err.message); }
  });

  // ---------- boot ----------
  (async () => {
    try { const { user } = await api('/auth/me'); state.user = user; showApp(); } catch (_) { showAuth(); }
  })();
})();
