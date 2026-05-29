/* ════════════════════════════════════════════════════════
   GAMEMASTER — ADMIN PORTAL
   Single-page vanilla JS application
   ──────────────────────────────────────────────────────── */

const API = window.APP_CONFIG.API_BASE.replace(/\/+$/, '');
const WS_URL = window.APP_CONFIG.WS_URL;

/* ─── STATE ──────────────────────────────────────────── */
const state = {
  token: localStorage.getItem('gm_token') || null,
  user: JSON.parse(localStorage.getItem('gm_user') || 'null'),
  currentView: null,
  ws: null,
  wsRetry: 0,
  // cached lists
  concepts: [],
  organizations: [],
  users: [],
  events: [],
  // selection
  currentConceptId: null,
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
      // token utløpt eller ugyldig — varsle og send tilbake til login.
      // (Bevisst "Logg ut"-klikk går rett til logout() uten dette varselet.)
      showToast('Økten er utløpt — logg inn på nytt', 'warn', 4000);
      logout();
    }
    throw err;
  }
  return data;
}

/* ─── BILDE-OPPLASTING ──────────────────────────────────
   uploadImage(file, opts) — komprimerer bildet i browseren før
   det sendes til backend, som lagrer det i Dropbox og returnerer
   en permanent shared link.

   Argumenter:
     file: File-objekt (fra <input type="file"> eller drag-and-drop)
     opts: { scenario_id, kind, maxWidth, quality, thumbWidth, thumbQuality }
       - scenario_id: påkrevd (heltall)
       - kind: 'cards' | 'minigames' (default: 'cards')
       - maxWidth: px (default 1600). Bildet skaleres ned hvis det er bredere.
       - quality: 0..1 (default 0.82). JPEG-kvalitet ved komprimering.
       - thumbWidth: px (default 300). Thumbnail-bredde. Sett til 0 for å droppe thumb.
       - thumbQuality: 0..1 (default 0.7). JPEG-kvalitet for thumb.

   Returnerer: { path, url, thumb_path, thumb_url, size, mimetype }
   ────────────────────────────────────────────────────── */
async function uploadImage(file, opts = {}) {
  if (!file) throw new Error('Ingen fil oppgitt');
  if (!opts.scenario_id) throw new Error('scenario_id er påkrevd');

  const kind = opts.kind || 'cards';
  const maxWidth = opts.maxWidth || 1600;
  const quality = opts.quality ?? 0.82;
  const thumbWidth = opts.thumbWidth ?? 300;
  const thumbQuality = opts.thumbQuality ?? 0.7;

  // Komprimer hovedbilde + lag thumbnail
  // GIF passerer uten komprimering (mister ellers animasjon)
  let blob, thumbBlob;
  let filename = opts.filename || file.name || 'image.jpg';
  if (file.type === 'image/gif' && !opts.filename) {
    blob = file;
    if (thumbWidth > 0) {
      thumbBlob = await compressImage(file, { maxWidth: thumbWidth, quality: thumbQuality });
    }
  } else {
    blob = await compressImage(file, { maxWidth, quality });
    if (thumbWidth > 0) {
      thumbBlob = await compressImage(file, { maxWidth: thumbWidth, quality: thumbQuality });
    }
    // Hvis filename er gitt av kaller, bruk det som-er. Ellers konverter til .jpg
    if (!opts.filename) {
      filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
    }
  }

  const form = new FormData();
  form.append('file', blob, filename);
  if (thumbBlob) {
    form.append('thumb', thumbBlob, 'thumb-' + filename);
  }
  form.append('scenario_id', String(opts.scenario_id));
  form.append('kind', kind);
  if (opts.overwrite) form.append('overwrite', 'true');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/api/uploads/image');
    if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable && opts.onProgress) {
        opts.onProgress(e.loaded / e.total);
      }
    });

    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const err = new Error((data && data.error) || `HTTP ${xhr.status}`);
        err.status = xhr.status;
        err.data = data;
        if (xhr.status === 401) {
          showToast('Økten er utløpt — logg inn på nytt', 'warn', 4000);
          logout();
        }
        reject(err);
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Nettverksfeil ved opplasting')));
    xhr.addEventListener('abort', () => reject(new Error('Opplasting avbrutt')));

    xhr.send(form);
  });
}

/* deleteImage(path, url?) — sletter bildet fra Dropbox.
   url er valgfri — hvis du har den, sendes den med så shared link
   blir revoket samtidig (best practice).
*/
async function deleteImage(path, url) {
  const params = new URLSearchParams({ path });
  if (url) params.set('url', url);
  return api('/api/uploads/image?' + params.toString(), { method: 'DELETE' });
}

/* compressImage(file, { maxWidth, quality }) → Blob (image/jpeg)
   Skalerer bildet ned hvis det er bredere enn maxWidth, og
   komprimerer som JPEG. Bevarer aspekt-forhold.
*/
async function compressImage(file, { maxWidth = 1600, quality = 0.82 } = {}) {
  const img = await loadImage(file);
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  // Hvit bakgrunn for transparent PNG (ellers blir det svart i JPEG)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise(resolve => {
    canvas.toBlob(b => resolve(b), 'image/jpeg', quality);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = e => { URL.revokeObjectURL(url); reject(new Error('Kunne ikke laste bilde')); };
    img.src = url;
  });
}


/* ─── AUTH ──────────────────────────────────────────── */
async function login(email, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('gm_token', data.token);
  localStorage.setItem('gm_user', JSON.stringify(data.user));
  enterApp();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('gm_token');
  localStorage.removeItem('gm_user');
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
      localStorage.setItem('gm_user', JSON.stringify(state.user));
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
            <th>Konsept</th>
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
              <td>${escapeHtml(e.concept_name || '—')}</td>
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
  // Hent konsepter (kun lisensierte for ikke-superadmin) og evt bedrifter
  const [concepts, orgs] = await Promise.all([
    api('/api/concepts').catch(() => []),
    state.user.role === 'superadmin' ? api('/api/organizations').catch(() => []) : Promise.resolve([]),
  ]);
  state.concepts = concepts;
  state.organizations = orgs;

  const conceptLabel = (c) => {
    if (state.user.role === 'superadmin') return escapeHtml(c.name);
    if (c.license_type === 'credits') return `${escapeHtml(c.name)} — ${c.credits_remaining} credits igjen`;
    return `${escapeHtml(c.name)} — fri lisens`;
  };

  const activeConcepts = concepts.filter(c => c.active !== false);
  const conceptOptions = activeConcepts.length
    ? activeConcepts.map(c => `<option value="${c.id}">${conceptLabel(c)}</option>`).join('')
    : '';

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
          <label class="field-label">Konsept</label>
          <select id="ev-concept">
            <option value="">— Velg konsept —</option>
            ${conceptOptions}
          </select>
          ${activeConcepts.length === 0 ? '<span class="field-hint">Ingen tilgjengelige konsepter. Be om lisens fra administrator.</span>' : ''}
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
  const conceptId = $('#ev-concept').value;
  const when = $('#ev-when').value;
  const teamCount = parseInt($('#ev-team-count').value, 10) || 0;
  const teamNamesRaw = $('#ev-team-names').value.trim();
  const teamNames = teamNamesRaw ? teamNamesRaw.split(',').map(s => s.trim()) : [];
  const orgEl = $('#ev-org');
  const organization_id = orgEl ? parseInt(orgEl.value, 10) : null;

  if (!name) { errEl.textContent = 'Eventnavn er påkrevd.'; errEl.classList.remove('hidden'); return; }
  if (!conceptId) { errEl.textContent = 'Velg et konsept.'; errEl.classList.remove('hidden'); return; }
  if (teamCount < 1 || teamCount > 50) { errEl.textContent = 'Antall lag må være 1–50.'; errEl.classList.remove('hidden'); return; }

  try {
    const body = {
      name,
      concept_id: parseInt(conceptId, 10),
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
          <span class="stat-label">Konsept</span>
          <span class="stat-value" style="font-size:18px;font-family:var(--font-serif);">${escapeHtml(ev.concept_name || '—')}</span>
          <span class="stat-sub">${ev.concept_time_limit ? Math.round(ev.concept_time_limit / 60) + ' min tidsgrense' : 'Ingen tidsgrense'}</span>
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
   VIEW: KONSEPTER (kun superadmin)
   ──────────────────────────────────────────────────────── */
views.concepts = async function (root) {
  if (state.user.role !== 'superadmin') {
    root.innerHTML = '<div class="form-error">Kun superadmin har tilgang til konsepter.</div>';
    return;
  }
  const concepts = await api('/api/concepts?all=1');
  state.concepts = concepts;

  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Innhold</div>
        <div class="page-title">Konsepter</div>
      </div>
      <div class="page-actions">
        <button class="btn" onclick="openCreateConceptModal()">+ Nytt konsept</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">◆</span> Konseptbibliotek</div>
      <div class="panel-body tight">
        ${concepts.length === 0
          ? `<div class="empty-state" style="border:none;"><span class="empty-icon">◇</span><span class="empty-text">Ingen konsepter ennå</span><span class="empty-sub">Opprett ditt første konsept</span></div>`
          : `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Navn</th>
                <th>Key</th>
                <th>Beskrivelse</th>
                <th>Tidsgrense</th>
                <th>Status</th>
                <th class="col-actions">Handlinger</th>
              </tr>
            </thead>
            <tbody>
              ${concepts.map(c => `
                <tr class="${!c.active ? 'row-muted' : ''}">
                  <td><strong>${escapeHtml(c.name)}</strong></td>
                  <td class="col-mono">${escapeHtml(c.key || '—')}</td>
                  <td><span class="muted" style="font-size:13px;">${escapeHtml((c.description || '').slice(0, 70))}${(c.description || '').length > 70 ? '…' : ''}</span></td>
                  <td class="col-mono">${c.time_limit_seconds ? Math.round(c.time_limit_seconds / 60) + ' min' : '—'}</td>
                  <td>${c.active ? '<span class="badge green">Aktiv</span>' : '<span class="badge">Inaktiv</span>'}</td>
                  <td class="col-actions">
                    <button class="btn btn-sm" onclick="openConceptBuilder(${c.id})">Bygg</button>
                    <button class="btn btn-sm btn-secondary" onclick="openConceptAccess(${c.id})">Tilganger</button>
                    <button class="btn btn-sm btn-ghost" onclick="toggleConceptActive(${c.id}, ${!c.active})">${c.active ? 'Deaktiver' : 'Aktiver'}</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteConcept(${c.id})">Slett</button>
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

function openCreateConceptModal() {
  openModal({
    title: 'Nytt konsept',
    body: `
      <div class="field">
        <label class="field-label">Navn</label>
        <input id="c-name" type="text" placeholder="F.eks. Escape Box" autocomplete="off">
      </div>
      <div class="field">
        <label class="field-label">Beskrivelse</label>
        <textarea id="c-desc" placeholder="Kort beskrivelse av konseptet"></textarea>
      </div>
      <div class="field">
        <label class="field-label">Tidsgrense (minutter)</label>
        <input id="c-time" type="number" min="5" max="240" value="60">
      </div>
      <div id="c-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Opprett</button>
    `,
    onSubmit: async () => {
      const name = $('#c-name').value.trim();
      const desc = $('#c-desc').value.trim();
      const mins = parseInt($('#c-time').value, 10) || 60;
      const errEl = $('#c-error');
      if (!name) { errEl.textContent = 'Navn påkrevd'; errEl.classList.remove('hidden'); return; }
      try {
        const c = await api('/api/concepts', { method: 'POST', body: { name, description: desc || null, time_limit_seconds: mins * 60 } });
        closeModal();
        showToast('Konsept opprettet', 'success');
        goto('concepts');
        setTimeout(() => openConceptBuilder(c.id), 200);
      } catch (e) {
        errEl.textContent = e.message; errEl.classList.remove('hidden');
      }
    },
  });
}

async function toggleConceptActive(id, active) {
  try {
    await api(`/api/concepts/${id}`, { method: 'PATCH', body: { active } });
    showToast(active ? 'Aktivert' : 'Deaktivert', 'success');
    goto('concepts');
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteConcept(id) {
  const ok = await confirmDialog('Slette dette konseptet? Hvis det er i bruk, blir det deaktivert i stedet.', 'Slett konsept');
  if (!ok) return;
  try {
    const r = await api(`/api/concepts/${id}`, { method: 'DELETE' });
    showToast(r.deactivated ? 'Konsept deaktivert (i bruk)' : 'Konsept slettet', 'success');
    goto('concepts');
  } catch (e) { showToast(e.message, 'error'); }
}

/* ════════════════════════════════════════════════════════
   KONSEPT-BYGGER
   ────────────────────────────────────────────────────────
   escape_box -> kort-graf-bygger. Andre konsepter -> enkel meta-modal.
   Modell (config):
     cards[]: { id, title, surface:'work'|'ib', code?, track, order,
                requires:{ mode:'all'|'any', conditions:[ {type:'card_done',card_id} | {type:'code',code} ] },
                blocks:[ info|question|unlock ]   (surface 'work')
                ib:{ intro_text, active_codes[], place_count, correct_codes[],
                     points_correct, points_wrong, discard_hint, success_text }  (surface 'ib') }
   Et fysisk kort = et kort med `code` satt.
   ──────────────────────────────────────────────────────── */

let ebb = null; // { conceptId, concept, config, tab }
let ebDragId = null;

async function openConceptBuilder(conceptId) {
  state.currentConceptId = conceptId;
  let c;
  try { c = await api(`/api/concepts/${conceptId}`); }
  catch (e) { showToast('Kunne ikke hente konsept: ' + e.message, 'error'); return; }
  if (c.key === 'escape_box') {
    ebb = { conceptId, concept: c, config: ebNormalizeConfig(c.config), tab: 'cards' };
    renderEbBuilder();
  } else {
    openSimpleConceptMeta(c);
  }
}

function openSimpleConceptMeta(c) {
  openModal({
    title: `Bygg: ${c.name}`,
    body: `
      <div class="field-row">
        <div class="field"><label class="field-label">Navn</label><input id="c-edit-name" type="text" value="${escapeHtml(c.name)}"></div>
        <div class="field"><label class="field-label">Key</label><input id="c-edit-key" type="text" value="${escapeHtml(c.key || '')}" class="col-mono"></div>
      </div>
      <div class="field"><label class="field-label">Beskrivelse</label><textarea id="c-edit-desc">${escapeHtml(c.description || '')}</textarea></div>
      <div class="field"><label class="field-label">Tidsgrense (minutter)</label><input id="c-edit-time" type="number" min="5" max="240" value="${Math.round((c.time_limit_seconds || 3600) / 60)}"></div>
      <div class="muted" style="font-size:13px;margin-top:10px;">Ingen skreddersydd bygger for dette konseptet ennå.</div>
      <div id="c-edit-error" class="form-error hidden" style="margin-top:12px;"></div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Lukk</button><button class="btn" onclick="saveConceptMeta(${c.id})">Lagre</button>`,
  });
}

async function saveConceptMeta(conceptId) {
  const name = $('#c-edit-name').value.trim();
  const key = $('#c-edit-key').value.trim();
  const description = $('#c-edit-desc').value.trim();
  const mins = parseInt($('#c-edit-time').value, 10);
  const errEl = $('#c-edit-error');
  if (!name) { errEl.textContent = 'Navn påkrevd'; errEl.classList.remove('hidden'); return; }
  try {
    await api(`/api/concepts/${conceptId}`, { method: 'PATCH', body: { name, key: key || undefined, description: description || null, time_limit_seconds: (mins > 0 ? mins : 60) * 60 } });
    showToast('Konsept lagret', 'success');
    closeModal();
    if (state.currentView === 'concepts') goto('concepts');
  } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
}

/* ─── Modell-hjelpere ───────────────────────────────────── */
function ebUid(p) { return `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

function ebNormalizeConfig(cfg) {
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  const cards = Array.isArray(cfg.cards) ? cfg.cards.map((c, i) => ebNormalizeCard(c, i)) : [];
  return {
    intro: cfg.intro && typeof cfg.intro === 'object'
      ? { title: cfg.intro.title || '', body: cfg.intro.body || '', media_url: cfg.intro.media_url || '' }
      : { title: '', body: '', media_url: '' },
    cards,
    settings: {
      time_limit_enabled: true, show_score: true, require_consent: true, streetview_enabled: true, hint_cost: 0,
      ...(cfg.settings || {}),
    },
    finale: cfg.finale && typeof cfg.finale === 'object' ? cfg.finale : null,
    bigscreen: cfg.bigscreen && typeof cfg.bigscreen === 'object' ? cfg.bigscreen : null,
  };
}

function ebNormalizeCard(c, i) {
  c = c && typeof c === 'object' ? c : {};
  const surface = c.surface === 'ib' ? 'ib' : 'work';
  const req = c.requires && typeof c.requires === 'object' ? c.requires : {};
  return {
    id: c.id || ebUid('card'),
    title: c.title || '',
    surface,
    code: c.code || '',
    track: Number.isInteger(c.track) ? c.track : 0,
    order: typeof c.order === 'number' ? c.order : i,
    requires: {
      mode: req.mode === 'any' ? 'any' : 'all',
      conditions: Array.isArray(req.conditions) ? req.conditions : [],
    },
    blocks: Array.isArray(c.blocks) ? c.blocks : [],
    ib: c.ib && typeof c.ib === 'object' ? c.ib : {
      intro_text: '', active_codes: [], place_count: 1, correct_codes: [],
      points_correct: 0, points_wrong: 0, discard_hint: '', success_text: '',
    },
  };
}

function ebRoot() { return $('#content .view[data-view="concepts"]'); }
function ebCardById(id) { return ebb.config.cards.find(c => c.id === id); }

// Kompakte track/order-verdier etter flytting/sletting
function ebNormalizeOrder() {
  const cards = ebb.config.cards;
  const tracks = [...new Set(cards.map(c => c.track))].sort((a, b) => a - b);
  const remap = {};
  tracks.forEach((t, i) => { remap[t] = i; });
  cards.forEach(c => { c.track = remap[c.track]; });
  tracks.forEach((t, i) => {
    cards.filter(c => c.track === i).sort((a, b) => a.order - b.order).forEach((c, j) => { c.order = j; });
  });
}

function ebMaxTrack() {
  return ebb.config.cards.reduce((m, c) => Math.max(m, c.track), -1);
}

/* ─── Render ────────────────────────────────────────────── */
function renderEbBuilder() {
  const root = ebRoot();
  if (!root || !ebb) return;
  root.innerHTML = `
    <div class="page-header">
      <div>
        <div class="page-eyebrow">Konsept · ${escapeHtml(ebb.concept.name)}</div>
        <div class="page-title">Escape Box-bygger</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" onclick="ebExit()">← Tilbake</button>
        <button class="btn btn-success" onclick="ebOpenPreview()">▷ Test spillflyt</button>
        <button class="btn" onclick="ebSaveAll()">Lagre alt</button>
      </div>
    </div>
    <div class="flex-gap mb-2" style="border-bottom:1px solid var(--bg3);padding-bottom:8px;">
      <button class="btn btn-sm ${ebb.tab === 'cards' ? '' : 'btn-ghost'}" onclick="ebSetTab('cards')">1 · Kort &amp; flyt</button>
      <button class="btn btn-sm btn-ghost" disabled title="Bolk 2">2 · GM-panel</button>
      <button class="btn btn-sm btn-ghost" disabled title="Bolk 3">3 · Storskjerm</button>
    </div>
    ${ebCardsTab()}
  `;
}

function ebSetTab(t) { ebb.tab = t; renderEbBuilder(); }
function ebExit() { ebb = null; goto('concepts'); }

/* ════════════════════════════════════════════════════════
   DEL B — DELTAGER-TEST (samme papir/dossier-stil som siden)
   ────────────────────────────────────────────────────────
   Spiller kort-grafen klient-side i en liggende nettbrett-ramme.
   Visning av et kort styres av requires (card_done / code).
   IB-kort rendres i IB-kolonnen, arbeidskort i arbeidsområdet.
   Samme flyt-motor gjenbrukes senere i play.html (med backend).
   ──────────────────────────────────────────────────────── */
let ebPvState = null;

function ebOpenPreview() {
  if (!ebb) return;
  const cfg = JSON.parse(JSON.stringify(ebb.config));
  const limit = ebb.concept.time_limit_seconds || 3600;
  ebPvState = {
    cfg, limit, timeLeft: limit, timer: null,
    started: false, score: 0,
    answeredCorrect: new Set(),
    enteredCodes: new Set(),
    ibSolved: new Set(),
    ibArmed: new Set(),
  };
  let ov = document.getElementById('eb-pv-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'eb-pv-overlay'; document.body.appendChild(ov); }
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(26,22,16,0.6);display:flex;align-items:center;justify-content:center;padding:18px;';
  ebPvRender();
}

function ebPvClose() {
  if (ebPvState && ebPvState.timer) clearInterval(ebPvState.timer);
  const ov = document.getElementById('eb-pv-overlay');
  if (ov) ov.remove();
  ebPvState = null;
}
function ebPvReplay() { ebOpenPreview(); }
function ebPvFmt(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function ebPvStart() {
  ebPvState.started = true;
  if (!ebPvState.timer) {
    ebPvState.timer = setInterval(() => {
      if (!ebPvState) return;
      ebPvState.timeLeft -= 1;
      const el = document.getElementById('eb-pv-time');
      if (el) el.textContent = ebPvFmt(ebPvState.timeLeft);
      if (ebPvState.timeLeft <= 0) { clearInterval(ebPvState.timer); ebPvState.timer = null; }
    }, 1000);
  }
  ebPvRender();
}

function ebPvHint() {
  const cost = (ebPvState.cfg.settings && ebPvState.cfg.settings.hint_cost) || 0;
  showToast(`Hint sendes av gamemaster i selve eventet (bolk 2). Koster ${cost} poeng.`, 'info', 3500);
}

/* ─── Motor: synlighet + fullført (fikspunkt) ───────────── */
function ebPvReqMet(card, done, codes) {
  const conds = (card.requires && card.requires.conditions) || [];
  if (conds.length === 0) return true;
  const test = (c) => c.type === 'card_done'
    ? done.has(c.card_id)
    : (c.type === 'code' ? codes.has(String(c.code || '').toUpperCase()) : false);
  return card.requires.mode === 'any' ? conds.some(test) : conds.every(test);
}

function ebPvCompute() {
  const st = ebPvState;
  const cards = st.cfg.cards;
  const done = new Set();
  cards.forEach(c => { if (c.surface === 'ib' && st.ibSolved.has(c.id)) done.add(c.id); });

  for (let iter = 0; iter <= cards.length + 1; iter++) {
    const visible = new Set();
    cards.forEach(c => { if (ebPvReqMet(c, done, st.enteredCodes)) visible.add(c.id); });
    let changed = false;
    cards.forEach(c => {
      if (done.has(c.id) || !visible.has(c.id)) return;
      if (c.surface === 'ib') {
        if (st.ibSolved.has(c.id)) { done.add(c.id); changed = true; }
      } else {
        const qs = (c.blocks || []).filter(b => b.type === 'question');
        if (qs.every(b => st.answeredCorrect.has(b.id))) { done.add(c.id); changed = true; }
      }
    });
    if (!changed) break;
  }
  const visible = new Set();
  cards.forEach(c => { if (ebPvReqMet(c, done, st.enteredCodes)) visible.add(c.id); });
  return { visible, done };
}

/* ─── Handlinger ────────────────────────────────────────── */
function ebPvAnswer(blockId, optIdx) {
  const st = ebPvState;
  if (st.answeredCorrect.has(blockId)) return;
  let block = null;
  st.cfg.cards.forEach(c => (c.blocks || []).forEach(b => { if (b.id === blockId) block = b; }));
  if (!block) return;
  const opt = (block.options || [])[optIdx];
  if (opt && opt.correct) {
    st.answeredCorrect.add(blockId);
    st.score += block.points || 0;
    ebPvRender();
  } else {
    showToast('Feil svar — prøv igjen', 'error');
  }
}

function ebPvIbArm(ibId) { ebPvState.ibArmed.add(ibId); ebPvRender(); }

function ebPvIbSubmit(ibId) {
  const st = ebPvState;
  const card = st.cfg.cards.find(c => c.id === ibId);
  if (!card) return;
  const ib = card.ib || {};
  const n = ib.place_count || (ib.correct_codes || []).length || 0;
  const entered = [];
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`eb-pv-ibslot-${ibId}-${i}`);
    if (el && el.value.trim()) entered.push(el.value.trim().toUpperCase());
  }
  const correct = (ib.correct_codes || []).map(c => c.toUpperCase());
  const setsEqual = entered.length === correct.length &&
    correct.every(c => entered.includes(c)) && entered.every(c => correct.includes(c));

  if (setsEqual) {
    st.ibSolved.add(ibId);
    st.score += ib.points_correct || 0;
    correct.forEach(c => st.enteredCodes.add(c));
    showToast(ib.success_text ? ib.success_text : 'Riktig plassering!', 'success', 3500);
    ebPvRender();
  } else {
    st.score -= ib.points_wrong || 0;
    showToast('Feil plassering — prøv igjen', 'error');
    ebPvRender();
  }
}

/* ─── Render ────────────────────────────────────────────── */
function ebPvRender() {
  const ov = document.getElementById('eb-pv-overlay');
  const st = ebPvState;
  if (!ov || !st) return;
  const cfg = st.cfg;
  const showScore = !cfg.settings || cfg.settings.show_score !== false;
  const showTimer = !cfg.settings || cfg.settings.time_limit_enabled !== false;
  const hintCost = (cfg.settings && cfg.settings.hint_cost) || 0;

  let inner;
  if (!st.started) {
    inner = ebPvIntro();
  } else {
    const { visible, done } = ebPvCompute();
    inner = `
      <div style="flex:1;display:flex;min-height:0;">
        <div style="flex:0 0 320px;border-right:1px solid var(--rule);overflow:auto;padding:18px;background:var(--bg2);">
          ${ebPvIbColumn(visible, done)}
        </div>
        <div style="flex:1;overflow:auto;padding:22px 26px;">
          ${ebPvWorkArea(visible, done)}
        </div>
      </div>`;
  }

  const topbar = `
    <div style="flex:0 0 auto;display:flex;align-items:center;gap:14px;padding:11px 18px;background:var(--paper);border-bottom:1px solid var(--rule);">
      <span class="badge blue">LAG 1</span>
      <span style="font-family:var(--font-cond);font-size:18px;letter-spacing:0.04em;text-transform:uppercase;color:var(--ink);">Testlag</span>
      <span style="flex:1;"></span>
      <button class="btn btn-sm btn-secondary" onclick="ebPvHint()">Hint ${hintCost ? `(−${hintCost} p)` : ''}</button>
    </div>`;

  const bottombar = `
    <div style="flex:0 0 auto;display:flex;align-items:center;gap:16px;padding:10px 18px;background:var(--paper);border-top:1px solid var(--rule);">
      ${showScore ? `<span style="font-family:var(--font-cond);text-transform:uppercase;font-size:12px;letter-spacing:0.1em;color:var(--ink3);">Poeng</span><span style="font-family:var(--font-mono);font-size:18px;color:var(--ink);" id="eb-pv-score">${st.score}</span>` : ''}
      <span style="flex:1;"></span>
      ${showTimer ? `<span style="font-family:var(--font-cond);text-transform:uppercase;font-size:12px;letter-spacing:0.1em;color:var(--ink3);">Tid igjen</span><span style="font-family:var(--font-mono);font-size:18px;color:var(--stamp);" id="eb-pv-time">${ebPvFmt(st.timeLeft)}</span>` : ''}
    </div>`;

  ov.innerHTML = `
    <button onclick="ebPvClose()" title="Lukk" style="position:absolute;top:14px;right:18px;background:none;border:none;color:var(--paper);font-size:26px;cursor:pointer;">✕</button>
    <div style="width:min(1180px,96vw);aspect-ratio:4/3;max-height:92vh;background:var(--ink2);border-radius:28px;padding:16px;box-shadow:0 30px 80px rgba(0,0,0,0.5);display:flex;flex-direction:column;">
      <div style="flex:1;display:flex;flex-direction:column;background:var(--bg);border-radius:14px;overflow:hidden;color:var(--ink);font-family:var(--font-serif);">
        ${topbar}
        ${inner}
        ${st.started ? bottombar : ''}
      </div>
    </div>`;
}

function ebPvIntro() {
  const cfg = ebPvState.cfg;
  if (cfg.cards.length === 0) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink3);padding:40px;text-align:center;">Ingen kort bygget ennå. Legg til kort i «Kort &amp; flyt» først.</div>`;
  }
  return `
    <div style="flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;padding:40px;">
      <div style="max-width:620px;text-align:center;">
        <div class="page-eyebrow">${escapeHtml(ebb.concept.name)}</div>
        <h1 style="font-family:var(--font-serif);font-size:30px;margin:12px 0;color:var(--ink);">${escapeHtml(cfg.intro.title || 'Velkommen')}</h1>
        ${cfg.intro.media_url ? `<img src="${escapeHtml(cfg.intro.media_url)}" style="max-width:100%;max-height:220px;border-radius:8px;margin:14px 0;border:1px solid var(--rule);">` : ''}
        <p style="color:var(--ink2);line-height:1.7;white-space:pre-wrap;">${escapeHtml(cfg.intro.body || '')}</p>
        <button class="btn" style="margin-top:22px;" onclick="ebPvStart()">▶ Start oppdraget</button>
      </div>
    </div>`;
}

function ebPvIbColumn(visible, done) {
  const st = ebPvState;
  const ibCard = st.cfg.cards
    .filter(c => c.surface === 'ib' && visible.has(c.id) && !done.has(c.id))
    .sort((a, b) => a.track - b.track || a.order - b.order)[0];

  const head = `<div class="page-eyebrow" style="margin-bottom:12px;">Investigation Board</div>`;

  if (!ibCard) {
    return `${head}<div class="muted" style="font-size:13px;">Ingen aktiv runde akkurat nå. Løs kortene i arbeidsområdet for å låse opp neste runde.</div>`;
  }

  const ib = ibCard.ib || {};
  const active = (ib.active_codes || []);
  const n = ib.place_count || (ib.correct_codes || []).length || 0;
  const armed = st.ibArmed.has(ibCard.id);

  const activeList = active.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 14px;">${active.map(c => `<span class="badge dark col-mono">${escapeHtml(c)}</span>`).join('')}</div>`
    : `<div class="muted" style="font-size:12px;margin:8px 0 14px;">(ingen aktive koder definert)</div>`;

  let action;
  if (!armed) {
    action = `
      <div class="muted" style="font-size:12px;margin-bottom:6px;">Du skal plassere <strong>${n}</strong> av kortene på Investigation Board.</div>
      <button class="btn btn-sm" onclick="ebPvIbArm('${ibCard.id}')">Plasser på Investigation Board</button>`;
  } else {
    let slots = '';
    for (let i = 0; i < n; i++) {
      slots += `<input id="eb-pv-ibslot-${ibCard.id}-${i}" type="text" maxlength="6" placeholder="Kode ${i + 1}" class="col-mono" style="width:100%;margin-bottom:8px;text-transform:uppercase;">`;
    }
    action = `
      <div class="muted" style="font-size:12px;margin-bottom:8px;">Tast koden på de <strong>${n}</strong> kortene du plasserer. Resten legges til side (discard).</div>
      ${slots}
      <button class="btn btn-sm" onclick="ebPvIbSubmit('${ibCard.id}')">Bekreft plassering</button>`;
  }

  return `
    ${head}
    <div class="panel" style="margin:0;">
      <div class="panel-header" style="font-size:13px;">${escapeHtml(ibCard.title || 'IB-runde')}</div>
      <div class="panel-body">
        ${ib.intro_text ? `<p style="font-size:13px;color:var(--ink2);line-height:1.6;margin-top:0;">${escapeHtml(ib.intro_text)}</p>` : ''}
        <div style="font-family:var(--font-cond);text-transform:uppercase;font-size:11px;letter-spacing:0.1em;color:var(--ink3);">Aktive kort</div>
        ${activeList}
        ${action}
      </div>
    </div>`;
}

function ebPvWorkArea(visible, done) {
  const st = ebPvState;
  const cards = st.cfg.cards
    .filter(c => c.surface !== 'ib' && visible.has(c.id))
    .sort((a, b) => a.track - b.track || a.order - b.order);

  if (cards.length === 0) {
    return `<div class="muted" style="padding:30px;text-align:center;">Ingen aktive bolker ennå.</div>`;
  }

  const allDone = st.cfg.cards.every(c => done.has(c.id));
  const cardsHtml = cards.map(c => ebPvWorkCard(c, done)).join('');
  const finale = allDone
    ? `<div class="panel" style="border-color:var(--green);"><div class="panel-body" style="text-align:center;"><div style="font-size:34px;color:var(--green);">✓</div><h2 style="font-family:var(--font-serif);margin:6px 0;">Alle kort fullført</h2><p class="muted" style="font-size:13px;">Finalen (lagnummer, navn, portrett og bolig) bygges i bolk 3.</p><button class="btn btn-sm btn-secondary" onclick="ebPvReplay()">↺ Spill på nytt</button></div></div>`
    : '';

  return cardsHtml + finale;
}

function ebPvWorkCard(card, done) {
  const st = ebPvState;
  const isDone = done.has(card.id);
  const blocks = (card.blocks || []).map(b => ebPvBlock(b)).join('');
  return `
    <div class="panel">
      <div class="panel-header" style="font-size:14px;">
        ${escapeHtml(card.title || 'Bolk')}
        ${card.code ? `<span class="badge dark col-mono" style="margin-left:8px;font-size:10px;">${escapeHtml(card.code)}</span>` : ''}
        <span class="ph-spacer"></span>
        ${isDone ? '<span class="badge green">Fullført</span>' : ''}
      </div>
      <div class="panel-body">${blocks || '<div class="muted" style="font-size:13px;">(ingen innhold)</div>'}</div>
    </div>`;
}

function ebPvBlock(b) {
  const st = ebPvState;
  if (b.type === 'info') {
    return `
      ${b.media_url ? `<img src="${escapeHtml(b.media_url)}" style="max-width:100%;max-height:240px;border-radius:6px;border:1px solid var(--rule);margin-bottom:10px;">` : ''}
      <p style="color:var(--ink2);line-height:1.7;white-space:pre-wrap;margin:0 0 6px;">${escapeHtml(b.text || '')}</p>`;
  }
  if (b.type === 'unlock') {
    const codes = (b.physical_codes || []).map(c => `<span class="badge amber col-mono">${escapeHtml(c)}</span>`).join(' ');
    return `
      <div style="background:var(--amber-bg);border:1px solid var(--amber);border-radius:8px;padding:12px 14px;margin:6px 0;">
        <div style="font-family:var(--font-cond);text-transform:uppercase;font-size:11px;letter-spacing:0.1em;color:var(--amber);margin-bottom:6px;">Åpne fysiske kort</div>
        ${b.text ? `<div style="color:var(--ink2);margin-bottom:8px;">${escapeHtml(b.text)}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:6px;">${codes || '<span class="muted">(ingen koder)</span>'}</div>
      </div>`;
  }
  if (b.type === 'question') {
    const answered = st.answeredCorrect.has(b.id);
    const opts = (b.options || []).map((o, i) => {
      if (answered) {
        return `<div style="padding:9px 12px;border:1px solid ${o.correct ? 'var(--green)' : 'var(--rule)'};border-radius:8px;margin-bottom:6px;color:${o.correct ? 'var(--green)' : 'var(--ink3)'};background:${o.correct ? 'var(--green-bg)' : 'transparent'};">${o.correct ? '✓ ' : ''}${escapeHtml(o.text || '')}</div>`;
      }
      return `<button onclick="ebPvAnswer('${b.id}', ${i})" style="display:block;width:100%;text-align:left;padding:9px 12px;border:1px solid var(--rule2);border-radius:8px;margin-bottom:6px;background:var(--paper);color:var(--ink);cursor:pointer;font-family:var(--font-serif);">${escapeHtml(o.text || '')}</button>`;
    }).join('');
    return `
      <div style="margin:4px 0 10px;">
        <div style="font-weight:600;margin-bottom:8px;color:var(--ink);">${escapeHtml(b.prompt || '')}${b.points ? ` <span class="muted" style="font-weight:400;font-size:12px;">(${b.points} p)</span>` : ''}</div>
        ${opts}
      </div>`;
  }
  return '';
}

function ebCardsTab() {
  const c = ebb.config;
  const maxT = ebMaxTrack();
  let columns = '';
  for (let t = 0; t <= Math.max(0, maxT); t++) {
    const cards = c.cards.filter(x => x.track === t).sort((a, b) => a.order - b.order);
    columns += `
      <div class="eb-col" ondragover="event.preventDefault()" ondrop="ebDropOnTrack(event, ${t})"
           style="flex:0 0 290px;background:var(--bg2,#11151f);border:1px solid var(--bg3);border-radius:12px;padding:10px;">
        <div class="muted" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">${t === 0 ? 'Hovedløp' : 'Parallelt løp ' + t}</div>
        ${cards.map(card => ebTileHtml(card)).join('') || '<div class="muted" style="font-size:12px;padding:8px;">Tomt løp</div>'}
        <div class="flex-gap" style="margin-top:8px;">
          <button class="btn btn-sm btn-secondary" onclick="ebAddCard(${t}, 'work')">+ Kort</button>
          <button class="btn btn-sm btn-secondary" onclick="ebAddCard(${t}, 'ib')">+ IB-runde</button>
        </div>
      </div>`;
  }
  // Drop-sone for nytt parallelt løp
  columns += `
    <div ondragover="event.preventDefault()" ondrop="ebDropNewTrack(event)"
         style="flex:0 0 150px;border:1px dashed var(--bg3);border-radius:12px;padding:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--ink3,#8a93a6);">
      <div style="font-size:12px;text-align:center;">Slipp her for nytt parallelt løp</div>
      <button class="btn btn-sm btn-secondary" onclick="ebAddCard(${maxT + 1 < 1 ? 1 : maxT + 1}, 'work')">+ Nytt løp</button>
    </div>`;

  return `
    <div class="panel">
      <div class="panel-header"><span class="ph-icon">▸</span> Intro <span class="ph-spacer"></span>
        <button class="btn btn-sm btn-secondary" onclick="ebIntroModal()">Rediger</button>
      </div>
      <div class="panel-body">
        <div><strong>${escapeHtml(c.intro.title || '(ingen tittel)')}</strong></div>
        <div class="muted" style="font-size:13px;margin-top:4px;">${escapeHtml(c.intro.body || 'Ingen introtekst')}</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header"><span class="ph-icon">▦</span> Kort &amp; flyt
        <span class="ph-spacer"></span>
        <span class="muted" style="font-size:11px;">Dra kort opp/ned eller til et annet løp</span>
      </div>
      <div class="panel-body">
        ${c.cards.length === 0 ? '<div class="muted" style="margin-bottom:10px;">Ingen kort ennå. Legg til et kort eller en IB-runde nedenfor.</div>' : ''}
        <div style="display:flex;gap:12px;align-items:flex-start;overflow-x:auto;padding-bottom:6px;">
          ${columns}
        </div>
      </div>
    </div>
  `;
}

function ebTileHtml(card) {
  const isIb = card.surface === 'ib';
  const badge = isIb
    ? '<span class="badge amber">Investigation Board</span>'
    : '<span class="badge blue">Arbeidsområde</span>';
  const codeChip = card.code ? `<span class="badge dark col-mono" style="font-size:10px;">FYSISK · ${escapeHtml(card.code)}</span>` : '';
  const reqs = ebRequiresSummary(card);
  const trig = ebTriggersSummary(card);
  const count = isIb ? '' : `<span class="muted" style="font-size:11px;">${(card.blocks || []).length} blokk(er)</span>`;
  return `
    <div draggable="true" ondragstart="ebDragStart(event, '${card.id}')" ondragover="event.preventDefault()" ondrop="ebDropOnCard(event, '${card.id}')"
         style="background:var(--bg1,#0c1018);border:1px solid var(--bg3);border-left:3px solid ${isIb ? '#ffd166' : '#56ccf2'};border-radius:10px;padding:10px 12px;margin-bottom:8px;cursor:grab;">
      <div class="flex-gap" style="align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;">${badge} ${codeChip}</div>
      <div style="font-weight:600;font-size:14px;margin-bottom:4px;">${escapeHtml(card.title || '(uten tittel)')}</div>
      ${count}
      <div class="muted" style="font-size:11px;margin-top:6px;line-height:1.5;">
        <div><span style="color:#6fcf97;">▸ Vises når:</span> ${reqs}</div>
        ${trig ? `<div><span style="color:#ffd166;">▸ Åpner:</span> ${trig}</div>` : ''}
      </div>
      <div class="flex-gap" style="margin-top:8px;">
        <button class="btn btn-sm" onclick="ebCardModal('${card.id}')">Rediger</button>
        <button class="btn btn-sm btn-danger" onclick="ebDeleteCard('${card.id}')">Slett</button>
      </div>
    </div>`;
}

function ebRequiresSummary(card) {
  const conds = card.requires.conditions || [];
  if (conds.length === 0) return 'fra start';
  const parts = conds.map(c => {
    if (c.type === 'card_done') {
      const t = ebCardById(c.card_id);
      return t ? `«${escapeHtml(t.title || 'kort')}» utført` : '(slettet kort)';
    }
    if (c.type === 'code') return `kode ${escapeHtml(c.code)}`;
    return '?';
  });
  const join = card.requires.mode === 'any' ? ' eller ' : ' og ';
  return parts.join(join);
}

function ebTriggersSummary(card) {
  const out = [];
  ebb.config.cards.forEach(other => {
    if (other.id === card.id) return;
    const conds = other.requires.conditions || [];
    const hit = conds.some(c =>
      (c.type === 'card_done' && c.card_id === card.id) ||
      (c.type === 'code' && card.code && c.code === card.code)
    );
    if (hit) out.push(`«${escapeHtml(other.title || 'kort')}»`);
  });
  return out.join(', ');
}

/* ─── Drag & drop ───────────────────────────────────────── */
function ebDragStart(ev, id) { ebDragId = id; ev.dataTransfer.effectAllowed = 'move'; }
function ebDropOnCard(ev, targetId) {
  ev.preventDefault(); ev.stopPropagation();
  const d = ebCardById(ebDragId), t = ebCardById(targetId);
  if (!d || !t || d.id === t.id) { ebDragId = null; return; }
  d.track = t.track;
  d.order = t.order - 0.5;
  ebNormalizeOrder(); ebDragId = null; renderEbBuilder();
}
function ebDropOnTrack(ev, track) {
  ev.preventDefault();
  const d = ebCardById(ebDragId);
  if (!d) return;
  d.track = track; d.order = 1e9;
  ebNormalizeOrder(); ebDragId = null; renderEbBuilder();
}
function ebDropNewTrack(ev) {
  ev.preventDefault();
  const d = ebCardById(ebDragId);
  if (!d) return;
  d.track = ebMaxTrack() + 1; d.order = 0;
  ebNormalizeOrder(); ebDragId = null; renderEbBuilder();
}

/* ─── Mutatorer ─────────────────────────────────────────── */
function ebAddCard(track, surface) {
  const card = ebNormalizeCard({ id: ebUid('card'), surface, track, order: 1e9, title: surface === 'ib' ? 'IB-runde' : 'Nytt kort' }, 0);
  ebb.config.cards.push(card);
  ebNormalizeOrder();
  ebCardModal(card.id);
}
function ebDeleteCard(id) {
  const card = ebCardById(id);
  if (!card) return;
  // Fjern betingelser i andre kort som peker hit
  ebb.config.cards.forEach(o => {
    o.requires.conditions = (o.requires.conditions || []).filter(c =>
      !((c.type === 'card_done' && c.card_id === id) || (c.type === 'code' && card.code && c.code === card.code)));
  });
  ebb.config.cards = ebb.config.cards.filter(c => c.id !== id);
  ebNormalizeOrder();
  closeModal();
  renderEbBuilder();
}

function ebIntroModal() {
  const intro = ebb.config.intro;
  openModal({
    title: 'Intro',
    body: `
      <div class="field"><label class="field-label">Tittel</label><input id="eb-intro-title" type="text" value="${escapeHtml(intro.title)}"></div>
      <div class="field"><label class="field-label">Tekst</label><textarea id="eb-intro-body" rows="4">${escapeHtml(intro.body)}</textarea></div>
      <div class="field"><label class="field-label">Media-URL (valgfritt)</label><input id="eb-intro-media" type="text" value="${escapeHtml(intro.media_url)}" placeholder="https://…"></div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Avbryt</button><button class="btn" onclick="modalSubmit()">Lagre</button>`,
    onSubmit: () => {
      ebb.config.intro = { title: $('#eb-intro-title').value.trim(), body: $('#eb-intro-body').value.trim(), media_url: $('#eb-intro-media').value.trim() };
      closeModal(); renderEbBuilder();
    },
  });
}

/* ─── Kort-editor ───────────────────────────────────────── */
function ebSetCardField(id, field, value) {
  const c = ebCardById(id); if (!c) return;
  c[field] = field === 'code' ? value.trim().toUpperCase() : value;
}
function ebSetCardSurface(id, value) {
  const c = ebCardById(id); if (!c) return;
  c.surface = value === 'ib' ? 'ib' : 'work';
  ebCardModal(id); // re-render for å bytte felter
}
function ebSetReqMode(id, mode) {
  const c = ebCardById(id); if (!c) return;
  c.requires.mode = mode === 'any' ? 'any' : 'all';
}
function ebAddCardCond(id) {
  const sel = $('#eb-cond-card'); if (!sel || !sel.value) return;
  const c = ebCardById(id); if (!c) return;
  c.requires.conditions.push({ type: 'card_done', card_id: sel.value });
  ebCardModal(id);
}
function ebAddCodeCond(id) {
  const inp = $('#eb-cond-code'); if (!inp || !inp.value.trim()) return;
  const c = ebCardById(id); if (!c) return;
  c.requires.conditions.push({ type: 'code', code: inp.value.trim().toUpperCase() });
  ebCardModal(id);
}
function ebRemoveCond(id, idx) {
  const c = ebCardById(id); if (!c) return;
  c.requires.conditions.splice(idx, 1);
  ebCardModal(id);
}
function ebSetIbField(id, field, value) {
  const c = ebCardById(id); if (!c) return;
  if (['active_codes', 'correct_codes'].includes(field)) {
    c.ib[field] = value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else if (['place_count', 'points_correct', 'points_wrong'].includes(field)) {
    c.ib[field] = parseInt(value, 10) || 0;
  } else {
    c.ib[field] = value;
  }
}

function ebCardModal(id) {
  const c = ebCardById(id); if (!c) return;
  const others = ebb.config.cards.filter(x => x.id !== id);

  const condRows = (c.requires.conditions || []).map((cond, i) => {
    const label = cond.type === 'card_done'
      ? `«${escapeHtml((ebCardById(cond.card_id) || {}).title || 'slettet kort')}» utført`
      : `kode ${escapeHtml(cond.code)}`;
    return `<div class="flex-gap" style="align-items:center;justify-content:space-between;padding:4px 0;"><span style="font-size:13px;">${label}</span><button class="btn btn-sm btn-danger" onclick="ebRemoveCond('${id}', ${i})">×</button></div>`;
  }).join('') || '<div class="muted" style="font-size:12px;">Ingen betingelser — vises fra start.</div>';

  const contentSection = c.surface === 'ib' ? ebIbFields(c) : ebBlocksSection(c);

  openModal({
    title: c.surface === 'ib' ? 'IB-runde' : 'Kort',
    size: 'lg',
    body: `
      <div class="field-row">
        <div class="field"><label class="field-label">Tittel</label><input type="text" value="${escapeHtml(c.title)}" onchange="ebSetCardField('${id}','title',this.value)"></div>
        <div class="field"><label class="field-label">Type</label>
          <select onchange="ebSetCardSurface('${id}',this.value)">
            <option value="work" ${c.surface !== 'ib' ? 'selected' : ''}>Arbeidsområde-kort</option>
            <option value="ib" ${c.surface === 'ib' ? 'selected' : ''}>Investigation Board-runde</option>
          </select>
        </div>
      </div>
      ${c.surface !== 'ib' ? `<div class="field"><label class="field-label">Fysisk kode (valgfritt)</label><input type="text" maxlength="6" value="${escapeHtml(c.code)}" class="col-mono" placeholder="ABCD" onchange="ebSetCardField('${id}','code',this.value)"><span class="field-hint">Sett kode hvis kortet er et fysisk kort.</span></div>` : ''}

      <div class="panel" style="margin-top:14px;">
        <div class="panel-header" style="font-size:13px;"><span class="ph-icon">▸</span> Vises når
          <span class="ph-spacer"></span>
          <select onchange="ebSetReqMode('${id}',this.value)" style="width:auto;">
            <option value="all" ${c.requires.mode !== 'any' ? 'selected' : ''}>Alle betingelser</option>
            <option value="any" ${c.requires.mode === 'any' ? 'selected' : ''}>Minst én betingelse</option>
          </select>
        </div>
        <div class="panel-body">
          ${condRows}
          <div class="field-row" style="margin-top:10px;align-items:flex-end;">
            <div class="field"><label class="field-label">Krev at kort er utført</label>
              <select id="eb-cond-card"><option value="">— velg kort —</option>${others.map(o => `<option value="${o.id}">${escapeHtml(o.title || o.id)}</option>`).join('')}</select>
            </div>
            <button class="btn btn-sm btn-secondary" onclick="ebAddCardCond('${id}')">+ Legg til</button>
          </div>
          <div class="field-row" style="align-items:flex-end;">
            <div class="field"><label class="field-label">Krev kode tastet</label><input id="eb-cond-code" type="text" class="col-mono" placeholder="ABCD"></div>
            <button class="btn btn-sm btn-secondary" onclick="ebAddCodeCond('${id}')">+ Legg til</button>
          </div>
        </div>
      </div>

      ${contentSection}
    `,
    footer: `<button class="btn" onclick="ebCloseCardModal()">Ferdig</button>`,
  });
}

function ebCloseCardModal() { closeModal(); renderEbBuilder(); }

function ebBlocksSection(c) {
  const rows = (c.blocks || []).map((b, i) => {
    let summary = '';
    if (b.type === 'info') summary = escapeHtml((b.text || '').slice(0, 50));
    else if (b.type === 'question') summary = escapeHtml((b.prompt || '').slice(0, 50));
    else if (b.type === 'unlock') summary = 'Åpne fysiske kort: ' + escapeHtml((b.physical_codes || []).join(', '));
    return `<tr><td style="width:120px;"><span class="badge dark">${({info:'Info',question:'Spørsmål',unlock:'Åpne kort'})[b.type] || b.type}</span></td>
      <td><span class="muted" style="font-size:13px;">${summary}</span></td>
      <td class="col-actions" style="width:130px;"><button class="btn btn-sm" onclick="ebBlockModal('${c.id}',${i})">Rediger</button><button class="btn btn-sm btn-danger" onclick="ebDeleteBlock('${c.id}',${i})">Slett</button></td></tr>`;
  }).join('');
  return `
    <div class="panel" style="margin-top:14px;">
      <div class="panel-header" style="font-size:13px;"><span class="ph-icon">▤</span> Innhold (blokker)
        <span class="ph-spacer"></span>
        <button class="btn btn-sm btn-secondary" onclick="ebAddBlock('${c.id}','info')">+ Info</button>
        <button class="btn btn-sm btn-secondary" onclick="ebAddBlock('${c.id}','question')">+ Spørsmål</button>
        <button class="btn btn-sm btn-secondary" onclick="ebAddBlock('${c.id}','unlock')">+ Åpne kort</button>
      </div>
      <div class="panel-body tight">
        ${rows ? `<table class="data-table"><tbody>${rows}</tbody></table>` : '<div class="muted" style="padding:10px;">Ingen blokker ennå.</div>'}
      </div>
    </div>`;
}

function ebIbFields(c) {
  const ib = c.ib;
  return `
    <div class="panel" style="margin-top:14px;">
      <div class="panel-header" style="font-size:13px;"><span class="ph-icon">▦</span> Investigation Board-runde</div>
      <div class="panel-body">
        <div class="field"><label class="field-label">Introtekst (vises i IB-kolonnen)</label><textarea rows="2" onchange="ebSetIbField('${c.id}','intro_text',this.value)">${escapeHtml(ib.intro_text || '')}</textarea></div>
        <div class="field"><label class="field-label">Aktive koder (kommaseparert — kortene som er i spill)</label><input type="text" class="col-mono" value="${escapeHtml((ib.active_codes || []).join(', '))}" onchange="ebSetIbField('${c.id}','active_codes',this.value)"></div>
        <div class="field-row">
          <div class="field"><label class="field-label">Antall som skal plasseres</label><input type="number" min="0" value="${ib.place_count || 0}" onchange="ebSetIbField('${c.id}','place_count',this.value)"></div>
          <div class="field"><label class="field-label">Riktige koder (kommaseparert)</label><input type="text" class="col-mono" value="${escapeHtml((ib.correct_codes || []).join(', '))}" onchange="ebSetIbField('${c.id}','correct_codes',this.value)"></div>
        </div>
        <div class="field-row">
          <div class="field"><label class="field-label">Poeng ved riktig</label><input type="number" value="${ib.points_correct || 0}" onchange="ebSetIbField('${c.id}','points_correct',this.value)"></div>
          <div class="field"><label class="field-label">Poeng ved feil (minus)</label><input type="number" value="${ib.points_wrong || 0}" onchange="ebSetIbField('${c.id}','points_wrong',this.value)"></div>
        </div>
        <div class="field"><label class="field-label">Beskjed om hvilke som legges til side (discard)</label><input type="text" value="${escapeHtml(ib.discard_hint || '')}" onchange="ebSetIbField('${c.id}','discard_hint',this.value)"></div>
        <div class="field"><label class="field-label">Suksesstekst (vises når runden er løst)</label><textarea rows="2" onchange="ebSetIbField('${c.id}','success_text',this.value)">${escapeHtml(ib.success_text || '')}</textarea></div>
      </div>
    </div>`;
}

/* ─── Blokker ───────────────────────────────────────────── */
function ebAddBlock(cardId, type) {
  const c = ebCardById(cardId); if (!c) return;
  const base = { id: ebUid('blk'), type };
  if (type === 'info') Object.assign(base, { text: '', media_url: '' });
  else if (type === 'question') Object.assign(base, { prompt: '', options: [], points: 0 });
  else if (type === 'unlock') Object.assign(base, { text: '', physical_codes: [] });
  c.blocks.push(base);
  ebBlockModal(cardId, c.blocks.length - 1);
}
function ebDeleteBlock(cardId, idx) {
  const c = ebCardById(cardId); if (!c) return;
  c.blocks.splice(idx, 1);
  ebCardModal(cardId);
}
function ebBlockModal(cardId, idx) {
  const c = ebCardById(cardId); if (!c) return;
  const b = c.blocks[idx]; if (!b) return;
  let fields = '';
  if (b.type === 'info') {
    fields = `
      <div class="field"><label class="field-label">Tekst</label><textarea id="eb-blk-text" rows="4">${escapeHtml(b.text || '')}</textarea></div>
      <div class="field"><label class="field-label">Media-URL (valgfritt)</label><input id="eb-blk-media" type="text" value="${escapeHtml(b.media_url || '')}" placeholder="https://…"></div>`;
  } else if (b.type === 'question') {
    const optText = (b.options || []).map(o => (o.correct ? '*' : '') + (o.text || '')).join('\n');
    fields = `
      <div class="field"><label class="field-label">Spørsmål</label><textarea id="eb-blk-prompt" rows="2">${escapeHtml(b.prompt || '')}</textarea></div>
      <div class="field"><label class="field-label">Svaralternativer (ett per linje, * foran riktig)</label><textarea id="eb-blk-options" rows="5" placeholder="*Riktig svar&#10;Galt svar&#10;Galt svar">${escapeHtml(optText)}</textarea></div>
      <div class="field"><label class="field-label">Poeng ved riktig</label><input id="eb-blk-points" type="number" value="${b.points || 0}"></div>`;
  } else if (b.type === 'unlock') {
    fields = `
      <div class="field"><label class="field-label">Tekst</label><input id="eb-blk-text" type="text" value="${escapeHtml(b.text || '')}" placeholder="Åpne følgende fysiske kort:"></div>
      <div class="field"><label class="field-label">Fysiske koder (kommaseparert)</label><input id="eb-blk-codes" type="text" class="col-mono" value="${escapeHtml((b.physical_codes || []).join(', '))}"></div>`;
  }
  openModal({
    title: ({ info: 'Info-blokk', question: 'Spørsmål-blokk', unlock: 'Åpne kort-blokk' })[b.type],
    body: fields,
    footer: `<button class="btn btn-secondary" onclick="ebCardModal('${cardId}')">Avbryt</button><button class="btn" onclick="ebSaveBlock('${cardId}',${idx})">Lagre blokk</button>`,
  });
}
function ebSaveBlock(cardId, idx) {
  const c = ebCardById(cardId); if (!c) return;
  const b = c.blocks[idx]; if (!b) return;
  if (b.type === 'info') {
    b.text = $('#eb-blk-text').value.trim();
    b.media_url = $('#eb-blk-media').value.trim();
  } else if (b.type === 'question') {
    b.prompt = $('#eb-blk-prompt').value.trim();
    b.options = $('#eb-blk-options').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const correct = l.startsWith('*');
      return { text: correct ? l.slice(1).trim() : l, correct };
    });
    b.points = parseInt($('#eb-blk-points').value, 10) || 0;
  } else if (b.type === 'unlock') {
    b.text = $('#eb-blk-text').value.trim();
    b.physical_codes = $('#eb-blk-codes').value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  ebCardModal(cardId);
}

async function ebSaveAll() {
  try {
    await api(`/api/concepts/${ebb.conceptId}`, { method: 'PATCH', body: { config: ebb.config } });
    showToast('Lagret', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}



/* ════════════════════════════════════════════════════════
   KONSEPT-TILGANGER (lisens + credits per bedrift)
   ──────────────────────────────────────────────────────── */
async function openConceptAccess(conceptId) {
  let concept = (state.concepts || []).find(x => x.id === conceptId);
  let grants = [], orgs = [];
  try {
    [grants, orgs] = await Promise.all([
      api(`/api/concept-access?concept_id=${conceptId}`),
      api('/api/organizations'),
    ]);
    if (!concept) concept = await api(`/api/concepts/${conceptId}`);
  } catch (e) {
    showToast('Kunne ikke hente tilganger: ' + e.message, 'error');
    return;
  }

  const grantedOrgIds = new Set(grants.map(g => g.organization_id));
  const availableOrgs = orgs.filter(o => !grantedOrgIds.has(o.id));

  const grantRows = grants.length === 0
    ? `<tr><td colspan="4" class="muted text-center" style="padding:14px;">Ingen bedrifter har lisens ennå</td></tr>`
    : grants.map(g => `
        <tr class="${g.active ? '' : 'row-muted'}">
          <td><strong>${escapeHtml(g.organization_name)}</strong></td>
          <td>${g.license_type === 'credits'
            ? `<span class="badge amber">Credits</span> <span class="col-mono">${g.credits_remaining}</span> igjen <span class="muted" style="font-size:11px;">(av ${g.credits_granted})</span>`
            : '<span class="badge green">Fri lisens</span>'}</td>
          <td>
            <input id="ca-add-${g.id}" type="number" min="1" value="10" style="width:70px;">
            <button class="btn btn-sm btn-secondary" onclick="caAddCredits(${g.id}, ${conceptId})">+ Credits</button>
          </td>
          <td class="col-actions">
            ${g.license_type === 'credits'
              ? `<button class="btn btn-sm btn-ghost" onclick="caSetType(${g.id}, ${conceptId}, 'free')">→ Fri</button>`
              : `<button class="btn btn-sm btn-ghost" onclick="caSetType(${g.id}, ${conceptId}, 'credits')">→ Credits</button>`}
            <button class="btn btn-sm btn-danger" onclick="caRevoke(${g.id}, ${conceptId})">Fjern</button>
          </td>
        </tr>
      `).join('');

  openModal({
    title: `Tilganger: ${concept ? concept.name : 'Konsept'}`,
    size: 'lg',
    body: `
      <div class="panel" style="margin-bottom:16px;">
        <div class="panel-header"><span class="ph-icon">+</span> Gi lisens til bedrift</div>
        <div class="panel-body">
          ${availableOrgs.length === 0
            ? '<div class="muted" style="font-size:13px;">Alle bedrifter har allerede en lisens på dette konseptet.</div>'
            : `
          <div class="field-row">
            <div class="field">
              <label class="field-label">Bedrift</label>
              <select id="ca-org">
                ${availableOrgs.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Lisenstype</label>
              <select id="ca-type" onchange="document.getElementById('ca-credits-wrap').style.display = this.value === 'credits' ? 'block' : 'none';">
                <option value="free">Fri lisens (ubegrenset)</option>
                <option value="credits">Credits (per gjennomføring)</option>
              </select>
            </div>
          </div>
          <div class="field" id="ca-credits-wrap" style="display:none;">
            <label class="field-label">Antall credits</label>
            <input id="ca-credits" type="number" min="1" value="10">
          </div>
          <button class="btn" onclick="caGrant(${conceptId})" style="margin-top:8px;">▶ Gi lisens</button>
          `}
        </div>
      </div>

      <div class="panel">
        <div class="panel-header"><span class="ph-icon">◫</span> Bedrifter med lisens</div>
        <div class="panel-body tight">
          <table class="data-table">
            <thead><tr><th>Bedrift</th><th>Lisens</th><th>Fyll på</th><th class="col-actions">Handling</th></tr></thead>
            <tbody>${grantRows}</tbody>
          </table>
        </div>
      </div>
    `,
    footer: `<button class="btn btn-secondary" onclick="closeModal()">Lukk</button>`,
  });
}

async function caGrant(conceptId) {
  const orgEl = $('#ca-org');
  if (!orgEl) return;
  const organization_id = parseInt(orgEl.value, 10);
  const license_type = $('#ca-type').value;
  const credits = license_type === 'credits' ? (parseInt($('#ca-credits').value, 10) || 0) : 0;
  try {
    await api('/api/concept-access', { method: 'POST', body: { organization_id, concept_id: conceptId, license_type, credits } });
    showToast('Lisens gitt', 'success');
    openConceptAccess(conceptId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function caAddCredits(id, conceptId) {
  const el = $(`#ca-add-${id}`);
  const add_credits = el ? parseInt(el.value, 10) || 0 : 0;
  if (add_credits <= 0) { showToast('Oppgi et positivt antall', 'warn'); return; }
  try {
    await api(`/api/concept-access/${id}`, { method: 'PATCH', body: { add_credits } });
    showToast(`+${add_credits} credits`, 'success');
    openConceptAccess(conceptId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function caSetType(id, conceptId, license_type) {
  try {
    await api(`/api/concept-access/${id}`, { method: 'PATCH', body: { license_type } });
    showToast(license_type === 'free' ? 'Satt til fri lisens' : 'Satt til credits', 'success');
    openConceptAccess(conceptId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function caRevoke(id, conceptId) {
  const ok = await confirmDialog('Fjerne lisensen for denne bedriften?', 'Fjern lisens');
  if (!ok) return;
  try {
    await api(`/api/concept-access/${id}`, { method: 'DELETE' });
    showToast('Lisens fjernet', 'success');
    openConceptAccess(conceptId);
  } catch (e) { showToast(e.message, 'error'); }
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
                  ${u.id === state.user.id ? '' : `<button class="btn btn-sm btn-secondary" onclick="resetUserPassword(${u.id})">Nullstill passord</button>`}
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

// Admin-initiert passord-nullstilling. Backend tillater superadmin for alle,
// og org_admin for brukere i egen bedrift (ikke superadmin). Krever ikke
// gammelt passord — egen-bytte med gammelt passord går via Min profil.
function resetUserPassword(id) {
  const u = (state.users || []).find(x => x.id === id);
  const name = u ? u.name : 'bruker';
  openModal({
    title: 'Nullstill passord',
    body: `
      <p class="muted" style="margin-bottom:12px;">Sett nytt passord for <strong>${escapeHtml(name)}</strong>. Brukeren trenger ikke oppgi det gamle passordet.</p>
      <div class="field">
        <label class="field-label">Nytt passord</label>
        <input id="rp-new" type="password" placeholder="Minst 6 tegn" autocomplete="new-password">
      </div>
      <div class="field">
        <label class="field-label">Gjenta passord</label>
        <input id="rp-new2" type="password" autocomplete="new-password">
      </div>
      <div id="rp-error" class="form-error hidden"></div>
    `,
    footer: `
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn" onclick="modalSubmit()">▶ Nullstill</button>
    `,
    onSubmit: async () => {
      const errEl = $('#rp-error'); errEl.classList.add('hidden');
      const nw = $('#rp-new').value;
      const nw2 = $('#rp-new2').value;
      if (nw.length < 6) { errEl.textContent = 'Passord må være minst 6 tegn'; errEl.classList.remove('hidden'); return; }
      if (nw !== nw2) { errEl.textContent = 'Passordene er ikke like'; errEl.classList.remove('hidden'); return; }
      try {
        await api(`/api/users/${id}/reset-password`, { method: 'POST', body: { new_password: nw } });
        closeModal();
        showToast('Passord nullstilt', 'success');
      } catch (e) { errEl.textContent = e.message; errEl.classList.remove('hidden'); }
    },
  });
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
    localStorage.setItem('gm_token', r.token);
    localStorage.setItem('gm_user', JSON.stringify(r.user));
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
      <div class="stat-card blue"><span class="stat-label">Konsept</span><span class="stat-value" style="font-size:16px;font-family:var(--font-serif);">${escapeHtml(ev.concept_name || '—')}</span></div>
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
