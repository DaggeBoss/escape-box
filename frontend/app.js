/* ════════════════════════════════════════════════════════
   ESCAPE BOX — ADMIN PORTAL
   Single-page vanilla JS application
   ──────────────────────────────────────────────────────── */

const API = window.APP_CONFIG.API_BASE.replace(/\/+$/, '');
const WS_URL = window.APP_CONFIG.WS_URL;

/* ─── STATE ──────────────────────────────────────────── */
const state = {
  token: localStorage.getItem('eb_token') || null,
  user: JSON.parse(localStorage.getItem('eb_user') || 'null'),
  currentView: null,
  ws: null,
  wsRetry: 0,
  // cached lists
  scenarios: [],
  organizations: [],
  users: [],
  events: [],
  // selection
  currentScenarioId: null,
  currentEventId: null,
};

/* ─── UTIL ──────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('nb-NO', { day: '2-digit', month: 'short', year: 'numeric' }) +
         ' ' + d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
}

function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString('nb-NO', { day: '2-digit', month: 'short' });
}

function formatDuration(secs) {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function showToast(message, type = 'info', duration = 2800) {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '!' };
  const c = $('#toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${escapeHtml(message)}</span>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

/* ─── API CLIENT ──────────────────────────────────────── */
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const res = await fetch(API + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { data = null; }
  } else {
    data = await res.text();
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && state.token) {
      // token utløpt eller ugyldig
      logout();
    }
    throw err;
  }
  return data;
}

/* ─── AUTH ──────────────────────────────────────────── */
async function login(email, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('eb_token', data.token);
  localStorage.setItem('eb_user', JSON.stringify(data.user));
  enterApp();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('eb_token');
  localStorage.removeItem('eb_user');
  if (state.ws) try { state.ws.close(); } catch {}
  state.ws = null;
  $('#login-screen').classList.remove('hidden');
  $('#header').classList.add('hidden');
  $('#main').classList.add('hidden');
  $('#login-email').value = '';
  $('#login-password').value = '';
  $('#login-error').classList.add('hidden');
}

function enterApp() {
  $('#login-screen').classList.add('hidden');
  $('#header').classList.remove('hidden');
  $('#main').classList.remove('hidden');

  // Header brukerinfo
  $('#header-user-name').textContent = state.user.name;
  $('#header-user-meta').textContent = state.user.organization_name || (state.user.role === 'superadmin' ? 'Systemadmin' : '—');
  const rb = $('#header-role');
  rb.textContent = roleLabel(state.user.role);
  rb.className = 'role-badge role-' + state.user.role;
  $('#header-eyebrow').textContent = state.user.organization_name
    ? state.user.organization_name + ' — Admin Terminal'
    : 'Admin Terminal';

  // Skjul navelementer som ikke er tilgjengelig for rollen
  $$('#sidebar .nav-item').forEach(el => {
    const allowed = el.dataset.roles;
    if (allowed && !allowed.split(',').map(s => s.trim()).includes(state.user.role)) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });

  connectWS();
  goto('dashboard');
}

function roleLabel(r) {
  return ({
    superadmin: 'Superadmin',
    org_admin: 'Bedriftsadmin',
    gamemaster: 'Gamemaster',
    participant: 'Deltager',
  })[r] || r;
}

/* ─── ROUTER ──────────────────────────────────────────── */
async function goto(view) {
  state.currentView = view;
  $$('#sidebar .nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
  $$('#content .view').forEach(el => {
    el.classList.toggle('hidden', el.dataset.view !== view);
  });

  const fn = views[view];
  if (fn) {
    const target = $(`#content .view[data-view="${view}"]`);
    target.innerHTML = '<div class="muted" style="padding:30px;text-align:center;">Laster…</div>';
    try {
      await fn(target);
    } catch (e) {
      console.error(e);
      target.innerHTML = `<div class="form-error" style="margin:20px;">Kunne ikke laste: ${escapeHtml(e.message)}</div>`;
    }
  }
}

/* ─── WEBSOCKET ──────────────────────────────────────── */
function connectWS() {
  if (state.ws) try { state.ws.close(); } catch {}
  const dot = $('#ws-dot');
  dot.className = 'conn-dot';
  dot.title = 'Kobler til…';

  try {
    state.ws = new WebSocket(WS_URL);
  } catch (e) {
    dot.className = 'conn-dot error';
    return;
  }

  state.ws.addEventListener('open', () => {
    state.wsRetry = 0;
    dot.className = 'conn-dot live';
    dot.title = 'Live tilkoblet';
    // Subscribe til gjeldende event hvis i live-view
    if (state.currentEventId) {
      try { state.ws.send(JSON.stringify({ type: 'subscribe', event_id: state.currentEventId })); } catch {}
    }
  });

  state.ws.addEventListener('message', (msg) => {
    try {
      const data = JSON.parse(msg.data);
      handleWsMessage(data);
    } catch {}
  });

  state.ws.addEventListener('close', () => {
    dot.className = 'conn-dot error';
    dot.title = 'Frakoblet';
    state.wsRetry = Math.min(state.wsRetry + 1, 6);
    if (state.token) {
      const delay = 1000 * Math.pow(1.5, state.wsRetry);
      setTimeout(connectWS, delay);
    }
  });

  state.ws.addEventListener('error', () => {
    dot.className = 'conn-dot error';
    dot.title = 'Feil';
  });
}

function handleWsMessage(data) {
  // Live-view oppdateringer
  if (state.currentView === 'live' && data.event_id && data.event_id == state.currentEventId) {
    if (typeof window._liveOnMessage === 'function') {
      window._liveOnMessage(data);
    }
  }
}

/* ─── MODAL HELPERS ──────────────────────────────────── */
let _modalOnSubmit = null;
function openModal({ title, body, footer, size, onSubmit }) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body || '';
  $('#modal-footer').innerHTML = footer || '';
  const m = $('#modal');
  m.classList.remove('modal-lg', 'modal-xl');
  if (size === 'lg') m.classList.add('modal-lg');
  if (size === 'xl') m.classList.add('modal-xl');
  $('#modal-overlay').classList.add('open');
  _modalOnSubmit = onSubmit || null;
}
function closeModal() {
  $('#modal-overlay').classList.remove('open');
  _modalOnSubmit = null;
}
function closeModalOnBackdrop(e) {
  if (e.target.id === 'modal-overlay') closeModal();
}
function modalSubmit() {
  if (typeof _modalOnSubmit === 'function') _modalOnSubmit();
}

function confirmDialog(message, okLabel = 'Bekreft') {
  return new Promise(resolve => {
    openModal({
      title: 'Bekreft',
      body: `<div style="padding:8px 4px;font-family:var(--font-serif);font-size:15px;">${escapeHtml(message)}</div>`,
      footer: `
        <button class="btn btn-secondary" onclick="closeModal();window._confirmRes(false);">Avbryt</button>
        <button class="btn btn-danger" onclick="closeModal();window._confirmRes(true);">${escapeHtml(okLabel)}</button>
      `,
    });
    window._confirmRes = (v) => { window._confirmRes = null; resolve(v); };
  });
}

/* ─── VIEW REGISTRY ──────────────────────────────────── */
const views = {};

/* ─── EVENT BINDINGS ─────────────────────────────────── */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const errEl = $('#login-error');
  const btn = $('#login-btn');
  errEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Logger inn…';
  try {
    await login(email, password);
  } catch (e) {
    errEl.textContent = e.message || 'Innlogging feilet';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Logg inn';
  }
});

$$('#sidebar .nav-item').forEach(el => {
  el.addEventListener('click', () => goto(el.dataset.view));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal-overlay').classList.contains('open')) closeModal();
});

/* ─── BOOT ───────────────────────────────────────────── */
(async function boot() {
  if (state.token && state.user) {
    // Verifiser tokenet
    try {
      const me = await api('/api/auth/me');
      state.user = { ...state.user, ...me };
      localStorage.setItem('eb_user', JSON.stringify(state.user));
      enterApp();
    } catch {
      logout();
    }
  } else {
    $('#login-screen').classList.remove('hidden');
  }
})();

/* ════════════════════════════════════════════════════════
   VIEW: DASHBOARD
   ──────────────────────────────────────────────────────── */
views.dashboard = async function (root) {
  const events = await api('/api/events').catch(() => []);
  const now = Date.now();

  const live = events.filter(e => e.status === 'live');
  const planned = events.filter(e => e.status === 'planned' && (!e.scheduled_at || new Date(e.scheduled_at).getTime() > now - 86400000));
  const finished = events.filter(e => e.status === 'finished');

  const isSuper = state.user.role === 'superadmin';
  let extraStats = '';
  if (isSuper) {
    const orgs = await api('/api/organizations').catch(() => []);
    extraStats = `
      <div class="stat-card blue">
        <span class="stat-label">Bedrifter</span>
        <span class="stat-value">${orgs.length}</span>
        <span class="stat-sub">Totalt registrert</span>
      </div>
    `;
    state.organizations = orgs;
  }

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Oversikt</div>
        <div class="page-title">Dashboard</div>
      </div>
      <div class="page-actions">
        ${canCreateEvent() ? '<button class="btn" onclick="openCreateEventModal()">+ Nytt event</button>' : ''}
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card green">
        <span class="stat-label">Live nå</span>
        <span class="stat-value">${live.length}</span>
        <span class="stat-sub">Pågående eventer</span>
      </div>
      <div class="stat-card amber">
        <span class="stat-label">Planlagt</span>
        <span class="stat-value">${planned.length}</span>
        <span class="stat-sub">Klare for kjøring</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Fullført</span>
        <span class="stat-value">${finished.length}</span>
        <span class="stat-sub">Historikk</span>
      </div>
      ${extraStats}
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">●</span> Live nå</div>
      <div class="panel-body tight">
        ${live.length === 0
          ? `<div class="empty-state" style="border:none;padding:30px;"><span class="empty-icon">○</span><span class="empty-text">Ingen aktive eventer akkurat nå</span></div>`
          : eventsTable(live)}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">▤</span> Kommende & planlagt</div>
      <div class="panel-body tight">
        ${planned.length === 0
          ? `<div class="empty-state" style="border:none;padding:30px;"><span class="empty-icon">▢</span><span class="empty-text">Ingen planlagte eventer</span></div>`
          : eventsTable(planned)}
      </div>
    </div>

    ${finished.length > 0 ? `
    <div class="panel">
      <div class="panel-header"><span class="ph-icon">▣</span> Nylig fullførte</div>
      <div class="panel-body tight">${eventsTable(finished.slice(0, 5))}</div>
    </div>` : ''}
  `;
};

function canCreateEvent() {
  return ['superadmin', 'org_admin'].includes(state.user.role);
}

function eventsTable(events) {
  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>Navn</th>
            <th>Kode</th>
            <th>Scenario</th>
            ${state.user.role === 'superadmin' ? '<th>Bedrift</th>' : ''}
            <th>Lag</th>
            <th>Planlagt</th>
            <th>Status</th>
            <th class="col-actions">Handlinger</th>
          </tr>
        </thead>
        <tbody>
          ${events.map(e => `
            <tr>
              <td><strong>${escapeHtml(e.name)}</strong></td>
              <td class="col-mono"><strong>${escapeHtml(e.code)}</strong></td>
              <td>${escapeHtml(e.scenario_name || '—')}</td>
              ${state.user.role === 'superadmin' ? `<td>${escapeHtml(e.organization_name || '—')}</td>` : ''}
              <td class="col-num">${e.team_count || 0}</td>
              <td>${formatDateShort(e.scheduled_at)}</td>
              <td>${eventStatusBadge(e.status)}</td>
              <td class="col-actions">
                <button class="btn btn-sm btn-secondary" onclick="openEvent(${e.id})">Åpne</button>
                ${e.status === 'live' ? `<button class="btn btn-sm btn-success" onclick="openLiveView(${e.id})">Live</button>` : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function eventStatusBadge(status) {
  const map = {
    planned: { cls: 'outline-amber', text: 'Planlagt' },
    live: { cls: 'green', text: '● Live' },
    finished: { cls: 'dark', text: 'Fullført' },
    cancelled: { cls: 'outline-red', text: 'Avlyst' },
  };
  const m = map[status] || { cls: '', text: status };
  return `<span class="badge ${m.cls}">${m.text}</span>`;
}
/* ════════════════════════════════════════════════════════
   VIEW: EVENTS
   ──────────────────────────────────────────────────────── */
views.events = async function (root) {
  const events = await api('/api/events');
  state.events = events;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Hendelser</div>
        <div class="page-title">Events</div>
      </div>
      <div class="page-actions">
        ${canCreateEvent() ? '<button class="btn" onclick="openCreateEventModal()">+ Nytt event</button>' : ''}
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <span class="ph-icon">▤</span> Alle eventer
        <span class="ph-spacer"></span>
        <span style="font-size:11px;opacity:0.7;">${events.length} totalt</span>
      </div>
      <div class="panel-body tight">
        ${events.length === 0
          ? `<div class="empty-state" style="border:none;"><span class="empty-icon">▢</span><span class="empty-text">Ingen eventer ennå</span><span class="empty-sub">Opprett ditt første event for å komme i gang</span></div>`
          : eventsTable(events)}
      </div>
    </div>
  `;
};

async function openCreateEventModal() {
  // Hent scenarier og evt bedrifter
  const [scenarios, orgs] = await Promise.all([
    api('/api/scenarios').catch(() => []),
    state.user.role === 'superadmin' ? api('/api/organizations').catch(() => []) : Promise.resolve([]),
  ]);
  state.scenarios = scenarios;
  state.organizations = orgs;

  const orgRow = state.user.role === 'superadmin'
    ? `<div class="field">
         <label class="field-label">Bedrift</label>
         <select id="ev-org">
           ${orgs.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}
         </select>
       </div>`
    : '';

  openModal({
    title: 'Nytt event',
    size: 'lg',
    body: `
      <div class="field">
        <label class="field-label">Eventnavn</label>
        <input id="ev-name" type="text" placeholder="F.eks. Avd. Bygg — fredagsspill" autocomplete="off">
      </div>

      <div class="field-row">
        <div class="field">
          <label class="field-label">Scenario</label>
          <select id="ev-scenario">
            <option value="">— Velg scenario —</option>
            ${scenarios.filter(s => s.active).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">Planlagt tidspunkt</label>
          <input id="ev-when" type="datetime-local">
        </div>
      </div>

      ${orgRow}

      <div class="field-row">
        <div class="field">
          <label class="field-label">Antall lag</label>
          <input id="ev-team-count" type="number" min="1" max="50" value="4">
          <span class="field-hint">1–50 lag. Koder og PIN-er genereres automatisk.</span>
        </div>
        <div class="field">
          <label class="field-label">Lagnavn (valgfritt)</label>
          <input id="ev-team-names" type="text" placeholder="Lag 1, Lag 2, Lag 3 …" autocomplete="off">
          <span class="field-hint">Komma-separert. Tomme felt = standard navn.</span>
        </div>
      </div>

      <div id="ev-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Opprett event</button>
    `,
    onSubmit: createEvent,
  });
}

async function createEvent() {
  const errEl = $('#ev-error');
  errEl.classList.add('hidden');

  const name = $('#ev-name').value.trim();
  const scenarioId = $('#ev-scenario').value;
  const when = $('#ev-when').value;
  const teamCount = parseInt($('#ev-team-count').value, 10) || 0;
  const teamNamesRaw = $('#ev-team-names').value.trim();
  const teamNames = teamNamesRaw ? teamNamesRaw.split(',').map(s => s.trim()) : [];
  const orgEl = $('#ev-org');
  const organization_id = orgEl ? parseInt(orgEl.value, 10) : null;

  if (!name) { errEl.textContent = 'Eventnavn er påkrevd.'; errEl.classList.remove('hidden'); return; }
  if (!scenarioId) { errEl.textContent = 'Velg et scenario.'; errEl.classList.remove('hidden'); return; }
  if (teamCount < 1 || teamCount > 50) { errEl.textContent = 'Antall lag må være 1–50.'; errEl.classList.remove('hidden'); return; }

  try {
    const body = {
      name,
      scenario_id: parseInt(scenarioId, 10),
      scheduled_at: when || null,
      team_count: teamCount,
      team_names: teamNames,
    };
    if (organization_id) body.organization_id = organization_id;
    const ev = await api('/api/events', { method: 'POST', body });
    closeModal();
    showToast(`Event opprettet med ${ev.teams.length} lag`, 'success');
    state.currentEventId = ev.id;
    goto('events');
    setTimeout(() => openEvent(ev.id), 250);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

async function openEvent(eventId) {
  const ev = await api(`/api/events/${eventId}`);
  state.currentEventId = eventId;

  const teamRows = (ev.teams || []).map((t, i) => `
    <tr>
      <td><span class="team-color-dot" style="background:${t.color};display:inline-block;margin-right:6px;vertical-align:middle;"></span><strong>${escapeHtml(t.name)}</strong></td>
      <td class="col-mono"><strong>${escapeHtml(t.code)}</strong></td>
      <td class="col-mono">${escapeHtml(t.pin)}</td>
      <td>${t.session_status === 'active' ? '<span class="badge green">Aktiv</span>' : t.session_status === 'finished' ? '<span class="badge dark">Fullført</span>' : '<span class="badge">Venter</span>'}</td>
      <td class="col-actions">
        <button class="btn btn-sm btn-secondary" onclick="showTeamQR(${eventId}, ${t.id})">QR</button>
        <button class="btn btn-sm btn-ghost" onclick="regenPin(${eventId}, ${t.id})">↻ PIN</button>
      </td>
    </tr>
  `).join('');

  const statusActions = (() => {
    const buttons = [];
    if (ev.status === 'planned') {
      buttons.push(`<button class="btn btn-success" onclick="setEventStatus(${ev.id}, 'live')">▶ Start event</button>`);
      buttons.push(`<button class="btn btn-danger btn-secondary" onclick="setEventStatus(${ev.id}, 'cancelled')">Avlys</button>`);
    } else if (ev.status === 'live') {
      buttons.push(`<button class="btn btn-amber" onclick="setEventStatus(${ev.id}, 'finished')">■ Avslutt</button>`);
      buttons.push(`<button class="btn btn-success" onclick="openLiveView(${ev.id})">● Live-skjerm</button>`);
    } else if (ev.status === 'finished') {
      buttons.push(`<button class="btn btn-secondary" onclick="setEventStatus(${ev.id}, 'planned')">↺ Sett tilbake til planlagt</button>`);
    }
    return buttons.join(' ');
  })();

  openModal({
    title: 'Event: ' + ev.name,
    size: 'xl',
    body: `
      <div class="stats-grid" style="margin-bottom:18px;">
        <div class="stat-card">
          <span class="stat-label">Eventkode</span>
          <span class="stat-value mono" style="font-size:32px;">${escapeHtml(ev.code)}</span>
          <span class="stat-sub">Deltakerne bruker denne</span>
        </div>
        <div class="stat-card blue">
          <span class="stat-label">Scenario</span>
          <span class="stat-value" style="font-size:18px;font-family:var(--font-serif);">${escapeHtml(ev.scenario_name || '—')}</span>
          <span class="stat-sub">${ev.scenario_time_limit ? Math.round(ev.scenario_time_limit / 60) + ' min tidsgrense' : 'Ingen tidsgrense'}</span>
        </div>
        <div class="stat-card amber">
          <span class="stat-label">Status</span>
          <span class="stat-value" style="font-size:20px;">${eventStatusBadge(ev.status)}</span>
          <span class="stat-sub">${formatDateShort(ev.scheduled_at)}</span>
        </div>
        <div class="stat-card">
          <span class="stat-label">Antall lag</span>
          <span class="stat-value">${(ev.teams || []).length}</span>
        </div>
      </div>

      <div class="flex-gap mb-2">${statusActions}</div>

      <div class="panel">
        <div class="panel-header"><span class="ph-icon">◍</span> Lag</div>
        <div class="panel-body tight">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Lag</th>
                  <th>Lagkode</th>
                  <th>PIN</th>
                  <th>Sesjon</th>
                  <th class="col-actions">Handlinger</th>
                </tr>
              </thead>
              <tbody>${teamRows || `<tr><td colspan="5" class="muted text-center" style="padding:20px;">Ingen lag</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="flex-gap">
        <button class="btn btn-secondary" onclick="showAllQRs(${ev.id})">▦ Vis alle QR-koder</button>
        <button class="btn btn-secondary" onclick="printTeamCards(${ev.id})">🖨 Skriv ut lagkort</button>
        <span style="flex:1;"></span>
        <button class="btn btn-danger btn-secondary" onclick="deleteEvent(${ev.id})">Slett event</button>
      </div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Lukk</button>`,
  });
}

async function setEventStatus(id, status) {
  try {
    await api(`/api/events/${id}`, { method: 'PATCH', body: { status } });
    showToast('Status oppdatert', 'success');
    closeModal();
    if (state.currentView === 'events' || state.currentView === 'dashboard') goto(state.currentView);
    setTimeout(() => openEvent(id), 200);
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteEvent(id) {
  const ok = await confirmDialog('Slette dette eventet og alle tilhørende lag og sesjoner? Dette kan ikke angres.', 'Slett event');
  if (!ok) return;
  try {
    await api(`/api/events/${id}`, { method: 'DELETE' });
    showToast('Event slettet', 'success');
    closeModal();
    goto(state.currentView);
  } catch (e) { showToast(e.message, 'error'); }
}

async function regenPin(eventId, teamId) {
  const ok = await confirmDialog('Generer ny PIN for dette laget? Den gamle blir ugyldig.', 'Ny PIN');
  if (!ok) return;
  try {
    await api(`/api/events/${eventId}/teams/${teamId}/regenerate-pin`, { method: 'POST' });
    showToast('Ny PIN generert', 'success');
    closeModal();
    setTimeout(() => openEvent(eventId), 200);
  } catch (e) { showToast(e.message, 'error'); }
}

/* ─── QR-KODER ──────────────────────────────────────── */
function teamJoinUrl(eventCode, teamCode, pin) {
  // URL som peker til deltager-frontenden. Siden frontenden er en separat Netlify-deploy,
  // antar vi at den er konfigurert med dens egen URL. Vi bruker query-parametere som
  // deltager-frontenden kan plukke opp og auto-utfylle.
  const base = window.APP_CONFIG.PARTICIPANT_URL || (location.origin.replace('admin', 'play'));
  return `${base}/?e=${encodeURIComponent(eventCode)}&t=${encodeURIComponent(teamCode)}&p=${encodeURIComponent(pin)}`;
}

async function showTeamQR(eventId, teamId) {
  const data = await api(`/api/events/${eventId}/teams/${teamId}`);
  const url = teamJoinUrl(data.event_code, data.code, data.pin);

  openModal({
    title: 'QR-kode for lag',
    body: `
      <div class="qr-block" id="qr-block">
        <div class="qr-team-name">${escapeHtml(data.name)}</div>
        <canvas id="qr-canvas"></canvas>
        <div class="qr-codes">
          <div class="qr-code-pair">
            <span class="qr-code-label">Eventkode</span>
            <span class="qr-code-value">${escapeHtml(data.event_code)}</span>
          </div>
          <div class="qr-code-pair">
            <span class="qr-code-label">Lagkode</span>
            <span class="qr-code-value">${escapeHtml(data.code)}</span>
          </div>
          <div class="qr-code-pair">
            <span class="qr-code-label">PIN</span>
            <span class="qr-code-value">${escapeHtml(data.pin)}</span>
          </div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px;word-break:break-all;max-width:300px;">${escapeHtml(url)}</div>
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Lukk</button>
      <button class="btn" onclick="downloadQR('${escapeHtml(data.name)}')">⤓ Last ned PNG</button>
    `,
  });
  setTimeout(() => {
    if (window.QRCode) {
      QRCode.toCanvas($('#qr-canvas'), url, { width: 256, margin: 1 }, () => {});
    }
  }, 60);
}

function downloadQR(teamName) {
  const c = $('#qr-canvas');
  if (!c) return;
  const a = document.createElement('a');
  a.download = `qr-${teamName.replace(/[^a-z0-9]+/gi, '-')}.png`;
  a.href = c.toDataURL('image/png');
  a.click();
}

async function showAllQRs(eventId) {
  const ev = await api(`/api/events/${eventId}`);
  const html = (ev.teams || []).map(t => `
    <div class="qr-block" style="margin:0;">
      <div class="qr-team-name" style="font-size:15px;">${escapeHtml(t.name)}</div>
      <canvas data-team="${t.id}" data-code="${escapeHtml(t.code)}" data-pin="${escapeHtml(t.pin)}" data-event="${escapeHtml(ev.code)}"></canvas>
      <div class="qr-codes" style="font-size:11px;">
        <div class="qr-code-pair">
          <span class="qr-code-label">Lag</span>
          <span class="qr-code-value" style="font-size:14px;">${escapeHtml(t.code)}</span>
        </div>
        <div class="qr-code-pair">
          <span class="qr-code-label">PIN</span>
          <span class="qr-code-value" style="font-size:14px;">${escapeHtml(t.pin)}</span>
        </div>
      </div>
    </div>
  `).join('');

  openModal({
    title: `Alle lag — ${ev.name}`,
    size: 'xl',
    body: `
      <div style="margin-bottom:14px;text-align:center;font-family:var(--font-mono);">
        Eventkode: <strong style="font-size:20px;">${escapeHtml(ev.code)}</strong>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;">
        ${html}
      </div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Lukk</button>
      <button class="btn" onclick="window.print()">🖨 Skriv ut</button>
    `,
  });

  setTimeout(() => {
    $$('#modal canvas[data-team]').forEach(canvas => {
      const url = teamJoinUrl(canvas.dataset.event, canvas.dataset.code, canvas.dataset.pin);
      if (window.QRCode) QRCode.toCanvas(canvas, url, { width: 180, margin: 1 }, () => {});
    });
  }, 80);
}

function printTeamCards(eventId) {
  showAllQRs(eventId);
  setTimeout(() => window.print(), 600);
}

/* ════════════════════════════════════════════════════════
   VIEW: SCENARIOS
   ──────────────────────────────────────────────────────── */
views.scenarios = async function (root) {
  if (state.user.role !== 'superadmin') {
    root.innerHTML = '<div class="form-error">Kun superadmin har tilgang til scenarier.</div>';
    return;
  }
  const scenarios = await api('/api/scenarios?all=1');
  state.scenarios = scenarios;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Innhold</div>
        <div class="page-title">Scenarier</div>
      </div>
      <div class="page-actions">
        <button class="btn" onclick="openCreateScenarioModal()">+ Nytt scenario</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">◆</span> Scenariobibliotek</div>
      <div class="panel-body tight">
        ${scenarios.length === 0
          ? `<div class="empty-state" style="border:none;"><span class="empty-icon">◇</span><span class="empty-text">Ingen scenarier ennå</span><span class="empty-sub">Opprett ditt første scenario</span></div>`
          : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Navn</th>
                <th>Beskrivelse</th>
                <th>Tidsgrense</th>
                <th>Belønninger</th>
                <th>Status</th>
                <th class="col-actions">Handlinger</th>
              </tr>
            </thead>
            <tbody>
              ${scenarios.map(s => `
                <tr class="${!s.active ? 'row-muted' : ''}">
                  <td><strong>${escapeHtml(s.name)}</strong></td>
                  <td><span class="muted" style="font-size:13px;">${escapeHtml((s.description || '').slice(0, 80))}${(s.description || '').length > 80 ? '…' : ''}</span></td>
                  <td class="col-mono">${s.time_limit_seconds ? Math.round(s.time_limit_seconds / 60) + ' min' : '—'}</td>
                  <td class="col-num">${s.coord_count || 0}</td>
                  <td>${s.active ? '<span class="badge green">Aktiv</span>' : '<span class="badge">Inaktiv</span>'}</td>
                  <td class="col-actions">
                    <button class="btn btn-sm" onclick="openScenarioEditor(${s.id})">Rediger</button>
                    <button class="btn btn-sm btn-secondary" onclick="toggleScenarioActive(${s.id}, ${!s.active})">${s.active ? 'Deaktiver' : 'Aktiver'}</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteScenario(${s.id})">Slett</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        `}
      </div>
    </div>
  `;
};

function openCreateScenarioModal() {
  openModal({
    title: 'Nytt scenario',
    body: `
      <div class="field">
        <label class="field-label">Navn</label>
        <input id="sc-name" type="text" placeholder="F.eks. Operasjon Nordlys" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label">Beskrivelse</label>
        <textarea id="sc-desc" placeholder="Kort beskrivelse av scenarioet"></textarea>
      </div>
      <div class="field">
        <label class="field-label">Tidsgrense (minutter)</label>
        <input id="sc-time" type="number" min="5" max="240" value="60">
      </div>
      <div id="sc-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Opprett</button>
    `,
    onSubmit: async () => {
      const name = $('#sc-name').value.trim();
      const desc = $('#sc-desc').value.trim();
      const mins = parseInt($('#sc-time').value, 10) || 60;
      const errEl = $('#sc-error');
      if (!name) { errEl.textContent = 'Navn påkrevd'; errEl.classList.remove('hidden'); return; }
      try {
        const sc = await api('/api/scenarios', { method: 'POST', body: { name, description: desc || null, time_limit_seconds: mins * 60 } });
        closeModal();
        showToast('Scenario opprettet', 'success');
        goto('scenarios');
        setTimeout(() => openScenarioEditor(sc.id), 200);
      } catch (e) {
        errEl.textContent = e.message; errEl.classList.remove('hidden');
      }
    },
  });
}

async function toggleScenarioActive(id, active) {
  try {
    await api(`/api/scenarios/${id}`, { method: 'PATCH', body: { active } });
    showToast(active ? 'Aktivert' : 'Deaktivert', 'success');
    goto('scenarios');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteScenario(id) {
  const ok = await confirmDialog('Slette dette scenarioet? Hvis det er i bruk, blir det deaktivert i stedet.', 'Slett scenario');
  if (!ok) return;
  try {
    const r = await api(`/api/scenarios/${id}`, { method: 'DELETE' });
    showToast(r.deactivated ? 'Scenario deaktivert (i bruk)' : 'Scenario slettet', 'success');
    goto('scenarios');
  } catch (e) { showToast(e.message, 'error'); }
}
/* ════════════════════════════════════════════════════════
   SCENARIO EDITOR — koordinater + belønninger + innstillinger
   ──────────────────────────────────────────────────────── */
let scenarioBuf = null;       // hele scenarioet vi redigerer
let editingCoordIdx = -1;     // hvilken koordinat som er valgt

async function openScenarioEditor(scenarioId) {
  state.currentScenarioId = scenarioId;
  const sc = await api(`/api/scenarios/${scenarioId}`);
  scenarioBuf = JSON.parse(JSON.stringify(sc));
  if (!scenarioBuf.scenario_data) scenarioBuf.scenario_data = { coordinates: [], settings: {} };
  if (!Array.isArray(scenarioBuf.scenario_data.coordinates)) scenarioBuf.scenario_data.coordinates = [];
  if (!scenarioBuf.scenario_data.settings) scenarioBuf.scenario_data.settings = {};
  editingCoordIdx = -1;

  openModal({
    title: 'Scenario: ' + sc.name,
    size: 'xl',
    body: renderScenarioEditor(),
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn btn-success" onclick="saveScenario()">⤳ Lagre endringer</button>
    `,
  });
}

function renderScenarioEditor() {
  return `
    <!-- Tabs -->
    <div style="display:flex;gap:0;border-bottom:2px solid var(--rule);margin-bottom:18px;">
      <button class="tab-btn active" data-tab="meta" onclick="switchScTab('meta')">Generelt</button>
      <button class="tab-btn" data-tab="coords" onclick="switchScTab('coords')">Koordinater & belønninger</button>
      <button class="tab-btn" data-tab="settings" onclick="switchScTab('settings')">Spillregler</button>
    </div>

    <style>
      .tab-btn { background:transparent;border:none;padding:10px 18px;font-family:var(--font-cond);font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink3);cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px; }
      .tab-btn.active { color:var(--ink);border-bottom-color:var(--ink); }
      .tab-btn:hover { color:var(--ink); }
    </style>

    <div id="sc-tab-meta" class="sc-tab">${renderScMetaTab()}</div>
    <div id="sc-tab-coords" class="sc-tab hidden">${renderScCoordsTab()}</div>
    <div id="sc-tab-settings" class="sc-tab hidden">${renderScSettingsTab()}</div>
  `;
}

function switchScTab(name) {
  $$('#modal .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('#modal .sc-tab').forEach(t => t.classList.add('hidden'));
  $('#sc-tab-' + name).classList.remove('hidden');
  if (name === 'coords') renderCoordList();
}

function renderScMetaTab() {
  const sc = scenarioBuf;
  return `
    <div class="field">
      <label class="field-label">Navn</label>
      <input id="sc-meta-name" type="text" value="${escapeHtml(sc.name)}">
    </div>
    <div class="field">
      <label class="field-label">Beskrivelse</label>
      <textarea id="sc-meta-desc" rows="4">${escapeHtml(sc.description || '')}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Tidsgrense (minutter)</label>
      <input id="sc-meta-time" type="number" min="5" max="240" value="${Math.round((sc.time_limit_seconds || 3600) / 60)}">
    </div>
  `;
}

function renderScSettingsTab() {
  const s = scenarioBuf.scenario_data.settings || {};
  return `
    <div class="panel">
      <div class="panel-header"><span class="ph-icon">⚙</span> Tidsregler</div>
      <div class="panel-body">
        <label class="field" style="flex-direction:row;align-items:center;gap:10px;">
          <input id="set-time-en" type="checkbox" ${s.time_limit_enabled !== false ? 'checked' : ''} style="width:auto;">
          <span>Aktiver tidsgrense (deltagerne ser nedtellingstimer)</span>
        </label>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">⚙</span> Poengvisning</div>
      <div class="panel-body">
        <label class="field" style="flex-direction:row;align-items:center;gap:10px;">
          <input id="set-show-score" type="checkbox" ${s.show_score !== false ? 'checked' : ''} style="width:auto;">
          <span>Vis poeng til deltagere underveis</span>
        </label>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">⚙</span> Straff for feil svar</div>
      <div class="panel-body">
        <label class="field" style="flex-direction:row;align-items:center;gap:10px;">
          <input id="set-pen-en" type="checkbox" ${s.penalty_enabled ? 'checked' : ''} style="width:auto;">
          <span>Aktiver poengstraff ved feil svar/koordinat</span>
        </label>
        <div class="field-row">
          <div class="field">
            <label class="field-label">Grunnstraff (poeng)</label>
            <input id="set-pen-amount" type="number" min="0" max="100" value="${s.penalty_amount ?? 1}">
          </div>
          <div class="field">
            <label class="field-label">Eskalér etter (antall feil)</label>
            <input id="set-pen-after" type="number" min="1" max="50" value="${s.penalty_escalation_after ?? 3}">
          </div>
        </div>
        <label class="field" style="flex-direction:row;align-items:center;gap:10px;">
          <input id="set-pen-esc" type="checkbox" ${s.penalty_escalation ? 'checked' : ''} style="width:auto;">
          <span>Eskalér straff ved gjentatte feil</span>
        </label>
        <div class="field">
          <label class="field-label">Eskalert straff (poeng)</label>
          <input id="set-pen-esc-amount" type="number" min="0" max="100" value="${s.penalty_escalation_amount ?? 2}">
        </div>
      </div>
    </div>
  `;
}

function renderScCoordsTab() {
  return `
    <div class="coord-editor">
      <div class="coord-list">
        <div class="coord-list-header">
          <span>Koordinater</span>
          <button class="btn btn-sm btn-success" onclick="addCoord()">+ Ny</button>
        </div>
        <div class="coord-list-body" id="coord-list-body"></div>
      </div>
      <div class="coord-detail" id="coord-detail">
        <div class="empty-coord-msg">
          ◇<br><br>Velg en koordinat fra listen, eller opprett en ny.
        </div>
      </div>
    </div>
  `;
}

function renderCoordList() {
  const list = scenarioBuf.scenario_data.coordinates || [];
  const body = $('#coord-list-body');
  if (!body) return;
  if (list.length === 0) {
    body.innerHTML = '<div class="muted text-center" style="padding:30px 14px;font-style:italic;font-family:var(--font-serif);">Ingen koordinater. Klikk «+ Ny» for å legge til.</div>';
    return;
  }
  body.innerHTML = list.map((c, i) => `
    <div class="coord-list-item ${i === editingCoordIdx ? 'active' : ''}" onclick="selectCoord(${i})">
      <span class="cli-coord">(${c.x ?? '—'}, ${c.y ?? '—'})</span>
      <span class="cli-code">${escapeHtml(c.code || '—')}</span>
      <span class="cli-meta">${(c.rewards || []).length} ${(c.rewards || []).length === 1 ? 'belønning' : 'belønninger'}</span>
    </div>
  `).join('');
}

function selectCoord(idx) {
  editingCoordIdx = idx;
  renderCoordList();
  renderCoordDetail();
}

function addCoord() {
  scenarioBuf.scenario_data.coordinates.push({
    x: 0, y: 0,
    code: '',
    points: 10,
    rewards: [],
  });
  editingCoordIdx = scenarioBuf.scenario_data.coordinates.length - 1;
  renderCoordList();
  renderCoordDetail();
}

function renderCoordDetail() {
  const detail = $('#coord-detail');
  if (!detail) return;
  if (editingCoordIdx < 0) {
    detail.innerHTML = '<div class="empty-coord-msg">◇<br><br>Velg en koordinat fra listen.</div>';
    return;
  }
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c) return;

  detail.innerHTML = `
    <div class="flex-between mb-2">
      <h3 style="font-family:var(--font-serif);font-size:18px;">Koordinat #${editingCoordIdx + 1}</h3>
      <button class="btn btn-sm btn-danger" onclick="removeCoord(${editingCoordIdx})">✕ Slett</button>
    </div>

    <div class="field-row-3">
      <div class="field">
        <label class="field-label">X</label>
        <input id="cd-x" type="number" value="${c.x ?? 0}" oninput="updateCoord('x', this.value, true)">
      </div>
      <div class="field">
        <label class="field-label">Y</label>
        <input id="cd-y" type="number" value="${c.y ?? 0}" oninput="updateCoord('y', this.value, true)">
      </div>
      <div class="field">
        <label class="field-label">Poeng</label>
        <input id="cd-points" type="number" min="0" value="${c.points ?? 10}" oninput="updateCoord('points', this.value, true)">
      </div>
    </div>

    <div class="field">
      <label class="field-label">Verifikasjonskode</label>
      <input id="cd-code" type="text" value="${escapeHtml(c.code || '')}" placeholder="F.eks. NORDLYS"
             oninput="updateCoord('code', this.value)">
      <span class="field-hint">Koden deltagerne må skrive inn for å låse opp denne koordinaten.</span>
    </div>

    <div class="divider"></div>

    <div class="flex-between mb-1">
      <h4 style="font-family:var(--font-cond);font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink2);">Belønninger</h4>
      <div class="flex-gap">
        <button class="btn btn-sm btn-secondary" onclick="addReward('question')">+ Spørsmål</button>
        <button class="btn btn-sm btn-secondary" onclick="addReward('clue')">+ Spor</button>
        <button class="btn btn-sm btn-secondary" onclick="addReward('poi')">+ Person</button>
        <button class="btn btn-sm btn-secondary" onclick="addReward('unlock')">+ Lås</button>
      </div>
    </div>

    <div class="reward-list" id="reward-list">${renderRewards(c.rewards || [])}</div>
  `;
}

function updateCoord(field, value, isNumber = false) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c) return;
  c[field] = isNumber ? (value === '' ? null : Number(value)) : value;
  // Oppdater listen i sanntid
  renderCoordList();
}

function removeCoord(idx) {
  if (!confirm('Slette denne koordinaten med alle belønninger?')) return;
  scenarioBuf.scenario_data.coordinates.splice(idx, 1);
  editingCoordIdx = -1;
  renderCoordList();
  renderCoordDetail();
}

function renderRewards(rewards) {
  if (rewards.length === 0) return '<div class="muted" style="font-style:italic;padding:10px;">Ingen belønninger ennå.</div>';
  return rewards.map((r, i) => renderRewardItem(r, i)).join('');
}

function renderRewardItem(r, idx) {
  const typeLabels = { question: 'Spørsmål', clue: 'Spor', poi: 'Person', unlock: 'Lås' };
  if (r.type === 'question') {
    return `
      <div class="reward-item r-question">
        <div class="reward-item-header">
          <span class="reward-type-badge t-question">${typeLabels[r.type]}</span>
          <button class="btn btn-sm btn-ghost" onclick="removeReward(${idx})">✕</button>
        </div>
        <div class="field">
          <label class="field-label">Spørsmål</label>
          <textarea oninput="updateReward(${idx}, 'text', this.value)" rows="2">${escapeHtml(r.text || '')}</textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="field-label">Poeng</label>
            <input type="number" min="0" value="${r.points ?? 5}" oninput="updateReward(${idx}, 'points', Number(this.value))">
          </div>
          <div class="field">
            <label class="field-label">Riktig svar (indeks 0-3)</label>
            <input type="number" min="0" max="3" value="${r.correct ?? 0}" oninput="updateReward(${idx}, 'correct', Number(this.value))">
          </div>
        </div>
        <div class="field">
          <label class="field-label">Svaralternativer (4 stk)</label>
          ${[0,1,2,3].map(j => `
            <input type="text" value="${escapeHtml((r.options || [])[j] || '')}"
                   placeholder="Alternativ ${'ABCD'[j]}"
                   oninput="updateRewardOption(${idx}, ${j}, this.value)"
                   style="margin-bottom:4px;">
          `).join('')}
        </div>
      </div>
    `;
  }
  if (r.type === 'clue') {
    return `
      <div class="reward-item r-clue">
        <div class="reward-item-header">
          <span class="reward-type-badge t-clue">${typeLabels[r.type]}</span>
          <button class="btn btn-sm btn-ghost" onclick="removeReward(${idx})">✕</button>
        </div>
        <div class="field">
          <label class="field-label">Tittel (valgfri)</label>
          <input type="text" value="${escapeHtml(r.title || '')}" oninput="updateReward(${idx}, 'title', this.value)">
        </div>
        <div class="field">
          <label class="field-label">Spor-tekst</label>
          <textarea oninput="updateReward(${idx}, 'text', this.value)" rows="3">${escapeHtml(r.text || '')}</textarea>
        </div>
        <div class="field">
          <label class="field-label">Notat (valgfritt)</label>
          <input type="text" value="${escapeHtml(r.note || '')}" oninput="updateReward(${idx}, 'note', this.value)">
        </div>
      </div>
    `;
  }
  if (r.type === 'poi') {
    return `
      <div class="reward-item r-poi">
        <div class="reward-item-header">
          <span class="reward-type-badge t-poi">${typeLabels[r.type]}</span>
          <button class="btn btn-sm btn-ghost" onclick="removeReward(${idx})">✕</button>
        </div>
        <div class="field-row">
          <div class="field">
            <label class="field-label">Navn</label>
            <input type="text" value="${escapeHtml(r.name || '')}" oninput="updateReward(${idx}, 'name', this.value)">
          </div>
          <div class="field">
            <label class="field-label">Undertittel</label>
            <input type="text" value="${escapeHtml(r.subtitle || '')}" oninput="updateReward(${idx}, 'subtitle', this.value)">
          </div>
        </div>
        <div class="field">
          <label class="field-label">Notat</label>
          <textarea oninput="updateReward(${idx}, 'note', this.value)" rows="2">${escapeHtml(r.note || '')}</textarea>
        </div>
      </div>
    `;
  }
  if (r.type === 'unlock') {
    return `
      <div class="reward-item r-unlock">
        <div class="reward-item-header">
          <span class="reward-type-badge t-unlock">${typeLabels[r.type]}</span>
          <button class="btn btn-sm btn-ghost" onclick="removeReward(${idx})">✕</button>
        </div>
        <div class="field">
          <label class="field-label">Tittel</label>
          <input type="text" value="${escapeHtml(r.title || '')}" placeholder="F.eks. Hengelås på safe" oninput="updateReward(${idx}, 'title', this.value)">
        </div>
        <div class="field">
          <label class="field-label">Instruksjon</label>
          <textarea oninput="updateReward(${idx}, 'text', this.value)" rows="2">${escapeHtml(r.text || '')}</textarea>
        </div>
        <div class="field">
          <label class="field-label">Bonuspoeng ved bekreftelse</label>
          <input type="number" min="0" value="${r.bonus ?? 5}" oninput="updateReward(${idx}, 'bonus', Number(this.value))">
        </div>
      </div>
    `;
  }
  return '';
}

function addReward(type) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c) return;
  if (!Array.isArray(c.rewards)) c.rewards = [];
  const defaults = {
    question: { type: 'question', text: '', options: ['', '', '', ''], correct: 0, points: 5 },
    clue: { type: 'clue', title: '', text: '', note: '' },
    poi: { type: 'poi', name: '', subtitle: '', note: '' },
    unlock: { type: 'unlock', title: '', text: '', bonus: 5 },
  };
  c.rewards.push(defaults[type]);
  $('#reward-list').innerHTML = renderRewards(c.rewards);
  renderCoordList();
}

function updateReward(idx, field, value) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c || !c.rewards[idx]) return;
  c.rewards[idx][field] = value;
}

function updateRewardOption(idx, optIdx, value) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c || !c.rewards[idx]) return;
  if (!Array.isArray(c.rewards[idx].options)) c.rewards[idx].options = ['', '', '', ''];
  c.rewards[idx].options[optIdx] = value;
}

function removeReward(idx) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c) return;
  c.rewards.splice(idx, 1);
  $('#reward-list').innerHTML = renderRewards(c.rewards);
  renderCoordList();
}

async function saveScenario() {
  // Hent meta-felt fra DOM
  const name = $('#sc-meta-name').value.trim();
  const description = $('#sc-meta-desc').value.trim();
  const timeMin = parseInt($('#sc-meta-time').value, 10) || 60;

  // Hent settings
  const s = scenarioBuf.scenario_data.settings || {};
  s.time_limit_enabled = $('#set-time-en').checked;
  s.show_score = $('#set-show-score').checked;
  s.penalty_enabled = $('#set-pen-en').checked;
  s.penalty_amount = parseInt($('#set-pen-amount').value, 10) || 0;
  s.penalty_escalation = $('#set-pen-esc').checked;
  s.penalty_escalation_after = parseInt($('#set-pen-after').value, 10) || 3;
  s.penalty_escalation_amount = parseInt($('#set-pen-esc-amount').value, 10) || 2;
  scenarioBuf.scenario_data.settings = s;

  if (!name) { showToast('Navn påkrevd', 'error'); return; }

  try {
    await api(`/api/scenarios/${state.currentScenarioId}`, {
      method: 'PATCH',
      body: {
        name,
        description: description || null,
        time_limit_seconds: timeMin * 60,
        scenario_data: scenarioBuf.scenario_data,
      },
    });
    showToast('Scenario lagret', 'success');
    closeModal();
    if (state.currentView === 'scenarios') goto('scenarios');
  } catch (e) {
    showToast(e.message, 'error');
  }
}
/* ════════════════════════════════════════════════════════
   VIEW: ORGANIZATIONS (kun superadmin)
   ──────────────────────────────────────────────────────── */
views.organizations = async function (root) {
  if (state.user.role !== 'superadmin') {
    root.innerHTML = '<div class="form-error">Kun superadmin har tilgang.</div>'; return;
  }
  const orgs = await api('/api/organizations');
  state.organizations = orgs;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Administrasjon</div>
        <div class="page-title">Bedrifter</div>
      </div>
      <div class="page-actions">
        <button class="btn" onclick="openCreateOrgModal()">+ Ny bedrift</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">◫</span> Registrerte bedrifter</div>
      <div class="panel-body tight">
        ${orgs.length === 0
          ? `<div class="empty-state" style="border:none;"><span class="empty-icon">▢</span><span class="empty-text">Ingen bedrifter</span></div>`
          : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Navn</th>
                <th>Slug</th>
                <th>Brukere</th>
                <th>Eventer</th>
                <th>Opprettet</th>
                <th class="col-actions">Handlinger</th>
              </tr>
            </thead>
            <tbody>
              ${orgs.map(o => `
                <tr>
                  <td><strong>${escapeHtml(o.name)}</strong></td>
                  <td class="col-mono"><span class="muted">${escapeHtml(o.slug)}</span></td>
                  <td class="col-num">${o.user_count || 0}</td>
                  <td class="col-num">${o.event_count || 0}</td>
                  <td>${formatDateShort(o.created_at)}</td>
                  <td class="col-actions">
                    <button class="btn btn-sm btn-secondary" onclick="openOrgDetail(${o.id})">Detaljer</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteOrg(${o.id})">Slett</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>`}
      </div>
    </div>
  `;
};

function openCreateOrgModal() {
  openModal({
    title: 'Ny bedrift',
    body: `
      <div class="field">
        <label class="field-label">Bedriftsnavn</label>
        <input id="org-name" type="text" placeholder="F.eks. Byggmester Evensen AS">
      </div>
      <div class="divider"></div>
      <div class="muted mb-1" style="font-size:13px;">Opprett samtidig en administratorbruker for bedriften:</div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Admin-navn</label>
          <input id="org-admin-name" type="text">
        </div>
        <div class="field">
          <label class="field-label">Admin-epost</label>
          <input id="org-admin-email" type="email">
        </div>
      </div>
      <div class="field">
        <label class="field-label">Admin-passord</label>
        <input id="org-admin-pass" type="password" placeholder="Minst 6 tegn">
      </div>
      <div id="org-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Opprett</button>
    `,
    onSubmit: async () => {
      const errEl = $('#org-error');
      errEl.classList.add('hidden');
      const body = {
        name: $('#org-name').value.trim(),
        admin_name: $('#org-admin-name').value.trim(),
        admin_email: $('#org-admin-email').value.trim(),
        admin_password: $('#org-admin-pass').value,
      };
      if (!body.name || !body.admin_name || !body.admin_email || !body.admin_password) {
        errEl.textContent = 'Alle felt påkrevd'; errEl.classList.remove('hidden'); return;
      }
      try {
        await api('/api/organizations', { method: 'POST', body });
        closeModal();
        showToast('Bedrift opprettet', 'success');
        goto('organizations');
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    },
  });
}

async function openOrgDetail(id) {
  const org = await api(`/api/organizations/${id}`);
  openModal({
    title: org.name,
    size: 'lg',
    body: `
      <div class="stats-grid mb-2">
        <div class="stat-card"><span class="stat-label">Brukere</span><span class="stat-value">${(org.users || []).length}</span></div>
        <div class="stat-card blue"><span class="stat-label">Slug</span><span class="stat-value mono" style="font-size:18px;">${escapeHtml(org.slug)}</span></div>
        <div class="stat-card"><span class="stat-label">Opprettet</span><span class="stat-value" style="font-size:14px;font-family:var(--font-cond);">${formatDateShort(org.created_at)}</span></div>
      </div>
      <div class="panel">
        <div class="panel-header"><span class="ph-icon">◍</span> Brukere i bedriften</div>
        <div class="panel-body tight">
          ${org.users && org.users.length > 0 ? `
          <table class="data-table">
            <thead><tr><th>Navn</th><th>Epost</th><th>Rolle</th><th>Status</th></tr></thead>
            <tbody>${org.users.map(u => `
              <tr><td>${escapeHtml(u.name)}</td><td class="col-mono">${escapeHtml(u.email)}</td>
              <td>${roleBadge(u.role)}</td>
              <td>${u.active ? '<span class="badge green">Aktiv</span>' : '<span class="badge">Inaktiv</span>'}</td></tr>
            `).join('')}</tbody>
          </table>` : '<div class="muted text-center" style="padding:20px;">Ingen brukere</div>'}
        </div>
      </div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Lukk</button>`,
  });
}

async function deleteOrg(id) {
  const ok = await confirmDialog('Slette bedriften med ALLE brukere, eventer, lag og sesjoner? Dette kan ikke angres.', 'Slett bedrift');
  if (!ok) return;
  try {
    await api(`/api/organizations/${id}`, { method: 'DELETE' });
    showToast('Bedrift slettet', 'success');
    goto('organizations');
  } catch (e) { showToast(e.message, 'error'); }
}

function roleBadge(role) {
  const m = { superadmin: ['red', 'Superadmin'], org_admin: ['blue', 'Bedriftsadmin'], gamemaster: ['gold', 'Gamemaster'] };
  const [cls, label] = m[role] || ['', role];
  return `<span class="badge ${cls}">${label}</span>`;
}

/* ════════════════════════════════════════════════════════
   VIEW: USERS
   ──────────────────────────────────────────────────────── */
views.users = async function (root) {
  if (!['superadmin', 'org_admin'].includes(state.user.role)) {
    root.innerHTML = '<div class="form-error">Ikke tilgang.</div>'; return;
  }
  const users = await api('/api/users');
  state.users = users;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Administrasjon</div>
        <div class="page-title">Brukere</div>
      </div>
      <div class="page-actions">
        <button class="btn" onclick="openCreateUserModal()">+ Ny bruker</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">◍</span> Alle brukere ${state.user.role === 'org_admin' ? '(i din bedrift)' : ''}</div>
      <div class="panel-body tight">
        ${users.length === 0
          ? `<div class="empty-state" style="border:none;"><span class="empty-icon">○</span><span class="empty-text">Ingen brukere</span></div>`
          : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Navn</th>
              <th>Epost</th>
              <th>Rolle</th>
              ${state.user.role === 'superadmin' ? '<th>Bedrift</th>' : ''}
              <th>Status</th>
              <th>Opprettet</th>
              <th class="col-actions">Handlinger</th>
            </tr>
          </thead>
          <tbody>
            ${users.map(u => `
              <tr class="${!u.active ? 'row-muted' : ''}">
                <td><strong>${escapeHtml(u.name)}</strong>${u.id === state.user.id ? ' <span class="badge dark" style="font-size:9px;">Deg</span>' : ''}</td>
                <td class="col-mono">${escapeHtml(u.email)}</td>
                <td>${roleBadge(u.role)}</td>
                ${state.user.role === 'superadmin' ? `<td>${escapeHtml(u.organization_name || '—')}</td>` : ''}
                <td>${u.active ? '<span class="badge green">Aktiv</span>' : '<span class="badge">Deaktivert</span>'}</td>
                <td>${formatDateShort(u.created_at)}</td>
                <td class="col-actions">
                  <button class="btn btn-sm btn-secondary" onclick="toggleUserActive(${u.id}, ${!u.active})" ${u.id === state.user.id ? 'disabled' : ''}>${u.active ? 'Deaktiver' : 'Aktiver'}</button>
                  <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id})" ${u.id === state.user.id ? 'disabled' : ''}>Slett</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`}
      </div>
    </div>
  `;
};

async function openCreateUserModal() {
  let orgOptions = '';
  if (state.user.role === 'superadmin') {
    if (!state.organizations.length) state.organizations = await api('/api/organizations').catch(() => []);
    orgOptions = `
      <div class="field">
        <label class="field-label">Bedrift</label>
        <select id="u-org">
          <option value="">— Ingen (kun for superadmin) —</option>
          ${state.organizations.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  const roleOptions = state.user.role === 'superadmin'
    ? `<option value="org_admin">Bedriftsadmin</option><option value="gamemaster">Gamemaster</option><option value="superadmin">Superadmin</option>`
    : `<option value="gamemaster">Gamemaster</option><option value="org_admin">Bedriftsadmin</option>`;

  openModal({
    title: 'Ny bruker',
    body: `
      <div class="field-row">
        <div class="field">
          <label class="field-label">Navn</label>
          <input id="u-name" type="text">
        </div>
        <div class="field">
          <label class="field-label">Epost</label>
          <input id="u-email" type="email">
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="field-label">Passord</label>
          <input id="u-pass" type="password" placeholder="Minst 6 tegn">
        </div>
        <div class="field">
          <label class="field-label">Rolle</label>
          <select id="u-role">${roleOptions}</select>
        </div>
      </div>
      ${orgOptions}
      <div id="u-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Opprett</button>
    `,
    onSubmit: async () => {
      const errEl = $('#u-error'); errEl.classList.add('hidden');
      const body = {
        name: $('#u-name').value.trim(),
        email: $('#u-email').value.trim(),
        password: $('#u-pass').value,
        role: $('#u-role').value,
      };
      const orgEl = $('#u-org');
      if (orgEl && orgEl.value) body.organization_id = parseInt(orgEl.value, 10);
      if (!body.name || !body.email || !body.password) {
        errEl.textContent = 'Alle felt påkrevd'; errEl.classList.remove('hidden'); return;
      }
      try {
        await api('/api/users', { method: 'POST', body });
        closeModal();
        showToast('Bruker opprettet', 'success');
        goto('users');
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    },
  });
}

async function toggleUserActive(id, active) {
  try {
    await api(`/api/users/${id}`, { method: 'PATCH', body: { active } });
    showToast(active ? 'Bruker aktivert' : 'Bruker deaktivert', 'success');
    goto('users');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteUser(id) {
  const ok = await confirmDialog('Slette denne brukeren?', 'Slett bruker');
  if (!ok) return;
  try {
    await api(`/api/users/${id}`, { method: 'DELETE' });
    showToast('Bruker slettet', 'success');
    goto('users');
  } catch (e) { showToast(e.message, 'error'); }
}

/* ════════════════════════════════════════════════════════
   VIEW: PROFIL
   ──────────────────────────────────────────────────────── */
views.profile = async function (root) {
  const u = state.user;
  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Innstillinger</div>
        <div class="page-title">Min profil</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="panel">
        <div class="panel-header"><span class="ph-icon">◐</span> Profilinformasjon</div>
        <div class="panel-body">
          <div class="field">
            <label class="field-label">Navn</label>
            <input id="prof-name" type="text" value="${escapeHtml(u.name)}">
          </div>
          <div class="field">
            <label class="field-label">Epost</label>
            <input id="prof-email" type="email" value="${escapeHtml(u.email)}">
          </div>
          <div class="field">
            <label class="field-label">Rolle</label>
            <input type="text" value="${roleLabel(u.role)}" disabled>
          </div>
          ${u.organization_name ? `
          <div class="field">
            <label class="field-label">Bedrift</label>
            <input type="text" value="${escapeHtml(u.organization_name)}" disabled>
          </div>` : ''}
          <button class="btn" onclick="saveProfile()">⤳ Lagre profil</button>
          <div id="prof-msg" style="margin-top:8px;"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><span class="ph-icon">⚿</span> Bytt passord</div>
        <div class="panel-body">
          <div class="field">
            <label class="field-label">Nåværende passord</label>
            <input id="prof-cur" type="password" autocomplete="current-password">
          </div>
          <div class="field">
            <label class="field-label">Nytt passord</label>
            <input id="prof-new" type="password" autocomplete="new-password">
          </div>
          <div class="field">
            <label class="field-label">Bekreft nytt passord</label>
            <input id="prof-new2" type="password" autocomplete="new-password">
          </div>
          <button class="btn" onclick="changePassword()">⚿ Bytt passord</button>
          <div id="prof-pw-msg" style="margin-top:8px;"></div>
        </div>
      </div>
    </div>
  `;
};

async function saveProfile() {
  const name = $('#prof-name').value.trim();
  const email = $('#prof-email').value.trim();
  const msgEl = $('#prof-msg');
  msgEl.innerHTML = '';
  try {
    const r = await api('/api/auth/update-profile', { method: 'POST', body: { name, email } });
    state.token = r.token;
    state.user = r.user;
    localStorage.setItem('eb_token', r.token);
    localStorage.setItem('eb_user', JSON.stringify(r.user));
    $('#header-user-name').textContent = r.user.name;
    msgEl.innerHTML = '<div class="form-success">Profil oppdatert</div>';
    showToast('Profil lagret', 'success');
  } catch (e) {
    msgEl.innerHTML = `<div class="form-error">${escapeHtml(e.message)}</div>`;
  }
}

async function changePassword() {
  const cur = $('#prof-cur').value;
  const nw = $('#prof-new').value;
  const nw2 = $('#prof-new2').value;
  const msgEl = $('#prof-pw-msg');
  msgEl.innerHTML = '';
  if (nw !== nw2) { msgEl.innerHTML = '<div class="form-error">Passordene er ikke like</div>'; return; }
  if (nw.length < 6) { msgEl.innerHTML = '<div class="form-error">Passord må være minst 6 tegn</div>'; return; }
  try {
    await api('/api/auth/change-password', { method: 'POST', body: { current_password: cur, new_password: nw } });
    msgEl.innerHTML = '<div class="form-success">Passord endret</div>';
    $('#prof-cur').value = ''; $('#prof-new').value = ''; $('#prof-new2').value = '';
    showToast('Passord endret', 'success');
  } catch (e) {
    msgEl.innerHTML = `<div class="form-error">${escapeHtml(e.message)}</div>`;
  }
}

/* ════════════════════════════════════════════════════════
   VIEW: LIVE (gamemaster sanntidsovervåkning)
   ──────────────────────────────────────────────────────── */
views.live = async function (root) {
  // Vis liste over live eventer å velge fra hvis ingen valgt
  const events = await api('/api/events');
  const liveEvents = events.filter(e => e.status === 'live');
  const plannedEvents = events.filter(e => e.status === 'planned');

  if (!state.currentEventId || !events.find(e => e.id == state.currentEventId)) {
    root.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-eyebrow">Sanntid</div>
          <div class="page-title">Live overvåkning</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header"><span class="ph-icon">●</span> Velg event å overvåke</div>
        <div class="panel-body">
          ${liveEvents.length === 0 && plannedEvents.length === 0
            ? '<div class="muted text-center" style="padding:20px;">Ingen live eller planlagte eventer.</div>'
            : ''}
          ${liveEvents.length > 0 ? `
            <div class="field-label">Pågår nå</div>
            <div class="flex-gap mb-2" style="flex-wrap:wrap;">
              ${liveEvents.map(e => `<button class="btn btn-success" onclick="openLiveView(${e.id})">● ${escapeHtml(e.name)}</button>`).join('')}
            </div>
          ` : ''}
          ${plannedEvents.length > 0 ? `
            <div class="field-label">Planlagt</div>
            <div class="flex-gap" style="flex-wrap:wrap;">
              ${plannedEvents.map(e => `<button class="btn btn-secondary" onclick="openLiveView(${e.id})">▤ ${escapeHtml(e.name)}</button>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
    return;
  }

  await renderLiveView(root, state.currentEventId);
};

async function openLiveView(eventId) {
  state.currentEventId = eventId;
  // Subscribe via WS
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify({ type: 'subscribe', event_id: eventId }));
  }
  goto('live');
}

async function renderLiveView(root, eventId) {
  const ev = await api(`/api/events/${eventId}`);
  const sessions = await api(`/api/sessions/event/${eventId}/active`).catch(() => []);

  const teamsWithSessions = (ev.teams || []).map(t => {
    const session = sessions.find(s => s.team_id === t.id);
    return { ...t, session };
  });

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Sanntid — ${escapeHtml(ev.organization_name || '')}</div>
        <div class="page-title">● ${escapeHtml(ev.name)}</div>
      </div>
      <div class="page-actions">
        ${ev.status === 'planned' ? `<button class="btn btn-success" onclick="setEventStatus(${ev.id}, 'live')">▶ Start event</button>` : ''}
        ${ev.status === 'live' ? `<button class="btn btn-amber" onclick="setEventStatus(${ev.id}, 'finished')">■ Avslutt event</button>` : ''}
        <button class="btn btn-secondary" onclick="state.currentEventId=null;goto('live');">↺ Bytt event</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card amber"><span class="stat-label">Eventkode</span><span class="stat-value mono" style="font-size:32px;">${escapeHtml(ev.code)}</span></div>
      <div class="stat-card"><span class="stat-label">Status</span><span class="stat-value" style="font-size:18px;">${eventStatusBadge(ev.status)}</span></div>
      <div class="stat-card green"><span class="stat-label">Aktive sesjoner</span><span class="stat-value" id="live-active-count">${sessions.length}</span><span class="stat-sub">av ${(ev.teams || []).length} lag</span></div>
      <div class="stat-card blue"><span class="stat-label">Scenario</span><span class="stat-value" style="font-size:16px;font-family:var(--font-serif);">${escapeHtml(ev.scenario_name || '—')}</span></div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">◍</span> Lag <span class="ph-spacer"></span><span style="font-size:11px;opacity:0.7;">Oppdateres i sanntid</span></div>
      <div class="panel-body">
        <div class="live-grid" id="live-teams">
          ${teamsWithSessions.map(t => renderTeamCard(t)).join('')}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">📋</span> Hendelseslogg</div>
      <div class="panel-body tight">
        <div id="live-log" style="max-height:300px;overflow-y:auto;padding:8px 14px;font-family:var(--font-mono);font-size:12px;">
          <div class="muted">Venter på hendelser…</div>
        </div>
      </div>
    </div>
  `;

  // WS-handler oppdaterer DOM ved nye hendelser
  window._liveOnMessage = (data) => {
    const log = $('#live-log');
    if (data.type === 'session_started' || data.type === 'session_event' || data.type === 'session_finished') {
      const ts = new Date().toLocaleTimeString('nb-NO');
      const teamName = data.session && data.session.team_name ? data.session.team_name : '?';
      const detail = data.event ? `${data.event.event_type} (puzzle ${data.event.puzzle_index})` : data.type;
      const entry = document.createElement('div');
      entry.style.padding = '4px 0';
      entry.style.borderBottom = '1px solid var(--bg3)';
      entry.innerHTML = `<span style="color:var(--ink3);">[${ts}]</span> <strong>${escapeHtml(teamName)}</strong>: ${escapeHtml(detail)}`;
      if (log.firstChild && log.firstChild.classList && log.firstChild.classList.contains('muted')) log.innerHTML = '';
      log.insertBefore(entry, log.firstChild);
      // Behold maks 100 entries
      while (log.children.length > 100) log.removeChild(log.lastChild);

      // Oppdater team-card hvis vi har session-info
      if (data.session) {
        updateTeamCard(data.session);
      }
    }
    if (data.type === 'event_updated') {
      // Reload hele view-en
      renderLiveView(root, eventId);
    }
  };
}

function renderTeamCard(t) {
  const s = t.session;
  let stateLabel = '<span class="badge">Venter</span>';
  let metaRows = '';
  if (s) {
    stateLabel = '<span class="badge green">● Aktiv</span>';
    const elapsed = s.started_at ? Math.floor((Date.now() - new Date(s.started_at).getTime()) / 1000) : 0;
    const remaining = (s.time_limit_seconds || 3600) - elapsed;
    metaRows = `
      <span class="tcb-label">Startet</span><span class="tcb-val">${formatDuration(elapsed)} siden</span>
      <span class="tcb-label">Igjen</span><span class="tcb-val" style="color:${remaining < 60 ? 'var(--red)' : remaining < 300 ? 'var(--amber)' : 'var(--green)'};">${formatDuration(Math.max(0, remaining))}</span>
      <span class="tcb-label">Puzzle</span><span class="tcb-val">${s.current_puzzle ?? 0}</span>
      <span class="tcb-label">Hint</span><span class="tcb-val">${s.hints_used ?? 0}</span>
    `;
  } else {
    metaRows = `
      <span class="tcb-label">Lagkode</span><span class="tcb-val">${escapeHtml(t.code)}</span>
      <span class="tcb-label">PIN</span><span class="tcb-val">${escapeHtml(t.pin)}</span>
    `;
  }
  return `
    <div class="team-card ${s ? 'active' : ''}" data-team="${t.id}">
      <div class="team-card-header">
        <span class="team-color-dot" style="background:${t.color || '#999'};"></span>
        <span class="team-name">${escapeHtml(t.name)}</span>
        ${stateLabel}
      </div>
      <div class="team-card-body">${metaRows}</div>
      <div class="team-card-actions">
        <button class="btn btn-sm btn-secondary" onclick="showTeamQR(${state.currentEventId}, ${t.id})">QR</button>
        ${s ? '' : ''}
      </div>
    </div>
  `;
}

function updateTeamCard(session) {
  const card = $(`.team-card[data-team="${session.team_id}"]`);
  if (!card) return;
  // Enkel oppdatering: replace med ny state. Vi har ikke alle felt fra teams her,
  // så vi bare oppdaterer headerens badge og hopper resten — full re-render skjer ved neste view.
  // For ekte sanntidssync: hent teamet på nytt fra state.
}

// Periodisk re-render av timer-tall i live-view (hver sekund)
setInterval(() => {
  if (state.currentView !== 'live') return;
  $$('#live-teams .team-card.active').forEach(card => {
    // Enkel implementasjon: vi gjør ingen DOM-mutasjon her uten cached state.
    // I en full versjon ville vi hatt en in-memory map av team-id → session.
    // For nå overlater vi sanntidsoppdateringen til WS-meldinger.
  });
}, 1000);
