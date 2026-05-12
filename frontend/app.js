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

/* ─── BILDE-OPPLASTING ──────────────────────────────────
   uploadImage(file, opts) — komprimerer bildet i browseren før
   det sendes til backend, som lagrer det i Dropbox og returnerer
   en permanent shared link.

   Argumenter:
     file: File-objekt (fra <input type="file"> eller drag-and-drop)
     opts: { scenario_id, kind, maxWidth, quality, thumbWidth, thumbQuality }
       - scenario_id: påkrevd (heltall)
       - kind: 'coords' | 'cards' | 'backgrounds' (default: 'coords')
       - maxWidth: px (default 1600). Bildet skaleres ned hvis det er bredere.
       - quality: 0..1 (default 0.82). JPEG-kvalitet ved komprimering.
       - thumbWidth: px (default 300). Thumbnail-bredde. Sett til 0 for å droppe thumb.
       - thumbQuality: 0..1 (default 0.7). JPEG-kvalitet for thumb.

   Returnerer: { path, url, thumb_path, thumb_url, size, mimetype }
   ────────────────────────────────────────────────────── */
async function uploadImage(file, opts = {}) {
  if (!file) throw new Error('Ingen fil oppgitt');
  if (!opts.scenario_id) throw new Error('scenario_id er påkrevd');

  const kind = opts.kind || 'coords';
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
        if (xhr.status === 401) logout();
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

/* ─── SVG → PNG EKSPORT ─────────────────────────────────
   Renderer en SVG-streng til en PNG Blob via canvas.
   Eksterne <image href> i SVG-en må være CORS-tilgjengelige.
   Dropbox shared links med dl=0 fungerer ikke i img-elementer
   uten endring — men siden vi allerede henter dem som dl=1
   eller raw=1 i upload-flyten, er det greit.

   Argumenter:
     svgString: <svg>...</svg>-tekst
     width, height: lerret-størrelse i px
     bgColor: bakgrunnsfarge (default hvit)
   Returnerer: Promise<Blob> (image/png)
*/
async function svgToPngBlob(svgString, width, height, bgColor = '#ffffff') {
  // Embedde alle <image href="..."> som data-URLer slik at canvas.drawImage
  // ikke blir tainted av cross-origin-restriksjoner.
  const embedded = await embedExternalImagesInSvg(svgString);

  const blob = new Blob([embedded], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Kunne ikke rendre SVG'));
      i.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);

    return new Promise((resolve, reject) => {
      canvas.toBlob(b => {
        if (b) resolve(b);
        else reject(new Error('toBlob feilet'));
      }, 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* Henter alle <image href="..."> i SVG-en, fetcher dem (via backend-proxy
   for å unngå CORS-problemer) og bytter til data-URL. Dette unngår
   tainted canvas-feil ved drawImage senere.
*/
async function embedExternalImagesInSvg(svgString) {
  const re = /(<image[^>]*\shref=["'])([^"']+)(["'])/g;
  const matches = [];
  let m;
  while ((m = re.exec(svgString)) !== null) {
    matches.push({ full: m[0], pre: m[1], url: m[2], post: m[3], index: m.index });
  }
  if (matches.length === 0) return svgString;

  // Hent alle bilder parallelt via backend-proxy.
  // Direkte fetch mot Dropbox shared links feiler ofte p\u00e5 grunn av CORS
  // (Dropbox redirecter til dl.dropboxusercontent.com som ikke har CORS for
  // alle origins). Backend-proxy henter bildet server-side og sender
  // det videre med CORS=*.
  const replacements = await Promise.all(matches.map(async match => {
    if (match.url.startsWith('data:')) return match;  // allerede embed
    // Dekod HTML-entiteter siden URL-en er hentet fra SVG-attributt
    // der & blir til &amp; ved serialisering.
    const cleanUrl = match.url.replace(/&amp;/g, '&').replace(/&#38;/g, '&');
    try {
      const proxyUrl = `${API}/api/uploads/proxy?url=${encodeURIComponent(cleanUrl)}`;
      const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
      const res = await fetch(proxyUrl, { headers });
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('FileReader-feil'));
        r.readAsDataURL(blob);
      });
      return { ...match, dataUrl };
    } catch (e) {
      console.warn('Kunne ikke embedde bilde:', cleanUrl, e.message);
      return null;
    }
  }));

  // Bytt fra slutten av strengen for å unngå at indekser flytter seg
  let result = svgString;
  replacements.filter(Boolean).reverse().forEach(rep => {
    if (!rep.dataUrl) return;
    const replacement = rep.pre + rep.dataUrl + rep.post;
    result = result.slice(0, rep.index) + replacement + result.slice(rep.index + rep.full.length);
  });
  return result;
}

/* Laster opp en blob (PNG) til Dropbox via /api/uploads/image-endepunktet.
   Backend behandler det som vanlig bilde-opplasting og returnerer shared link.
*/
async function uploadPngBlob(blob, opts) {
  if (!opts || !opts.scenario_id || !opts.filename) {
    throw new Error('uploadPngBlob: scenario_id og filename må oppgis');
  }
  const form = new FormData();
  form.append('file', blob, opts.filename);
  form.append('scenario_id', String(opts.scenario_id));
  form.append('kind', opts.kind || 'cards');
  // PNG-eksporter overskriver alltid eksisterende fil med samme path.
  // Dette er sentralt for redigerings-flyten: lagre p\u00e5 nytt = oppdater samme fil,
  // ikke lag en duplikat med "(1)"-suffix.
  if (opts.overwrite) form.append('overwrite', 'true');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/api/uploads/image');
    if (state.token) xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error((data && data.error) || `HTTP ${xhr.status}`));
    });
    xhr.addEventListener('error', () => reject(new Error('Nettverksfeil')));
    xhr.send(form);
  });
}

/* Gjør et tekststreng trygg for bruk som filnavn. Beholder bokstaver,
   tall og enkelte safe-tegn. Erstatter alt annet med bindestrek.
*/
function sanitizeFilename(name) {
  if (!name) return 'uten-navn';
  return String(name)
    .normalize('NFKD')
    // norske tegn
    .replace(/æ/gi, 'ae').replace(/ø/gi, 'oe').replace(/å/gi, 'aa')
    // fjern diakritiske tegn
    .replace(/[\u0300-\u036f]/g, '')
    // bytt alt utenom a-z 0-9 _ - med bindestrek
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    // fjern ledende/etterfølgende bindestreker og kollapssende sekvenser
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 60) || 'uten-navn';
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
  // Rydd block-pick-modus ved view-bytte (pin ikke gyldig utenfor scenario-editor)
  if (typeof blockEditorState !== 'undefined') {
    blockEditorState.pickMode = false;
    blockEditorState.activeBlockId = null;
    const pin = $('#block-pick-pin');
    if (pin) pin.style.display = 'none';
  }
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
  // Hvis pick-modus ikke er aktivt (eller block-editor er ikke åpen lenger),
  // sørg for at pin er skjult.
  if (typeof blockEditorState !== 'undefined') {
    if (!blockEditorState.pickMode) {
      const pin = $('#block-pick-pin');
      if (pin) pin.style.display = 'none';
    }
  }
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
                    <button class="btn btn-sm btn-secondary" onclick="testScenarioById(${s.id})" title="Åpne i deltagerfrontend">▶ Test</button>
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
   SCENARIO EDITOR — investigation board, koordinater, kort, regler
   ──────────────────────────────────────────────────────── */
let scenarioBuf = null;
let editingCoordIdx = -1;
let editingCardId = null;
let activeScTab = 'meta';

// Board-builder state (kun for UI, ikke lagret)
const boardState = {
  draggingCard: null,        // { cardId, mode: 'move'|'resize', offsetX, offsetY }
  selectedCoord: null,       // {x, y}
  selectedCard: null,
  hideCards: false,          // skjul kort-grafikk på board, vis kun ankermarkører
  liveInfo: null,            // { card, anchorXY, coordXY } — vises mens kort dras
  zoom: 1.0,                 // 0.25 - 2.0, applikert som CSS transform p\u00e5 inner-canvas
  fullscreen: false,         // true n\u00e5r board-canvas vises i fullscreen
};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.15;

/* ─── TEST SCENARIO ─────────────────────────────────────
   Åpner deltagerfrontenden (play.html) i en ny fane med
   det valgte scenarioet lastet inn — uten lagnavn og uten
   startkode. Brukes til å teste et scenario raskt.
   ─────────────────────────────────────────────────────── */
function getPlayUrl() {
  return location.origin + '/play.html';
}

/* Editorens reward-struktur konverteres til play.html sitt format */
function adaptScenarioForPlay(scenario) {
  const out = JSON.parse(JSON.stringify(scenario));
  const sd = out.scenario_data || (out.scenario_data = { coordinates: [], settings: {} });
  if (!Array.isArray(sd.coordinates)) sd.coordinates = [];

  sd.coordinates = sd.coordinates.map((c, ci) => {
    const rewards = Array.isArray(c.rewards) ? c.rewards : [];
    const questions = [];
    const otherPayload = [];
    rewards.forEach((r, ri) => {
      if (!r || !r.type) return;
      if (r.type === 'question') {
        questions.push({
          id: `q_${ci}_${ri}`,
          text: r.text || '',
          options: Array.isArray(r.options) ? r.options.slice() : ['', '', '', ''],
          correct: typeof r.correct === 'number' ? r.correct : 0,
          points: r.points || 5,
        });
      } else if (r.type === 'clue') {
        otherPayload.push({
          type: 'clue',
          title: r.title || 'Clue',
          text: r.text || '',
          note: r.note || '',
        });
      } else if (r.type === 'poi') {
        otherPayload.push({
          type: 'poi',
          name: r.name || 'Unknown',
          subtitle: r.subtitle || '',
          note: r.note || '',
        });
      } else if (r.type === 'unlock') {
        otherPayload.push({
          type: 'unlock',
          lockName: r.title || 'Lock',
          code: r.code || (r.text || '').slice(0, 32) || '— — — —',
          description: r.description || r.text || '',
        });
      }
    });

    const payload = [...otherPayload];
    if (questions.length > 0) {
      payload.push({
        type: 'questions',
        title: `Spørsmål – (${c.x}, ${c.y})`,
        questions,
      });
    }

    const rawCode = c.code != null ? String(c.code).trim() : '';
    const isNumeric = rawCode !== '' && /^\d+$/.test(rawCode);

    return {
      x: c.x,
      y: c.y,
      code: isNumeric ? parseInt(rawCode, 10) : rawCode,
      codeIsText: !isNumeric,
      points: c.points ?? 10,
      payload,
    };
  });

  return out;
}

function launchTestPlay(scenario, opts = {}) {
  if (!scenario || !scenario.scenario_data) {
    showToast('Scenarioet mangler innhold', 'error');
    return;
  }
  const coords = scenario.scenario_data.coordinates || [];
  if (coords.length === 0) {
    if (!confirm('Dette scenarioet har ingen koordinater enda. Åpne testmodus likevel?')) return;
  }
  const adapted = adaptScenarioForPlay(scenario);
  try {
    sessionStorage.setItem('escapebox_test_scenario', JSON.stringify({
      scenario: adapted,
      teamName: opts.teamName || 'Test Team',
      ts: Date.now(),
    }));
  } catch (e) {
    showToast('Kunne ikke lagre i sessionStorage: ' + e.message, 'error');
    return;
  }
  const w = window.open(getPlayUrl(), '_blank');
  if (!w) {
    showToast('Pop-up blokkert. Tillat pop-ups for å teste.', 'error');
  } else {
    showToast('Testmodus åpnet i ny fane', 'success');
  }
}

async function testScenarioById(id) {
  try {
    const sc = await api(`/api/scenarios/${id}`);
    launchTestPlay(sc);
  } catch (e) {
    showToast('Kunne ikke hente scenario: ' + e.message, 'error');
  }
}

function testCurrentScenario() {
  if (!scenarioBuf) {
    showToast('Ingen scenario åpen', 'error');
    return;
  }
  const liveBuf = JSON.parse(JSON.stringify(scenarioBuf));
  const nameEl = $('#sc-meta-name');
  const descEl = $('#sc-meta-desc');
  const timeEl = $('#sc-meta-time');
  if (nameEl) liveBuf.name = nameEl.value.trim() || liveBuf.name;
  if (descEl) liveBuf.description = descEl.value.trim() || liveBuf.description;
  if (timeEl) {
    const mins = parseInt(timeEl.value, 10);
    if (mins > 0) liveBuf.time_limit_seconds = mins * 60;
  }
  const setEl = $('#set-time-en');
  if (setEl) {
    const s = liveBuf.scenario_data.settings || {};
    s.time_limit_enabled = setEl.checked;
    s.show_score = $('#set-show-score')?.checked ?? s.show_score;
    s.penalty_enabled = $('#set-pen-en')?.checked ?? s.penalty_enabled;
    s.penalty_amount = parseInt($('#set-pen-amount')?.value, 10) || s.penalty_amount;
    s.penalty_escalation = $('#set-pen-esc')?.checked ?? s.penalty_escalation;
    s.penalty_escalation_after = parseInt($('#set-pen-after')?.value, 10) || s.penalty_escalation_after;
    s.penalty_escalation_amount = parseInt($('#set-pen-esc-amount')?.value, 10) || s.penalty_escalation_amount;
    liveBuf.scenario_data.settings = s;
  }
  launchTestPlay(liveBuf);
}

async function openScenarioEditor(scenarioId) {
  state.currentScenarioId = scenarioId;
  const sc = await api(`/api/scenarios/${scenarioId}`);
  scenarioBuf = JSON.parse(JSON.stringify(sc));
  ensureScenarioShape(scenarioBuf);
  editingCoordIdx = -1;
  editingCardId = null;
  activeScTab = 'meta';
  boardState.selectedCoord = null;
  boardState.selectedCard = null;

  openModal({
    title: 'Scenario: ' + sc.name,
    size: 'xl',
    body: renderScenarioEditor(),
    footer: `
      <div id="sc-zoom-controls" class="sc-zoom-controls ${activeScTab === 'board' ? '' : 'hidden'}">
        <button class="bb-tool-btn" onclick="zoomBoardOut()" title="Zoom ut">\u2212</button>
        <button class="bb-tool-btn bb-tool-zoom" onclick="resetBoardZoom()" title="Tilbakestill zoom" id="bb-zoom-pct">100%</button>
        <button class="bb-tool-btn" onclick="zoomBoardIn()" title="Zoom inn">+</button>
        <button class="bb-tool-btn" onclick="fitBoardToView()" title="Tilpass til skjerm">\u26f6 Tilpass</button>
        <button class="bb-tool-btn" onclick="toggleBoardFullscreen()" title="Fullskjerm" id="bb-fs-btn">\u26f6 Fullskjerm</button>
      </div>
      <button class="btn btn-secondary" onclick="closeModal()">Avbryt</button>
      <button class="btn btn-secondary" onclick="testCurrentScenario()" title="Åpne i deltagerfrontend uten å lagre">▶ Test scenario</button>
      <button class="btn btn-success" onclick="saveScenario()">⤳ Lagre endringer</button>
    `,
  });
}

function ensureScenarioShape(sc) {
  if (!sc.scenario_data) sc.scenario_data = {};
  const sd = sc.scenario_data;
  if (!sd.grid) sd.grid = { x: 20, y: 15, cell_size: 50, show_labels: true };
  if (!Array.isArray(sd.coordinates)) sd.coordinates = [];
  if (!Array.isArray(sd.physical_cards)) sd.physical_cards = [];
  if (!Array.isArray(sd.blocks)) sd.blocks = [];
  if (!sd.settings) sd.settings = {};

  // Sørg for at hver koordinat har en stabil id (blocks refererer via id)
  sd.coordinates.forEach(c => {
    if (!c.id) c.id = 'coord_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
    // Fjern gamle reward-data — vi har gjort en rein start
    if (c.rewards !== undefined) delete c.rewards;
  });

  // Slett gamle blocks. To gamle formater finnes:
  // 1) template-editor-format: har content.layers eller mangler content_type
  // 2) første iter av strukturerte blocks: har content_type + content (men ikke items)
  // Nytt format: har items-array.
  // Begge gamle formater slettes ved første lasting.
  sd.blocks = sd.blocks.filter(b => {
    const hasItems = Array.isArray(b.items);
    if (!hasItems) {
      console.warn('[Blocks] Slettet gammel block:', b.name || b.id);
      return false;
    }
    return true;
  });

  // Migrer blocks (sett standard-felt på hver)
  sd.blocks.forEach(b => ensureBlockShape(b));
}

// Generer en kort, lesbar id med prefix
function genBlockId() {
  return 'block_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
}

function renderScenarioEditor() {
  return `
    <div style="display:flex;gap:0;border-bottom:2px solid var(--rule);margin-bottom:18px;">
      <button class="tab-btn ${activeScTab === 'meta' ? 'active' : ''}" data-tab="meta" onclick="switchScTab('meta')">Generelt</button>
      <button class="tab-btn ${activeScTab === 'board' ? 'active' : ''}" data-tab="board" onclick="switchScTab('board')">Investigation board</button>
      <button class="tab-btn ${activeScTab === 'coords' ? 'active' : ''}" data-tab="coords" onclick="switchScTab('coords')">Koordinater & kort</button>
      <button class="tab-btn ${activeScTab === 'settings' ? 'active' : ''}" data-tab="settings" onclick="switchScTab('settings')">Spillregler</button>
    </div>

    <style>
      .tab-btn { background:transparent;border:none;padding:10px 18px;font-family:var(--font-cond);font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink3);cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px; }
      .tab-btn.active { color:var(--ink);border-bottom-color:var(--ink); }
      .tab-btn:hover { color:var(--ink); }
    </style>

    <div id="sc-tab-meta" class="sc-tab ${activeScTab !== 'meta' ? 'hidden' : ''}">${renderScMetaTab()}</div>
    <div id="sc-tab-board" class="sc-tab ${activeScTab !== 'board' ? 'hidden' : ''}">${renderScBoardTab()}</div>
    <div id="sc-tab-coords" class="sc-tab ${activeScTab !== 'coords' ? 'hidden' : ''}">${renderScCoordsTab()}</div>
    <div id="sc-tab-settings" class="sc-tab ${activeScTab !== 'settings' ? 'hidden' : ''}">${renderScSettingsTab()}</div>
  `;
}

function switchScTab(name) {
  activeScTab = name;
  $$('#modal .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('#modal .sc-tab').forEach(t => t.classList.add('hidden'));
  $('#sc-tab-' + name).classList.remove('hidden');
  // Zoom-kontrollene i footer er kun relevante p\u00e5 board-fanen
  const zoomCtrls = $('#sc-zoom-controls');
  if (zoomCtrls) zoomCtrls.classList.toggle('hidden', name !== 'board');
  if (name === 'board') renderBoard();
  if (name === 'coords') {
    renderCoordList();
    renderCoordDetail();
  }
}

/* ─── META TAB ──────────────────────────────────────── */
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

/* ─── SETTINGS TAB ──────────────────────────────────── */
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

/* ════════════════════════════════════════════════════════
   INVESTIGATION BOARD TAB — grid + fysiske kort
   ──────────────────────────────────────────────────────── */
function renderScBoardTab() {
  const g = scenarioBuf.scenario_data.grid;
  return `
    <div class="board-builder">
      <div class="board-sidebar">

        <div class="board-config">
          <h4>Grid-dimensjoner</h4>
          <div class="field-row">
            <div class="field">
              <label class="field-label">X-ruter</label>
              <input id="bb-x" type="number" min="2" max="60" value="${g.x}" oninput="updateGrid('x', this.value)">
            </div>
            <div class="field">
              <label class="field-label">Y-ruter</label>
              <input id="bb-y" type="number" min="2" max="60" value="${g.y}" oninput="updateGrid('y', this.value)">
            </div>
          </div>
          <div class="field">
            <label class="field-label">Cellestørrelse (px)</label>
            <input id="bb-cs" type="number" min="20" max="120" value="${g.cell_size}" oninput="updateGrid('cell_size', this.value)">
          </div>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin-bottom:0;">
            <input id="bb-labels" type="checkbox" ${g.show_labels !== false ? 'checked' : ''} style="width:auto;" onchange="updateGrid('show_labels', this.checked)">
            <span style="font-size:12px;">Vis koordinatlabels</span>
          </label>
          <div class="bb-derived" id="bb-derived">
            ${g.x * g.y} ruter · ${g.x * g.cell_size}×${g.y * g.cell_size} px
          </div>
        </div>

        <div class="board-config">
          <h4>Fysiske kort</h4>
          <button class="btn btn-sm btn-secondary" style="width:100%;" onclick="createTemplateCard()">+ Nytt kort</button>
          <label class="field" style="flex-direction:row;align-items:center;gap:8px;margin:8px 0 0 0;font-size:12px;cursor:pointer;">
            <input type="checkbox" ${boardState.hideCards ? 'checked' : ''} style="width:auto;" onchange="toggleHideCards(this.checked)">
            <span>Skjul kort (vis kun ankere)</span>
          </label>
          <div class="bb-cards-list" id="bb-cards-list"></div>
        </div>

        <div class="board-config" id="board-anchors-panel">
          <h4>Ankere</h4>
          <div id="bb-anchor-list"></div>
        </div>

        <div class="board-config" id="board-blocks-panel">
          <h4 style="display:flex;align-items:center;gap:6px;">
            <span>Blocks</span>
            <span class="muted" id="bb-block-count" style="font-size:10px;font-weight:400;letter-spacing:0;text-transform:none;">(0)</span>
            <span style="flex:1;"></span>
            <button class="btn btn-sm btn-secondary" style="padding:3px 8px;font-size:11px;" onclick="createBlock()">+ Ny</button>
          </h4>
          <div class="muted" style="font-size:11px;margin-bottom:6px;line-height:1.4;">
            Informasjonspaneler som utløses av kort/koordinater. Klikk for å redigere.
          </div>
          <div id="bb-block-list"></div>
        </div>

        <div class="board-config" id="board-live-info" style="${boardState.liveInfo ? '' : 'display:none;'}">
          <h4>Posisjon</h4>
          <div id="bb-live-info-body"></div>
        </div>

        <div class="board-config">
          <h4>Aktive koordinater</h4>
          <div class="muted" style="font-size:11px;margin-bottom:6px;">
            Klikk på en rute i grid-et for å redigere. Aktive koordinater vises i gult.
          </div>
          <div class="bb-coord-list-mini" id="bb-coord-list-mini"></div>
        </div>

      </div>

      <div class="board-canvas-wrap" id="board-canvas-wrap">
        <div class="board-canvas-scroll" id="board-canvas-scroll">
          <div class="board-canvas-inner" id="board-canvas-inner">
            <!-- SVG injiseres her -->
          </div>
        </div>
      </div>
    </div>
    <style>
      .board-builder { position:relative; }
      /* Fullskjerm legges p\u00e5 board-builder slik at sidefelt + canvas vises sammen */
      .board-builder.is-fullscreen {
        position:fixed; inset:0; z-index:9999;
        background:var(--bg);
        padding:14px;
        overflow:hidden;
      }
      .board-builder.is-fullscreen .board-sidebar {
        max-height:calc(100vh - 28px);
        overflow-y:auto;
      }
      .board-builder.is-fullscreen .board-canvas-wrap {
        height:calc(100vh - 28px);
      }

      .board-canvas-wrap {
        position:relative;
        display:flex; flex-direction:column;
      }
      .board-canvas-scroll {
        flex:1;
        overflow:auto;
        max-height:calc(100vh - 280px);
      }
      .board-builder.is-fullscreen .board-canvas-scroll {
        max-height:none;
      }
      .board-canvas-inner {
        transform-origin: 0 0;
        transition: transform 0.12s ease-out;
      }

      /* Zoom-kontrollene plasseres i modal-footer til venstre for handlingsknappene */
      .sc-zoom-controls {
        display:flex; gap:6px; align-items:center;
        margin-right:auto;  /* dytter handlingsknappene til h\u00f8yre */
      }
      .sc-zoom-controls.hidden { display:none; }
      .bb-tool-btn {
        background:var(--paper); border:1px solid var(--rule); color:var(--ink);
        font-family:var(--font-cond); font-size:13px; font-weight:700;
        padding:6px 12px; border-radius:3px; cursor:pointer;
        transition:background 0.12s, border-color 0.12s;
      }
      .bb-tool-btn:hover { background:var(--blue-bg); border-color:var(--blue); }
      .bb-tool-btn:active { transform:translateY(1px); }
      .bb-tool-zoom { min-width:60px; font-family:var(--font-mono); }
    </style>
  `;
}

function updateGrid(field, value) {
  const g = scenarioBuf.scenario_data.grid;
  if (field === 'show_labels') {
    g.show_labels = !!value;
  } else {
    g[field] = Math.max(2, parseInt(value, 10) || 2);
  }
  // Oppdater avledet info
  const d = $('#bb-derived');
  if (d) d.textContent = `${g.x * g.y} ruter · ${g.x * g.cell_size}×${g.y * g.cell_size} px`;
  renderBoard();
}

function toggleHideCards(checked) {
  boardState.hideCards = !!checked;
  renderBoard();
}

/* ─── ZOOM OG FULLSKJERM FOR INVESTIGATION BOARD ─────────
   Zoom realiseres som CSS transform: scale() p\u00e5 inner-canvas.
   Dette unng\u00e5r SVG-rerendering ved hver zoom-endring og
   bevarer all interaktivitet (drag, klikk, hover).

   Drag-koordinater m\u00e5 kompenseres for zoom — se onCardMouseMove.
   Det gj\u00f8res ved \u00e5 dele drag-distansen p\u00e5 cs * zoom.
   ─────────────────────────────────────────────────────── */
function applyBoardZoom() {
  const inner = $('#board-canvas-inner');
  if (inner) inner.style.transform = `scale(${boardState.zoom})`;
  const pct = $('#bb-zoom-pct');
  if (pct) pct.textContent = `${Math.round(boardState.zoom * 100)}%`;
}

function zoomBoardIn() {
  boardState.zoom = Math.min(ZOOM_MAX, boardState.zoom + ZOOM_STEP);
  applyBoardZoom();
}

function zoomBoardOut() {
  boardState.zoom = Math.max(ZOOM_MIN, boardState.zoom - ZOOM_STEP);
  applyBoardZoom();
}

function resetBoardZoom() {
  boardState.zoom = 1.0;
  applyBoardZoom();
}

/* Beregner og setter zoom slik at hele boardet f\u00e5r plass i scroll-omr\u00e5det */
function fitBoardToView() {
  const scroll = $('#board-canvas-scroll');
  const inner = $('#board-canvas-inner');
  const svg = inner?.querySelector('svg');
  if (!scroll || !svg) return;
  const viewW = scroll.clientWidth - 20;
  const viewH = scroll.clientHeight - 20;
  // Bruk SVG sin attributtbredde/h\u00f8yde, ikke getBBox (zoom kan p\u00e5virke det)
  const svgW = parseFloat(svg.getAttribute('width')) || svg.clientWidth;
  const svgH = parseFloat(svg.getAttribute('height')) || svg.clientHeight;
  if (!svgW || !svgH) return;
  const scale = Math.min(viewW / svgW, viewH / svgH);
  boardState.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale));
  applyBoardZoom();
}

function toggleBoardFullscreen() {
  // Fullskjerm legges p\u00e5 board-builder (sidefelt + canvas) slik at hele
  // arbeidsflaten utvides. Bruker en CSS-klasse for forutsigbar oppf\u00f8rsel
  // inni modaler — native Fullscreen API legges til som tillegg.
  const builder = document.querySelector('.board-builder');
  if (!builder) return;

  if (!boardState.fullscreen) {
    builder.classList.add('is-fullscreen');
    boardState.fullscreen = true;
    const btn = $('#bb-fs-btn');
    if (btn) btn.textContent = '\u2715 Lukk fullskjerm';
    if (builder.requestFullscreen) {
      builder.requestFullscreen().catch(() => { /* native fs er valgfritt */ });
    }
  } else {
    builder.classList.remove('is-fullscreen');
    boardState.fullscreen = false;
    const btn = $('#bb-fs-btn');
    if (btn) btn.textContent = '\u26f6 Fullskjerm';
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }
}

// Lukk fullskjerm hvis brukeren trykker Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && boardState.fullscreen) {
    toggleBoardFullscreen();
  }
});

/* Returnerer en liste over ankere på board, med navn A, B, C, ...
   Hvert objekt: { card_id, name, x, y, label } der x,y er board-koordinater.
   Rekkefølgen er stabil — basert på kortets posisjon i physical_cards-arrayet.
   Manuelt anker-navn (card.anchor_name) overstyrer auto-genereringen.
*/
function getBoardAnchors() {
  const cards = scenarioBuf?.scenario_data?.physical_cards || [];
  const anchors = [];
  cards.forEach(card => {
    if (card.type !== 'template') return;
    if (card.in_stash) return;  // bunke-kort har ingen plass på board
    const anchorOverlay = (card.overlays || []).find(o => o.type === 'anchor');
    if (!anchorOverlay) return;
    anchors.push({
      card_id: card.id,
      x: (card.grid_x || 0) + anchorOverlay.col,
      y: (card.grid_y || 0) + anchorOverlay.row,
      card,
    });
  });
  // Tildel A, B, C, ...
  // Hvis kortet har et lagret anchor_name, bruk det. Ellers neste ledige bokstav.
  const usedLabels = new Set();
  anchors.forEach(a => {
    if (a.card.anchor_name) {
      a.label = a.card.anchor_name;
      usedLabels.add(a.label);
    }
  });
  let nextChar = 65; // 'A'
  anchors.forEach(a => {
    if (a.label) return;
    while (usedLabels.has(String.fromCharCode(nextChar)) && nextChar <= 90) nextChar++;
    if (nextChar <= 90) {
      a.label = String.fromCharCode(nextChar);
      usedLabels.add(a.label);
      nextChar++;
    } else {
      a.label = '?';
    }
  });
  return anchors;
}

function setAnchorName(cardId, name) {
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === cardId);
  if (!card) return;
  const v = (name || '').trim().toUpperCase().slice(0, 1);
  if (v && /^[A-Z]$/.test(v)) {
    card.anchor_name = v;
  } else {
    delete card.anchor_name;
  }
  renderBoard();
}

/* ─── AUTO-SYNK KOORDINATER FRA KORT ─────────────────────
   tilsvarende oppføring i scenarios's coordinates-liste basert
   på kortets plassering på board.

   Datakontrakt:
   - Auto-genererte koordinater har felt `from_card: <card_id>`
   - Manuelle koordinater har ingen `from_card`
   - Når et kort flyttes, oppdateres koordinatets X,Y
   - Når et kort slettes eller mister koord-overlay, fjernes den auto-koordinaten
   - Manuelle koordinater berøres aldri av denne funksjonen
   - 4-koden fra kortets header blir koordinatets `code`
   ─────────────────────────────────────────────────────── */
function syncCoordsFromCards() {
  if (!scenarioBuf || !scenarioBuf.scenario_data) return;
  const sd = scenarioBuf.scenario_data;
  if (!Array.isArray(sd.coordinates)) sd.coordinates = [];
  if (!Array.isArray(sd.physical_cards)) sd.physical_cards = [];

  // Bygg map av eksisterende auto-koordinater per kort-ID
  const existingByCard = {};
  sd.coordinates.forEach((c, idx) => {
    if (c.from_card) existingByCard[c.from_card] = { coord: c, idx };
  });

  // Behold manuelle (uten from_card) urørt
  const stillValid = new Set();

  sd.physical_cards.forEach(card => {
    if (card.type !== 'template') return;
    if (card.in_stash) return;  // bunke-kort genererer ikke koordinater
    if (!Array.isArray(card.overlays)) return;
    const coordOverlay = card.overlays.find(o => o.type === 'coord');
    if (!coordOverlay) return;

    // Beregn faktisk X,Y på board
    const x = (card.grid_x || 0) + coordOverlay.col;
    const y = (card.grid_y || 0) + coordOverlay.row;

    stillValid.add(card.id);

    if (existingByCard[card.id]) {
      // Oppdater eksisterende
      const c = existingByCard[card.id].coord;
      c.x = x;
      c.y = y;
      // Synk 4-koden fra kortets header
      const code = (card.header?.code || '').trim();
      if (code) c.code = code;
    } else {
      // Opprett ny
      sd.coordinates.push({
        id: 'coord_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now(),
        x, y,
        code: (card.header?.code || '').trim(),
        points: 10,
        from_card: card.id,
      });
    }
  });

  // Fjern auto-koordinater for kort som er slettet eller har mistet koord-overlay
  sd.coordinates = sd.coordinates.filter(c => {
    if (!c.from_card) return true;  // manuelle beholdes
    return stillValid.has(c.from_card);
  });
}

function renderBoard() {
  const wrap = $('#board-canvas-inner');
  if (!wrap) return;
  // Synkroniser auto-genererte koordinater fra template-kort før rendering
  syncCoordsFromCards();
  const g = scenarioBuf.scenario_data.grid;
  const cs = g.cell_size;
  const showLabels = g.show_labels !== false;
  // Akse-margin: plass til kolonne- og rad-overskrifter rundt gridet
  const M = showLabels ? Math.max(22, Math.round(cs * 0.5)) : 0;
  const innerW = g.x * cs;
  const innerH = g.y * cs;
  const W = innerW + M * 2;
  const H = innerH + M * 2;
  const coordsByXY = {};
  scenarioBuf.scenario_data.coordinates.forEach((c, i) => {
    coordsByXY[`${c.x},${c.y}`] = i;
  });

  // Bygg trigger-oppslag for aktiv block (vises som ring rundt celler/kort)
  const activeBlock = (blockEditorState && blockEditorState.activeBlockId)
    ? scenarioBuf.scenario_data.blocks.find(b => b.id === blockEditorState.activeBlockId)
    : null;
  const triggeredCoordIds = activeBlock ? new Set(activeBlock.triggered_by_coords || []) : new Set();
  const triggeredCardIds = activeBlock ? new Set(activeBlock.triggered_by_cards || []) : new Set();

  // Bygg SVG. Hele grid-rendering forskyves med (M, M) slik at akse-overskriftene
  // kan plasseres i marginen rundt.
  let svg = `<svg class="board-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // Bakgrunn (papir)
  svg += `<rect width="${W}" height="${H}" fill="#fbfaf6"/>`;

  // Akse-bakgrunn (litt m\u00f8rkere) for ramme-effekten
  if (showLabels) {
    svg += `<rect x="0" y="0" width="${W}" height="${M}" fill="#f0eadb"/>`;
    svg += `<rect x="0" y="${H - M}" width="${W}" height="${M}" fill="#f0eadb"/>`;
    svg += `<rect x="0" y="0" width="${M}" height="${H}" fill="#f0eadb"/>`;
    svg += `<rect x="${W - M}" y="0" width="${M}" height="${H}" fill="#f0eadb"/>`;

    // Kolonne-overskrifter (X) — \u00f8verst og nederst
    const colFz = Math.max(10, Math.min(16, cs * 0.32));
    for (let x = 0; x < g.x; x++) {
      const px = M + x * cs + cs / 2;
      svg += `<text x="${px}" y="${M / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, var(--font-mono)" font-size="${colFz}" font-weight="700" fill="var(--ink)">${x}</text>`;
      svg += `<text x="${px}" y="${H - M / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, var(--font-mono)" font-size="${colFz}" font-weight="700" fill="var(--ink)">${x}</text>`;
    }
    // Rad-overskrifter (Y) — venstre og h\u00f8yre
    for (let y = 0; y < g.y; y++) {
      const py = M + y * cs + cs / 2;
      svg += `<text x="${M / 2}" y="${py}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, var(--font-mono)" font-size="${colFz}" font-weight="700" fill="var(--ink)">${y}</text>`;
      svg += `<text x="${W - M / 2}" y="${py}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, var(--font-mono)" font-size="${colFz}" font-weight="700" fill="var(--ink)">${y}</text>`;
    }
    // Linjer rundt aksene
    svg += `<line x1="0" y1="${M}" x2="${W}" y2="${M}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    svg += `<line x1="0" y1="${H - M}" x2="${W}" y2="${H - M}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    svg += `<line x1="${M}" y1="0" x2="${M}" y2="${H}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    svg += `<line x1="${W - M}" y1="0" x2="${W - M}" y2="${H}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
  }

  // Hele grid-omr\u00e5det wrappes i en <g> som forskyves
  svg += `<g transform="translate(${M},${M})">`;

  // Inner-bakgrunn
  svg += `<rect width="${innerW}" height="${innerH}" fill="#fbfaf6"/>`;

  // Ruter (uten tall i hver — nå har vi akser i marginen)
  for (let y = 0; y < g.y; y++) {
    for (let x = 0; x < g.x; x++) {
      const idx = coordsByXY[`${x},${y}`];
      const has = idx !== undefined;
      const sel = boardState.selectedCoord && boardState.selectedCoord.x === x && boardState.selectedCoord.y === y;
      const coordId = has ? scenarioBuf.scenario_data.coordinates[idx]?.id : null;
      const isTrigger = coordId && triggeredCoordIds.has(coordId);
      const cls = `board-cell-rect${has ? ' has-coord' : ''}${sel ? ' selected' : ''}${isTrigger ? ' is-trigger' : ''}`;
      svg += `<rect class="${cls}" x="${x*cs}" y="${y*cs}" width="${cs}" height="${cs}" data-x="${x}" data-y="${y}" onclick="onCellClick(${x},${y})"/>`;
    }
  }

  // Fysiske kort på toppen
  scenarioBuf.scenario_data.physical_cards.forEach(card => {
    if (card.in_stash) return;  // bunke-kort vises ikke p\u00e5 board
    const cx = card.grid_x * cs;
    const cy = card.grid_y * cs;
    const cw = card.grid_w * cs;
    const ch = card.grid_h * cs;
    const sel = boardState.selectedCard === card.id;
    const imgSrc = card.image_url || card.image_path;

    // Skjul kort-grafikk når toggle er på, men kortets <g>-wrapper må fortsatt finnes
    // (uten den kan man ikke dra det). Vi tegner bare en transparent ramme.
    const trig = triggeredCardIds.has(card.id) ? ' is-trigger' : '';
    if (boardState.hideCards) {
      svg += `<g class="board-physical-card${sel ? ' selected' : ''}${trig}" data-card="${card.id}" onmousedown="onCardMouseDown(event, '${card.id}')">`;
      svg += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="transparent" stroke="${sel ? 'var(--blue)' : 'rgba(0,0,0,0.1)'}" stroke-width="${sel ? 2 : 1}" stroke-dasharray="${sel ? '4 3' : '2 4'}" style="cursor:move;"/>`;
      if (sel) {
        svg += `<circle class="board-resize-handle" cx="${cx + cw}" cy="${cy + ch}" r="6" data-handle="se" onmousedown="onCardMouseDown(event, '${card.id}', 'resize-se')"/>`;
        if (card.type === 'template') {
          const btnY = cy - 28;
          const btnX = cx + cw - 78;
          svg += `<g style="cursor:pointer;" onclick="event.stopPropagation();openTemplateEditor('${card.id}')" onmousedown="event.stopPropagation();">`;
          svg += `<rect x="${btnX}" y="${btnY}" width="78" height="22" rx="3" fill="var(--ink)" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>`;
          svg += `<text x="${btnX + 39}" y="${btnY + 11}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-cond)" font-size="11" font-weight="700" fill="#fff">\u270e Rediger</text>`;
          svg += `</g>`;
        }
      }
      svg += `</g>`;
      return;
    }

    svg += `<g class="board-physical-card${sel ? ' selected' : ''}${trig}" data-card="${card.id}" onmousedown="onCardMouseDown(event, '${card.id}')">`;

    if (card.uploading) {
      svg += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="#eee" stroke="#bbb" stroke-dasharray="4 3"/>`;
      const pct = Math.round((card.progress || 0) * 100);
      svg += `<text x="${cx + cw/2}" y="${cy + ch/2}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-cond)" font-size="14" fill="#666">Laster... ${pct}%</text>`;
    } else if (card.type === 'template') {
      // Template-kort — render som mini-rutenett av cellene
      svg += renderTemplateOnBoard(card, cx, cy, cw, ch, sel);
    } else if (imgSrc) {
      svg += `<image href="${escapeHtml(imgSrc)}" x="${cx}" y="${cy}" width="${cw}" height="${ch}" preserveAspectRatio="xMidYMid meet" style="pointer-events:none;"/>`;
      svg += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="transparent" stroke="${sel ? 'var(--blue)' : 'var(--ink2)'}" stroke-width="${sel ? 2 : 1}" stroke-dasharray="${sel ? '4 3' : 'none'}" style="cursor:move;"/>`;
    } else {
      svg += `<rect class="bg" x="${cx}" y="${cy}" width="${cw}" height="${ch}"/>`;
      svg += `<text x="${cx + cw/2}" y="${cy + ch/2}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-cond)" font-size="14" fill="var(--blue)">${escapeHtml(card.name || 'Kort')}</text>`;
    }
    if (sel) {
      svg += `<circle class="board-resize-handle" cx="${cx + cw}" cy="${cy + ch}" r="6" data-handle="se" onmousedown="onCardMouseDown(event, '${card.id}', 'resize-se')"/>`;
      // Rediger-knapp for template-kort (\u00f8verst til h\u00f8yre, over kortet)
      if (card.type === 'template') {
        const btnY = cy - 28;
        const btnX = cx + cw - 78;
        svg += `<g style="cursor:pointer;" onclick="event.stopPropagation();openTemplateEditor('${card.id}')" onmousedown="event.stopPropagation();">`;
        svg += `<rect x="${btnX}" y="${btnY}" width="78" height="22" rx="3" fill="var(--ink)" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>`;
        svg += `<text x="${btnX + 39}" y="${btnY + 11}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-cond)" font-size="11" font-weight="700" fill="#fff">\u270e Rediger</text>`;
        svg += `</g>`;
      }
    }
    svg += `</g>`;
  });

  // ANKER-MARKØRER PÅ BOARD med bokstav-labels.
  // Vises kun når "Skjul kort" er på — ellers er ankrene allerede tegnet
  // som del av kortet i renderTemplateOnBoard().
  if (boardState.hideCards) {
    const anchors = getBoardAnchors();
    anchors.forEach(a => {
      const ax = a.x * cs + cs / 2;
      const ay = a.y * cs + cs / 2;
      svg += renderAnchorSvg(ax, ay, cs * 0.55, '#b83228');
      const labelR = cs * 0.18;
      const lx = a.x * cs + cs - labelR - 2;
      const ly = a.y * cs + labelR + 2;
      svg += `<circle cx="${lx}" cy="${ly}" r="${labelR}" fill="#b83228" stroke="#fff" stroke-width="1.5" pointer-events="none"/>`;
      svg += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-cond)" font-size="${labelR * 1.3}" font-weight="700" fill="#fff" pointer-events="none">${escapeHtml(a.label)}</text>`;
    });
  }

  svg += `</g>`;  // lukker grid-wrapper-gruppen
  svg += `</svg>`;
  wrap.innerHTML = svg;

  // Marker board hvis vi er i pick-modus (CSS-overlay)
  wrap.classList.toggle('is-pick-mode', !!(blockEditorState && blockEditorState.pickMode && blockEditorState.activeBlockId));

  // Re-applikere zoom-tilstand siden innerHTML-erstatning ikke bevarer transform
  applyBoardZoom();

  renderCardsList();
  renderMiniCoordList();
  renderAnchorList();
  renderBlockList();
  updateBlockCount();
  renderLiveInfo();
}

function updateBlockCount() {
  const el = $('#bb-block-count');
  if (!el) return;
  const n = (scenarioBuf?.scenario_data?.blocks || []).length;
  el.textContent = `(${n})`;
}

function renderAnchorList() {
  const el = $('#bb-anchor-list');
  if (!el) return;
  const anchors = getBoardAnchors();
  if (anchors.length === 0) {
    el.innerHTML = '<div class="muted" style="font-size:11px;font-style:italic;padding:6px 0;">Ingen ankere ennå. Plasser et kort med anker-symbol p\u00e5 boarden.</div>';
    return;
  }
  el.innerHTML = anchors.map(a => `
    <div class="bb-anchor-row" style="display:flex;gap:6px;align-items:center;padding:5px 6px;border:1px solid var(--rule);border-radius:3px;margin-bottom:4px;background:var(--paper);">
      <input type="text" maxlength="1" value="${escapeHtml(a.label)}" oninput="setAnchorName('${a.card_id}', this.value)" style="width:30px;text-align:center;font-family:var(--font-cond);font-weight:700;font-size:14px;color:#b83228;padding:2px 4px;">
      <span style="flex:1;font-family:var(--font-mono);font-size:11px;color:var(--ink2);">(${a.x}, ${a.y})</span>
      <span style="font-size:11px;color:var(--ink3);max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(a.card.name)}">${escapeHtml(a.card.name)}</span>
    </div>
  `).join('');
}

function renderLiveInfo() {
  const wrap = $('#board-live-info');
  if (!wrap) return;
  if (!boardState.liveInfo) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const body = $('#bb-live-info-body');
  if (!body) return;
  const info = boardState.liveInfo;
  let html = `<div style="font-size:12px;font-family:var(--font-cond);font-weight:700;margin-bottom:6px;">${escapeHtml(info.cardName)}</div>`;
  html += `<div style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px;font-family:var(--font-mono);">`;
  html += `<span style="color:var(--ink3);">Kort:</span><span>(${info.gridX}, ${info.gridY})</span>`;
  if (info.anchorXY) {
    html += `<span style="color:#b83228;font-weight:700;">⚓ ${escapeHtml(info.anchorLabel || '')}:</span><span>(${info.anchorXY.x}, ${info.anchorXY.y})</span>`;
  }
  if (info.coordXY) {
    html += `<span style="color:#1a4a7a;">⊕ Koord:</span><span>(${info.coordXY.x}, ${info.coordXY.y})</span>`;
  }
  if (info.code) {
    html += `<span style="color:var(--ink3);">Kode:</span><span style="letter-spacing:0.1em;font-weight:700;">${escapeHtml(info.code)}</span>`;
  }
  html += `</div>`;
  body.innerHTML = html;
}

function updateLiveInfoFromCard(card) {
  if (!card) {
    boardState.liveInfo = null;
    return;
  }
  const info = {
    cardName: card.name || 'Uten navn',
    gridX: card.grid_x || 0,
    gridY: card.grid_y || 0,
    anchorXY: null,
    coordXY: null,
    code: card.header?.code || null,
    anchorLabel: null,
  };
  if (card.type === 'template' && Array.isArray(card.overlays)) {
    const anchor = card.overlays.find(o => o.type === 'anchor');
    if (anchor) {
      info.anchorXY = {
        x: (card.grid_x || 0) + anchor.col,
        y: (card.grid_y || 0) + anchor.row,
      };
      // Slå opp label
      const allAnchors = getBoardAnchors();
      const me = allAnchors.find(a => a.card_id === card.id);
      info.anchorLabel = me?.label || '';
    }
    const coord = card.overlays.find(o => o.type === 'coord');
    if (coord) {
      info.coordXY = {
        x: (card.grid_x || 0) + coord.col,
        y: (card.grid_y || 0) + coord.row,
      };
    }
  }
  boardState.liveInfo = info;
}

function renderCardsList() {
  const el = $('#bb-cards-list');
  if (!el) return;
  const cards = scenarioBuf.scenario_data.physical_cards;
  const boardCards = cards.filter(c => !c.in_stash);
  const stashCards = cards.filter(c => c.in_stash);

  const renderItem = (c, inStash) => {
    // Foretrekk export_thumb_url for template-kort \u2014 det er hele kortet rendret i
    // lav opp\u0142 (rask lasting). Faller tilbake til legacy bilde-thumb for eldre kort.
    const thumbSrc = c.export_thumb_url || c.export_url || c.thumb_url || c.image_url || c.image_path;
    const isTemplate = c.type === 'template';
    const thumbStyle = thumbSrc && !c.uploading
      ? `background-image:url('${escapeHtml(thumbSrc)}');background-size:cover;background-position:center;`
      : '';
    const statusBadge = c.uploading
      ? `<span style="font-size:10px;color:var(--amber);">\u27f3 ${Math.round((c.progress || 0) * 100)}%</span>`
      : '';
    const editBtn = isTemplate
      ? `<button class="btn btn-sm btn-secondary" style="padding:2px 6px;" onclick="event.stopPropagation();openTemplateEditor('${c.id}')" title="Rediger">\u270e</button>`
      : '';
    const stashBtn = inStash
      ? `<button class="btn btn-sm btn-ghost" style="padding:2px 6px;" onclick="event.stopPropagation();moveCardToBoard('${c.id}')" title="Flytt til board">\u21e8</button>`
      : `<button class="btn btn-sm btn-ghost" style="padding:2px 6px;" onclick="event.stopPropagation();moveCardToStash('${c.id}')" title="Flytt til bunke">\u22ee</button>`;
    const posInfo = inStash ? '<span style="font-size:10px;color:var(--ink3);">bunke</span>' : `<div class="bb-card-pos">${c.grid_x},${c.grid_y}</div>`;
    return `
      <div class="bb-card-item ${boardState.selectedCard === c.id ? 'selected' : ''}" onclick="selectCard('${c.id}')">
        <div class="bb-card-thumb" style="${thumbStyle}${isTemplate && !thumbSrc ? 'background:linear-gradient(135deg,#faf8f3,#ede8dc);display:flex;align-items:center;justify-content:center;' : ''}">${isTemplate && !thumbSrc ? `<span style="font-size:18px;color:var(--ink3);">\u25a6</span>` : ''}</div>
        <div class="bb-card-name">${escapeHtml(c.name)} ${statusBadge}</div>
        ${posInfo}
        ${editBtn}
        ${stashBtn}
        <button class="btn btn-sm btn-ghost" style="padding:2px 6px;" onclick="event.stopPropagation();removeCard('${c.id}')" title="Slett">\u2715</button>
      </div>
    `;
  };

  let html = '';
  // Seksjon 1: kort p\u00e5 board
  html += `<div style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink3);margin:8px 0 4px;">P\u00e5 board (${boardCards.length})</div>`;
  if (boardCards.length === 0) {
    html += '<div class="muted" style="font-size:11px;font-style:italic;padding:4px 0;">Ingen kort p\u00e5 boarden.</div>';
  } else {
    html += boardCards.map(c => renderItem(c, false)).join('');
  }

  // Seksjon 2: bunke
  html += `<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 4px;">`;
  html += `<span style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink3);">Bunke (${stashCards.length})</span>`;
  html += `<button class="btn btn-sm btn-ghost" style="padding:2px 8px;font-size:10px;" onclick="createStashCard()">+ Nytt</button>`;
  html += `</div>`;
  if (stashCards.length === 0) {
    html += '<div class="muted" style="font-size:11px;font-style:italic;padding:4px 0;">Ingen kort i bunken.</div>';
  } else {
    html += stashCards.map(c => renderItem(c, true)).join('');
  }

  el.innerHTML = html;
}

function moveCardToStash(cardId) {
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === cardId);
  if (!card) return;
  card.in_stash = true;
  renderBoard();
}

function moveCardToBoard(cardId) {
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === cardId);
  if (!card) return;
  delete card.in_stash;
  // Sett standard plassering hvis kortet er nytt fra bunke
  if (card.grid_x == null) card.grid_x = 0;
  if (card.grid_y == null) card.grid_y = 0;
  renderBoard();
}

function createStashCard() {
  const id = 'card_' + Date.now();
  const card = {
    id,
    type: 'template',
    name: 'Nytt kort i bunke',
    cols: 5,
    rows: 7,
    in_stash: true,
    grid_x: 0,
    grid_y: 0,
    grid_w: 5,
    grid_h: 7,
  };
  ensureTemplateShape(card);
  const suggestions = getContentColorSuggestions(card.header.bg_color);
  if (suggestions.length > 0) card.content.bg_color = suggestions[0].value;
  scenarioBuf.scenario_data.physical_cards.push(card);
  boardState.selectedCard = id;
  openTemplateEditor(id);
}

function renderMiniCoordList() {
  const el = $('#bb-coord-list-mini');
  if (!el) return;
  const list = scenarioBuf.scenario_data.coordinates;
  if (list.length === 0) {
    el.innerHTML = '<div class="muted" style="font-size:11px;font-style:italic;padding:6px 0;">Ingen koordinater lagt til ennå. Klikk en rute i grid-et.</div>';
    return;
  }
  el.innerHTML = list.map((c, i) => `
    <div class="bb-coord-mini ${i === editingCoordIdx ? 'selected' : ''}" onclick="selectCoordFromBoard(${i})">
      <span class="bb-coord-mini-xy">${c.x},${c.y}</span>
      <span class="bb-coord-mini-meta">${(c.rewards || []).length} bel · ${c.points ?? 0} p</span>
    </div>
  `).join('');
}

function selectCoordFromBoard(idx) {
  editingCoordIdx = idx;
  const c = scenarioBuf.scenario_data.coordinates[idx];
  boardState.selectedCoord = c ? { x: c.x, y: c.y } : null;
  renderBoard();
  // Hopp til coords-tab for full redigering
  switchScTab('coords');
}

function onCellClick(x, y) {
  // Hvis vi drar et kort, ignorer
  if (boardState.draggingCard) return;

  // Block-pick-modus: toggle trigger på koord ved (x,y).
  // Hvis ingen koord finnes der ennå, opprett en først.
  if (blockEditorState.pickMode && blockEditorState.activeBlockId) {
    let coordId = coordIdAtCell(x, y);
    if (!coordId) {
      const list = scenarioBuf.scenario_data.coordinates;
      const newCoord = {
        id: 'coord_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now(),
        x, y, code: '', points: 10,
      };
      list.push(newCoord);
      coordId = newCoord.id;
    }
    toggleBlockTriggerForCoord(coordId);
    return;
  }

  // Normal flyt — åpne koord for redigering
  const list = scenarioBuf.scenario_data.coordinates;
  let idx = list.findIndex(c => c.x === x && c.y === y);
  if (idx < 0) {
    list.push({
      id: 'coord_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now(),
      x, y, code: '', points: 10,
    });
    idx = list.length - 1;
  }
  editingCoordIdx = idx;
  boardState.selectedCoord = { x, y };
  switchScTab('coords');
}

/* ════════════════════════════════════════════════════════
   KORT-TEMPLATE-EDITOR v2 — header / content / footer + grid-overlay

   Datamodell (lagret i physical_cards-arrayet):
   {
     id: 'card_xxx',
     type: 'template',
     name: 'Document Folder 1',         // intern, vises i kortliste
     cols: 5, rows: 7,                   // grid-størrelse
     header: { title, code, bg_color, text_color, height_pct },
     footer: { items: [...], bg_color, text_color, height_pct },
     content: { layers: [...], bg_color },
     overlays: [
       { type: 'anchor', col, row },
       { type: 'coord',  col, row, coord_x, coord_y }
     ],
     grid_x, grid_y, grid_w, grid_h     // plassering på Investigation Board
   }

   Lag-typer i content.layers:
     { type: 'image', url, thumb_url, path, thumb_path, x_pct, y_pct, w_pct, h_pct }
     { type: 'text',  value, font_size, color, bg_color, x_pct, y_pct, w_pct, h_pct }

   Footer-items:
     { type: 'text',   value }
     { type: 'symbol', value }    // emoji eller unicode-symbol
   ─────────────────────────────────────────────────────── */

let templateBuf = null;
let templateTool = 'select';        // 'select' | 'anchor' | 'coord'
let templateSelectedZone = null;    // 'header' | 'content' | 'footer' | null
let templateSelectedLayer = -1;     // index i content.layers, eller -1
let templateSelectedFooterItem = -1;
let templateDrag = null;            // { mode, layerIdx, startX, startY, orig... }

// Hvor mange grid-rader header/footer tar (en rute hver = 1)
const HEADER_DEFAULT_ROWS = 1;
const FOOTER_DEFAULT_ROWS = 1;

// Forhåndsdefinerte fargesvatcher fra Field Terminal-malen
// Brukes som palett i fargevelgeren for header/footer
const FIELD_TERMINAL_COLORS = [
  { name: 'Blå',     value: '#1a4a7a' },
  { name: 'Rød',     value: '#b83228' },
  { name: 'Gull',    value: '#c8961a' },
  { name: 'Stamp',   value: '#8b3a2a' },
  { name: 'Grønn',   value: '#2a6b3c' },
  { name: 'Mørk',    value: '#1a1610' },
  { name: 'Papir',   value: '#faf8f3' },
  { name: 'Sand',    value: '#ede8dc' },
];

/* Anker-symbol som SVG-path. Sentrert på (cx, cy), totalstørrelse `size`.
   Bruker en stilisert anker-form: krone, stamme, krok-armer.
*/
function renderAnchorSvg(cx, cy, size, color) {
  // viewBox er 100x100, vi skalerer til ønsket størrelse
  const half = size / 2;
  const x = cx - half;
  const y = cy - half;
  // Stilisert anker designet for å være sentrert i 100x100-bokse
  const path = `
    M50 14
    a8 8 0 1 0 0.01 0
    M50 22
    L50 84
    M30 38
    L70 38
    M22 64
    Q22 84 50 86
    Q78 84 78 64
    M22 64
    L14 60
    M78 64
    L86 60
  `.replace(/\s+/g, ' ').trim();
  return `<g pointer-events="none">
    <svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 100 100">
      <path d="${path}" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  </g>`;
}

/* Beregner 4 dempede content-bakgrunnsfarger basert på en hex-farge.
   Returnerer array av {name, value}. Algoritme: konverterer til HSL,
   senker metning og hever/senker lightness for å lage variasjoner.
*/
function getContentColorSuggestions(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return [];
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  // Fire varianter: lys-dempet, medium-dempet, mørk-dempet, nesten nøytral
  const variants = [
    { name: 'Veldig lys', s: 0.10, l: 0.94 },
    { name: 'Lys',         s: 0.18, l: 0.86 },
    { name: 'Pastell',     s: 0.26, l: 0.78 },
    { name: 'Dyp dempet',  s: 0.16, l: 0.66 },
  ];
  return variants.map(v => {
    const rgb2 = hslToRgb(hsl.h, v.s, v.l);
    return { name: v.name, value: rgbToHex(rgb2.r, rgb2.g, rgb2.b) };
  });
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}
function rgbToHex(r, g, b) {
  const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + toHex(r) + toHex(g) + toHex(b);
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = 0; s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return { r: r * 255, g: g * 255, b: b * 255 };
}

// Symbolutvalg for footer
const FOOTER_SYMBOLS = ['🔒','🔑','⚠','☢','⛔','📁','📎','🔍','🚨','★','◆','●','✦','✱','⚙','🎯','🧩','📌'];

function ensureTemplateShape(card) {
  if (!card) return;
  if (!card.cols) card.cols = 5;
  if (!card.rows) card.rows = 7;
  if (!card.header) {
    card.header = {
      title: card.name || 'Tittel',
      code: '',
      bg_color: '#1a4a7a',
      text_color: '#ffffff',
      code_bg_color: '#c8961a',
      code_text_color: '#1a1610',
      rows: HEADER_DEFAULT_ROWS,
    };
  }
  // Migrer eldre header med height_pct → rows
  if (card.header.height_pct != null && card.header.rows == null) {
    card.header.rows = HEADER_DEFAULT_ROWS;
    delete card.header.height_pct;
  }
  // Sett standard kode-styling for eldre kort som mangler dem
  if (card.header.code_bg_color == null) card.header.code_bg_color = '#c8961a';
  if (card.header.code_text_color == null) card.header.code_text_color = '#1a1610';

  if (!card.footer) {
    card.footer = {
      items: [],
      bg_color: '#ede8dc',
      text_color: '#1a1610',
      rows: FOOTER_DEFAULT_ROWS,
    };
  }
  if (card.footer.height_pct != null && card.footer.rows == null) {
    card.footer.rows = FOOTER_DEFAULT_ROWS;
    delete card.footer.height_pct;
  }
  if (!card.content) {
    card.content = {
      layers: [],
      bg_color: '#faf8f3',
    };
  }
  if (!Array.isArray(card.overlays)) {
    // Migrer gamle 'cells'-data hvis det finnes
    card.overlays = [];
    if (Array.isArray(card.cells)) {
      card.cells.forEach(c => {
        if (c.type === 'anchor' || c.type === 'coord') {
          card.overlays.push(
            c.type === 'coord'
              ? { type: 'coord', col: c.col, row: c.row, coord_x: c.coord_x, coord_y: c.coord_y }
              : { type: 'anchor', col: c.col, row: c.row }
          );
        }
      });
      delete card.cells;
    }
  }
}

function createTemplateCard() {
  const id = 'card_' + Date.now();
  const card = {
    id,
    type: 'template',
    name: 'Nytt kort',
    cols: 5,
    rows: 7,
    grid_x: 0,
    grid_y: 0,
    grid_w: 5,
    grid_h: 7,
  };
  ensureTemplateShape(card);
  // Sett content-bg til en dempet variant av header-fargen som default
  const suggestions = getContentColorSuggestions(card.header.bg_color);
  if (suggestions.length > 0) {
    card.content.bg_color = suggestions[0].value;  // 'Veldig lys'
  }
  scenarioBuf.scenario_data.physical_cards.push(card);
  boardState.selectedCard = id;
  openTemplateEditor(id);
}

/* Lukker template-editor og GJEN-ÅPNER scenario-editor med riktig tab.
   Dette løser lagrings-buggen — ellers ville endringer ikke kunne lagres
   fordi scenario-editor-modalen er blitt erstattet. */
function closeTemplateEditor() {
  templateBuf = null;
  templateSelectedZone = null;
  templateSelectedLayer = -1;
  templateDrag = null;
  closeModal();
  // Gjenåpne scenario-editor på samme sted (board-tab)
  if (state.currentScenarioId) {
    activeScTab = 'board';
    openScenarioEditor(state.currentScenarioId);
  }
}

function openTemplateEditor(cardId) {
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === cardId);
  if (!card) return;
  ensureTemplateShape(card);
  templateBuf = card;
  templateTool = 'select';
  templateSelectedZone = null;
  templateSelectedLayer = -1;
  templateSelectedFooterItem = -1;

  openModal({
    title: 'Kort-editor: ' + (card.name || 'Uten navn'),
    size: 'xl',
    body: renderTemplateEditor(),
    footer: `
      <button class="btn btn-secondary" onclick="closeTemplateEditor()">⤺ Tilbake</button>
      <button class="btn btn-success" onclick="saveTemplateCardOnly()">⤳ Lagre kort</button>
    `,
  });
}

/* Lagrer kortet, deretter lukker editor og returnerer til scenario-editor
   p\u00e5 board-tab slik at brukeren ser kortet i sammenheng med boarden.
*/
async function saveTemplateCardOnly() {
  if (!state.currentScenarioId) {
    showToast('Ingen scenario åpen', 'error');
    return;
  }
  try {
    // 1. Eksporter kortet som PNG og last opp til Dropbox før selve lagringen
    //    slik at export_url er med i scenario_data n\u00e5r vi PATCHer.
    if (templateBuf) {
      showToast('Lagrer kort og genererer PNG...', 'info');
      await exportCardPng(templateBuf);
    }
    // 2. Lagre scenario_data
    await api(`/api/scenarios/${state.currentScenarioId}`, {
      method: 'PATCH',
      body: { scenario_data: scenarioBuf.scenario_data },
    });
    showToast('Kortet er lagret', 'success');
    // 3. Lukk editor og returner til board-visning
    closeTemplateEditor();
  } catch (e) {
    showToast('Lagring feilet: ' + e.message, 'error');
  }
}

function renderTemplateEditor() {
  return `
    <style>
      .te-layout { display:grid; grid-template-columns: 200px 1fr 300px; gap:14px; height:560px; }
      .te-toolbar h4 { font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:var(--ink3); margin:0 0 8px; }
      .te-tools { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
      .te-tool { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1.5px solid var(--rule); background:var(--paper); border-radius:3px; cursor:pointer; font-family:var(--font-cond); font-size:12px; transition:all 0.12s; }
      .te-tool:hover { border-color:var(--blue); background:var(--blue-bg); }
      .te-tool.active { border-color:var(--ink); background:var(--ink); color:#fff; }
      .te-tool-icon { font-size:16px; line-height:1; width:20px; text-align:center; }
      .te-meta { display:flex; flex-direction:column; gap:8px; padding:10px; background:var(--bg2); border-radius:3px; margin-top:auto; }
      .te-meta input[type=number] { width:100%; }
      .te-meta input[type=text] { width:100%; }
      .te-canvas-wrap { display:flex; align-items:center; justify-content:center; background:var(--bg2); border-radius:3px; overflow:auto; padding:20px; }
      .te-card { background:#fff; box-shadow:0 4px 16px rgba(0,0,0,0.15); position:relative; user-select:none; }
      .te-zone { position:absolute; left:0; right:0; cursor:pointer; transition:outline 0.12s; outline:2px solid transparent; outline-offset:-2px; }
      .te-zone:hover { outline-color:rgba(26,74,122,0.3); }
      .te-zone.selected { outline-color:var(--blue); }
      .te-zone-header { top:0; display:flex; align-items:center; justify-content:space-between; padding:0 8%; }
      .te-zone-footer { bottom:0; display:flex; align-items:center; gap:8px; padding:0 8%; overflow:hidden; white-space:nowrap; }
      .te-zone-footer .te-footer-item { flex-shrink:0; }
      .te-zone-content { background-clip:padding-box; }
      .te-header-title {
        font-family:var(--font-serif); font-weight:700;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        flex:1; min-width:0;  /* la flex kollapse til mindre enn intrinsic */
      }
      .te-header-code-badge { flex-shrink:0; }
      .te-header-code { font-family:var(--font-mono); font-weight:500; letter-spacing:0.1em; }
      .te-footer-item { display:inline-flex; align-items:center; }
      .te-grid-overlay { position:absolute; top:0; left:0; right:0; bottom:0; pointer-events:none; }
      .te-grid-overlay rect { fill:transparent; stroke:rgba(60,40,20,0.32); stroke-width:0.6; stroke-dasharray:2 2; }
      .te-grid-overlay rect.tool-active { pointer-events:auto; cursor:crosshair; }
      .te-grid-overlay rect.tool-active:hover { fill:rgba(184,108,0,0.18); }
      .te-overlay-marker { font-size:18px; pointer-events:none; }
      .te-content-layer { position:absolute; cursor:move; }
      .te-content-layer.selected { outline:2px dashed var(--blue); outline-offset:1px; }
      .te-resize-handle { position:absolute; width:10px; height:10px; background:var(--blue); border:1px solid #fff; border-radius:50%; }
      .te-resize-handle.se { right:-5px; bottom:-5px; cursor:se-resize; }
      .te-side h4 { font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:var(--ink3); margin:0 0 8px; }
      .te-prop { padding:10px; background:var(--paper); border:1px solid var(--rule); border-radius:3px; }
      .te-prop label { display:block; font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:var(--ink3); margin-bottom:4px; margin-top:8px; }
      .te-prop label:first-of-type { margin-top:0; }
      .te-prop input, .te-prop select, .te-prop textarea { width:100%; }
      .te-prop input[type=color] { width:60px; height:32px; padding:2px; cursor:pointer; }
      .te-prop-empty { color:var(--ink3); font-size:13px; font-style:italic; padding:12px; text-align:center; }
      .te-symbol-grid { display:grid; grid-template-columns:repeat(6, 1fr); gap:4px; margin-top:6px; }
      .te-symbol-btn { background:var(--bg); border:1px solid var(--rule); border-radius:3px; padding:6px; font-size:18px; cursor:pointer; transition:background 0.1s; }
      .te-symbol-btn:hover { background:var(--blue-bg); border-color:var(--blue); }
      .te-footer-item-row { display:flex; gap:6px; align-items:center; padding:4px; border:1px solid var(--rule); border-radius:2px; margin-bottom:4px; background:var(--bg); }
      .te-footer-item-row.selected { border-color:var(--blue); background:var(--blue-bg); }
      .te-footer-item-row input { flex:1; }
      .te-layer-row { display:flex; gap:6px; align-items:center; padding:6px; border:1px solid var(--rule); border-radius:2px; margin-bottom:4px; background:var(--bg); cursor:pointer; }
      .te-layer-row.selected { border-color:var(--blue); background:var(--blue-bg); }
      .te-layer-row .layer-name { flex:1; font-size:12px; }
      .te-layer-thumb { width:32px; height:32px; background-size:cover; background-position:center; border:1px solid var(--rule); border-radius:2px; flex-shrink:0; }
      .te-layer-text-thumb { width:32px; height:32px; display:flex; align-items:center; justify-content:center; font-size:18px; background:var(--bg2); border:1px solid var(--rule); border-radius:2px; flex-shrink:0; }
    </style>

    <div class="te-layout">
      <!-- Verktøyrad -->
      <div class="te-toolbar" style="display:flex;flex-direction:column;">
        <h4>Verktøy</h4>
        <div class="te-tools">
          <div class="te-tool ${templateTool === 'select' ? 'active' : ''}" onclick="setTemplateTool('select')">
            <span class="te-tool-icon">↖</span>
            <div>
              <div style="font-weight:700;">Velg</div>
              <div style="font-size:10px;opacity:0.7;">Klikk soner/lag</div>
            </div>
          </div>
          <div class="te-tool ${templateTool === 'anchor' ? 'active' : ''}" onclick="setTemplateTool('anchor')">
            <span class="te-tool-icon">⚓</span>
            <div>
              <div style="font-weight:700;">Anker</div>
              <div style="font-size:10px;opacity:0.7;">Klikk i grid</div>
            </div>
          </div>
          <div class="te-tool ${templateTool === 'coord' ? 'active' : ''}" onclick="setTemplateTool('coord')">
            <span class="te-tool-icon">⊕</span>
            <div>
              <div style="font-weight:700;">Koordinat</div>
              <div style="font-size:10px;opacity:0.7;">Klikk i grid</div>
            </div>
          </div>
        </div>

        <div class="te-meta">
          <div>
            <label class="field-label" style="font-size:10px;">Kortnavn (intern)</label>
            <input type="text" value="${escapeHtml(templateBuf.name || '')}" oninput="updateTemplateName(this.value)">
          </div>
          <div style="display:flex;gap:8px;">
            <div style="flex:1;">
              <label class="field-label" style="font-size:10px;">Kolonner</label>
              <input type="number" min="1" max="12" value="${templateBuf.cols}" oninput="updateTemplateGrid('cols', this.value)">
            </div>
            <div style="flex:1;">
              <label class="field-label" style="font-size:10px;">Rader</label>
              <input type="number" min="1" max="14" value="${templateBuf.rows}" oninput="updateTemplateGrid('rows', this.value)">
            </div>
          </div>
        </div>
      </div>

      <!-- Canvas -->
      <div class="te-canvas-wrap" id="te-canvas-wrap">
        ${renderTemplateCanvas()}
      </div>

      <!-- Egenskapspanel -->
      <div class="te-side">
        <h4>Egenskaper</h4>
        <div id="te-prop-panel">${renderTemplateProps()}</div>
      </div>
    </div>
  `;
}

function setTemplateTool(tool) {
  templateTool = tool;
  // Bare oppdater verktøyradens active-state, ikke hele canvas (dyrt)
  $$('#modal .te-tool').forEach(el => el.classList.remove('active'));
  $(`#modal .te-tool[onclick*="'${tool}'"]`)?.classList.add('active');
  // Re-render canvas slik at grid-overlay får riktig pointer-events
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
}

function updateTemplateName(name) {
  templateBuf.name = name;
  renderCardsList();
}

function updateTemplateGrid(field, value) {
  const max = field === 'cols' ? 12 : 14;
  const n = Math.max(1, Math.min(max, parseInt(value, 10) || 1));
  templateBuf[field] = n;
  // Fjern overlay-markører utenfor nye grenser
  templateBuf.overlays = templateBuf.overlays.filter(o =>
    o.col < templateBuf.cols && o.row < templateBuf.rows
  );
  templateBuf.grid_w = templateBuf.cols;
  templateBuf.grid_h = templateBuf.rows;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  renderBoard();
}

/* ─── KORT-CANVAS ─── */
function getCardCanvasSize() {
  // Vi rendrer kortet i en fast pikselstørrelse i editoren basert på cols/rows.
  // 60px per celle gir et godt balansert kort (5x7 = 300x420).
  const cellPx = 60;
  return {
    cellPx,
    width: templateBuf.cols * cellPx,
    height: templateBuf.rows * cellPx,
  };
}

function renderTemplateCanvas() {
  const { cellPx, width, height } = getCardCanvasSize();
  const headerRows = templateBuf.header.rows || HEADER_DEFAULT_ROWS;
  const footerRows = templateBuf.footer.rows || FOOTER_DEFAULT_ROWS;
  const headerH = headerRows * cellPx;
  const footerH = footerRows * cellPx;
  const contentY = headerH;
  const contentH = height - headerH - footerH;

  // Beregn pikselstørrelser for tekst i header/footer basert på sone-høyde
  const headerFontSize = Math.max(11, Math.round(headerH * 0.34));
  const footerFontSize = Math.max(10, Math.round(footerH * 0.45));

  let html = `<div class="te-card" style="width:${width}px;height:${height}px;background:${templateBuf.content.bg_color};">`;

  // CONTENT-sone (legges først så soner over kan overlappe i z-order)
  html += `<div class="te-zone te-zone-content${templateSelectedZone === 'content' ? ' selected' : ''}" style="top:${contentY}px;height:${contentH}px;background:${templateBuf.content.bg_color};" onclick="selectTemplateZone(event, 'content')">`;
  // Lag i content
  (templateBuf.content.layers || []).forEach((layer, idx) => {
    const x = (layer.x_pct || 0) * width / 100;
    const y = (layer.y_pct || 0) * contentH / 100;
    const w = (layer.w_pct || 50) * width / 100;
    const h = (layer.h_pct || 50) * contentH / 100;
    const sel = (templateSelectedLayer === idx && templateSelectedZone === 'content');
    html += `<div class="te-content-layer${sel ? ' selected' : ''}" data-layer-idx="${idx}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;" onmousedown="onLayerMouseDown(event, ${idx})">`;
    if (layer.type === 'image' && (layer.thumb_url || layer.url)) {
      html += `<img src="${escapeHtml(layer.thumb_url || layer.url)}" style="width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;" draggable="false">`;
    } else if (layer.type === 'image') {
      html += `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#eee;color:#999;font-size:24px;pointer-events:none;">🖼</div>`;
    } else if (layer.type === 'text') {
      const fz = layer.font_size || 16;
      const col = layer.color || '#1a1610';
      const bgc = layer.bg_color || 'transparent';
      const txt = layer.value || '';
      html += `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-family:var(--font-serif);font-size:${fz}px;color:${col};background:${bgc};text-align:center;padding:4px;pointer-events:none;word-break:break-word;">${escapeHtml(txt)}</div>`;
    }
    if (sel) {
      html += `<div class="te-resize-handle se" onmousedown="onLayerMouseDown(event, ${idx}, 'resize-se')"></div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;

  // HEADER-sone — 4-kode med egen kontrastfarget boks til høyre
  html += `<div class="te-zone te-zone-header${templateSelectedZone === 'header' ? ' selected' : ''}" style="height:${headerH}px;background:${templateBuf.header.bg_color};color:${templateBuf.header.text_color};" onclick="selectTemplateZone(event, 'header')">`;
  html += `<span class="te-header-title" style="font-size:${headerFontSize}px;">${escapeHtml(templateBuf.header.title || '')}</span>`;
  // 4-kode i tydelig markert boks med egen bakgrunn
  if (templateBuf.header.code) {
    html += `<span class="te-header-code-badge" style="background:${templateBuf.header.code_bg_color};color:${templateBuf.header.code_text_color};font-size:${headerFontSize * 0.78}px;padding:${headerFontSize * 0.15}px ${headerFontSize * 0.5}px;border-radius:3px;font-family:var(--font-mono);font-weight:700;letter-spacing:0.12em;border:1px solid rgba(0,0,0,0.2);">${escapeHtml(templateBuf.header.code)}</span>`;
  } else {
    html += `<span class="te-header-code-badge" style="opacity:0.4;font-size:${headerFontSize * 0.78}px;padding:${headerFontSize * 0.15}px ${headerFontSize * 0.5}px;border:1px dashed currentColor;border-radius:3px;font-family:var(--font-mono);">CODE</span>`;
  }
  html += `</div>`;

  // FOOTER-sone
  html += `<div class="te-zone te-zone-footer${templateSelectedZone === 'footer' ? ' selected' : ''}" style="height:${footerH}px;background:${templateBuf.footer.bg_color};color:${templateBuf.footer.text_color};" onclick="selectTemplateZone(event, 'footer')">`;
  (templateBuf.footer.items || []).forEach(item => {
    if (item.type === 'symbol') {
      html += `<span class="te-footer-item" style="font-size:${footerFontSize * 1.2}px;">${escapeHtml(item.value || '')}</span>`;
    } else {
      html += `<span class="te-footer-item" style="font-size:${footerFontSize}px;font-family:var(--font-cond);">${escapeHtml(item.value || '')}</span>`;
    }
  });
  html += `</div>`;

  // GRID-OVERLAY (stiplet, oppå alt)
  html += `<svg class="te-grid-overlay" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`;
  // Kun grid-celler for anchor/coord-verktøy får pointer events
  const toolActive = (templateTool === 'anchor' || templateTool === 'coord');
  for (let row = 0; row < templateBuf.rows; row++) {
    for (let col = 0; col < templateBuf.cols; col++) {
      const x = col * cellPx;
      const y = row * cellPx;
      const cls = toolActive ? 'tool-active' : '';
      html += `<rect class="${cls}" x="${x}" y="${y}" width="${cellPx}" height="${cellPx}" onclick="onGridCellClick(event, ${col}, ${row})"/>`;
    }
  }
  // Anker- og koord-markører (oppå alt)
  (templateBuf.overlays || []).forEach(o => {
    const x = o.col * cellPx + cellPx / 2;
    const y = o.row * cellPx + cellPx / 2;
    if (o.type === 'anchor') {
      // Stort anker som SVG-path, perfekt sentrert
      html += renderAnchorSvg(x, y, cellPx * 0.78, '#b83228');
    } else if (o.type === 'coord') {
      // Målskive: to konsentriske ringer i blå med ? i sentrum
      const r1 = cellPx * 0.42;
      const r2 = cellPx * 0.26;
      html += `<g pointer-events="none">`;
      html += `<circle cx="${x}" cy="${y}" r="${r1}" fill="#fff" stroke="#1a4a7a" stroke-width="${cellPx * 0.06}"/>`;
      html += `<circle cx="${x}" cy="${y}" r="${r2}" fill="none" stroke="#1a4a7a" stroke-width="${cellPx * 0.04}"/>`;
      html += `<text x="${x}" y="${y + cellPx * 0.03}" text-anchor="middle" dominant-baseline="middle" font-size="${cellPx * 0.36}" fill="#1a4a7a" font-weight="700" font-family="var(--font-serif)">?</text>`;
      html += `</g>`;
    }
  });
  html += `</svg>`;

  html += `</div>`;
  return html;
}

/* ─── ZONE-VALG ─── */
function selectTemplateZone(e, zone) {
  // Hvis brukeren klikker på et lag inne i content, ikke endre zone
  if (e.target.closest('.te-content-layer')) return;
  if (templateTool !== 'select') return;

  templateSelectedZone = zone;
  templateSelectedLayer = -1;
  templateSelectedFooterItem = -1;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderTemplateProps();
}

/* ─── GRID-CELLE-KLIKK (for anker og koord) ─── */
function onGridCellClick(e, col, row) {
  e.stopPropagation();
  if (templateTool === 'anchor') {
    // Maks ett anker — fjern eksisterende
    templateBuf.overlays = templateBuf.overlays.filter(o => o.type !== 'anchor');
    templateBuf.overlays.push({ type: 'anchor', col, row });
  } else if (templateTool === 'coord') {
    // Maks ett koord-symbol — fjern eksisterende
    templateBuf.overlays = templateBuf.overlays.filter(o => o.type !== 'coord');
    templateBuf.overlays.push({ type: 'coord', col, row, coord_x: null, coord_y: null });
  } else {
    return;
  }
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderTemplateProps();
  renderBoard();
}

/* ─── EGENSKAPSPANEL ─── */
function renderTemplateProps() {
  // Anker/koord-verktøy aktivt → vis info om hva neste klikk gjør
  if (templateTool === 'anchor') {
    const existing = templateBuf.overlays.find(o => o.type === 'anchor');
    return `<div class="te-prop"><label>Anker-verktøy</label><div style="font-size:12px;color:var(--ink2);line-height:1.45;">Klikk i en grid-rute for å plassere anker.<br><br>${existing ? `Eksisterende anker: (${existing.col}, ${existing.row}). Nytt klikk flytter det.` : 'Ingen anker plassert ennå.'}</div></div>`;
  }
  if (templateTool === 'coord') {
    const existing = templateBuf.overlays.find(o => o.type === 'coord');
    let body = `<div class="te-prop"><label>Koordinat-verktøy</label><div style="font-size:12px;color:var(--ink2);line-height:1.45;">Klikk i en grid-rute for å plassere koord-symbol.<br><br>${existing ? `Symbolet er plassert på (${existing.col}, ${existing.row}).` : 'Ingen plassert ennå.'}</div>`;
    if (existing) {
      body += `<label style="margin-top:14px;">Peker mot koordinat</label>`;
      const coords = scenarioBuf.scenario_data.coordinates || [];
      body += `<select onchange="updateCoordOverlay(this.value)">`;
      body += `<option value="">— Velg koordinat —</option>`;
      coords.forEach(c => {
        const sel = (existing.coord_x === c.x && existing.coord_y === c.y) ? 'selected' : '';
        body += `<option value="${c.x},${c.y}" ${sel}>(${c.x}, ${c.y})${c.code ? ' · ' + escapeHtml(c.code) : ''}</option>`;
      });
      body += `</select>`;
      body += `<button class="btn btn-sm btn-ghost" style="width:100%;margin-top:10px;" onclick="removeCoordOverlay()">Fjern koord-symbol</button>`;
    } else if (templateBuf.overlays.find(o => o.type === 'anchor')) {
      // Vis anker-info
    }
    body += `</div>`;
    return body;
  }

  // Select-verktøy: vis egenskaper for valgt zone/lag
  if (templateSelectedZone === 'header') {
    return renderHeaderProps();
  }
  if (templateSelectedZone === 'content') {
    return renderContentProps();
  }
  if (templateSelectedZone === 'footer') {
    return renderFooterProps();
  }
  return `<div class="te-prop-empty">Klikk på header, innhold eller footer for å redigere.<br><br>Eller velg <strong>Anker</strong>/<strong>Koordinat</strong>-verktøyet og klikk en grid-rute.</div>`;
}

function renderHeaderProps() {
  const h = templateBuf.header;
  return `
    <div class="te-prop">
      <label>HEADER</label>
      <label style="margin-top:10px;">Tittel</label>
      <input type="text" value="${escapeHtml(h.title || '')}" oninput="updateHeader('title', this.value)">
      <label>4-tegns kode</label>
      <input type="text" maxlength="6" value="${escapeHtml(h.code || '')}" oninput="updateHeader('code', this.value)" placeholder="F.eks. 1A2B" style="font-family:var(--font-mono);letter-spacing:0.1em;">

      <label style="margin-top:14px;">Bakgrunnsfarge (header)</label>
      ${renderColorPalette('bg_color', h.bg_color, 'updateHeader')}

      <label>Tekstfarge</label>
      ${renderColorPalette('text_color', h.text_color, 'updateHeader')}

      <label style="margin-top:14px;">4-kode bakgrunn</label>
      ${renderColorPalette('code_bg_color', h.code_bg_color, 'updateHeader')}

      <label>4-kode tekstfarge</label>
      ${renderColorPalette('code_text_color', h.code_text_color, 'updateHeader')}

      <label style="margin-top:14px;">Høyde (antall rader)</label>
      <input type="number" min="1" max="3" value="${h.rows || HEADER_DEFAULT_ROWS}" oninput="updateHeader('rows', parseInt(this.value,10) || ${HEADER_DEFAULT_ROWS})">
    </div>
  `;
}

function renderFooterProps() {
  const f = templateBuf.footer;
  let body = `
    <div class="te-prop">
      <label>FOOTER</label>
      <label style="margin-top:10px;">Bakgrunnsfarge</label>
      ${renderColorPalette('bg_color', f.bg_color, 'updateFooter')}

      <label>Tekstfarge</label>
      ${renderColorPalette('text_color', f.text_color, 'updateFooter')}

      <label>Høyde (antall rader)</label>
      <input type="number" min="1" max="3" value="${f.rows || FOOTER_DEFAULT_ROWS}" oninput="updateFooter('rows', parseInt(this.value,10) || ${FOOTER_DEFAULT_ROWS})">

      <label style="margin-top:14px;">Innhold</label>
      <div id="te-footer-items">`;
  (f.items || []).forEach((item, idx) => {
    body += `<div class="te-footer-item-row">
      <span style="font-size:18px;width:24px;text-align:center;">${item.type === 'symbol' ? escapeHtml(item.value) : 'T'}</span>
      <input type="text" value="${escapeHtml(item.value || '')}" oninput="updateFooterItem(${idx}, this.value)" placeholder="${item.type === 'symbol' ? 'Symbol' : 'Tekst'}">
      <button class="btn btn-sm btn-ghost" onclick="removeFooterItem(${idx})" style="padding:2px 6px;">✕</button>
    </div>`;
  });
  body += `</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button class="btn btn-sm btn-secondary" onclick="addFooterItem('text')" style="flex:1;">+ Tekst</button>
        <button class="btn btn-sm btn-secondary" onclick="toggleFooterSymbolPicker()" style="flex:1;">+ Symbol</button>
      </div>
      <div id="te-symbol-picker" style="display:none;">
        <div class="te-symbol-grid">
          ${FOOTER_SYMBOLS.map(s => `<button class="te-symbol-btn" onclick="addFooterItem('symbol', '${s}')">${s}</button>`).join('')}
        </div>
      </div>
    </div>`;
  return body;
}

/* Felles fargevelger med palett + tilpasset hex-input */
function renderColorPalette(field, currentValue, updateFn) {
  const swatches = FIELD_TERMINAL_COLORS.map(c => {
    const sel = (c.value.toLowerCase() === (currentValue || '').toLowerCase()) ? 'border:2px solid var(--ink);' : 'border:1px solid var(--rule);';
    return `<button title="${c.name}" style="width:24px;height:24px;${sel}background:${c.value};border-radius:3px;cursor:pointer;padding:0;" onclick="${updateFn}('${field}', '${c.value}')"></button>`;
  }).join('');
  return `
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">${swatches}</div>
    <div style="display:flex;gap:6px;align-items:center;">
      <input type="color" value="${currentValue || '#000000'}" oninput="${updateFn}('${field}', this.value)" style="width:40px;height:28px;padding:1px;cursor:pointer;">
      <input type="text" value="${currentValue || ''}" oninput="${updateFn}('${field}', this.value)" style="flex:1;font-family:var(--font-mono);font-size:11px;">
    </div>
  `;
}

function renderContentProps() {
  const c = templateBuf.content;
  const suggestions = getContentColorSuggestions(templateBuf.header.bg_color);
  let body = `
    <div class="te-prop">
      <label>INNHOLD</label>
      <label style="margin-top:10px;">Bakgrunnsfarge</label>

      <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Forslag basert på header</div>
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        ${suggestions.map(sg => {
          const sel = (sg.value.toLowerCase() === (c.bg_color || '').toLowerCase()) ? 'border:2px solid var(--ink);' : 'border:1px solid var(--rule);';
          return `<button title="${sg.name} (${sg.value})" style="flex:1;height:34px;${sel}background:${sg.value};border-radius:3px;cursor:pointer;padding:0;font-size:9px;color:rgba(0,0,0,0.5);" onclick="updateContent('bg_color', '${sg.value}')">${sg.name.split(' ')[0]}</button>`;
        }).join('')}
      </div>

      <div style="font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;margin-top:8px;">Egendefinert</div>
      <div style="display:flex;gap:6px;align-items:center;">
        <input type="color" value="${c.bg_color}" oninput="updateContent('bg_color', this.value)" style="width:40px;height:28px;padding:1px;cursor:pointer;">
        <input type="text" value="${c.bg_color}" oninput="updateContent('bg_color', this.value)" style="flex:1;font-family:var(--font-mono);font-size:11px;">
      </div>

      <label style="margin-top:14px;">Lag (${(c.layers || []).length})</label>
      <div>`;
  (c.layers || []).forEach((layer, idx) => {
    const sel = templateSelectedLayer === idx;
    let thumb;
    if (layer.type === 'image' && (layer.thumb_url || layer.url)) {
      thumb = `<div class="te-layer-thumb" style="background-image:url('${escapeHtml(layer.thumb_url || layer.url)}');"></div>`;
    } else if (layer.type === 'image') {
      thumb = `<div class="te-layer-text-thumb">🖼</div>`;
    } else {
      thumb = `<div class="te-layer-text-thumb">T</div>`;
    }
    const name = layer.type === 'text' ? (layer.value || '(tom tekst)').slice(0, 18) : 'Bilde';
    body += `<div class="te-layer-row${sel ? ' selected' : ''}" onclick="selectLayer(${idx})">
      ${thumb}
      <span class="layer-name">${escapeHtml(name)}</span>
      <button class="btn btn-sm btn-ghost" style="padding:2px 4px;" onclick="event.stopPropagation();moveLayer(${idx}, -1)" title="Flytt opp">▲</button>
      <button class="btn btn-sm btn-ghost" style="padding:2px 4px;" onclick="event.stopPropagation();moveLayer(${idx}, 1)" title="Flytt ned">▼</button>
      <button class="btn btn-sm btn-ghost" style="padding:2px 4px;" onclick="event.stopPropagation();removeLayer(${idx})" title="Slett">✕</button>
    </div>`;
  });
  body += `</div>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <label class="btn btn-sm btn-secondary" style="flex:1;cursor:pointer;text-align:center;margin-bottom:0;">
          <input type="file" accept="image/*" onchange="addImageLayer(this)" style="display:none;">+ Bildelag
        </label>
        <button class="btn btn-sm btn-secondary" onclick="addTextLayer()" style="flex:1;">+ Tekstlag</button>
      </div>
    </div>`;

  // Hvis et lag er valgt, vis dets egenskaper
  if (templateSelectedLayer >= 0) {
    const layer = c.layers[templateSelectedLayer];
    if (layer) {
      body += renderLayerProps(layer, templateSelectedLayer);
    }
  }
  return body;
}

function renderLayerProps(layer, idx) {
  let body = `<div class="te-prop" style="margin-top:10px;"><label>Valgt lag</label>`;
  body += `<label>X (%)</label><input type="number" min="0" max="100" step="1" value="${Math.round(layer.x_pct || 0)}" oninput="updateLayer(${idx}, 'x_pct', parseFloat(this.value))">`;
  body += `<label>Y (%)</label><input type="number" min="0" max="100" step="1" value="${Math.round(layer.y_pct || 0)}" oninput="updateLayer(${idx}, 'y_pct', parseFloat(this.value))">`;
  body += `<label>Bredde (%)</label><input type="number" min="5" max="100" step="1" value="${Math.round(layer.w_pct || 50)}" oninput="updateLayer(${idx}, 'w_pct', parseFloat(this.value))">`;
  body += `<label>Høyde (%)</label><input type="number" min="5" max="100" step="1" value="${Math.round(layer.h_pct || 50)}" oninput="updateLayer(${idx}, 'h_pct', parseFloat(this.value))">`;
  if (layer.type === 'text') {
    body += `<label>Tekst</label><textarea rows="2" oninput="updateLayer(${idx}, 'value', this.value)">${escapeHtml(layer.value || '')}</textarea>`;
    body += `<label>Skriftstørrelse</label><input type="number" min="8" max="80" value="${layer.font_size || 16}" oninput="updateLayer(${idx}, 'font_size', parseInt(this.value,10) || 16)">`;
    body += `<label>Tekstfarge</label><div style="display:flex;gap:6px;"><input type="color" value="${layer.color || '#1a1610'}" oninput="updateLayer(${idx}, 'color', this.value)"><input type="text" value="${layer.color || '#1a1610'}" oninput="updateLayer(${idx}, 'color', this.value)" style="font-family:var(--font-mono);font-size:11px;"></div>`;
    body += `<label>Bakgrunnsfarge</label><div style="display:flex;gap:6px;"><input type="color" value="${(layer.bg_color || '#ffffff') === 'transparent' ? '#ffffff' : layer.bg_color}" oninput="updateLayer(${idx}, 'bg_color', this.value)"><button class="btn btn-sm btn-ghost" onclick="updateLayer(${idx}, 'bg_color', 'transparent')">Transparent</button></div>`;
  }
  body += `</div>`;
  return body;
}

/* ─── EGENSKAP-OPPDATERING ─── */
function updateHeader(field, value) {
  templateBuf.header[field] = value;
  // Header og footer deler bakgrunnsfarge — synk
  if (field === 'bg_color') {
    templateBuf.footer.bg_color = value;
  }
  if (field === 'text_color') {
    // Tekstfarge synkes også slik at de fremstår som ett designsystem
    templateBuf.footer.text_color = value;
  }
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  renderBoard();
}

function updateFooter(field, value) {
  templateBuf.footer[field] = value;
  if (field === 'bg_color') {
    templateBuf.header.bg_color = value;
  }
  if (field === 'text_color') {
    templateBuf.header.text_color = value;
  }
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  // Re-render side-panelet hvis det er header som er valgt
  // (slik at fargevelgeren reflekterer endringen)
  if (templateSelectedZone === 'header') {
    $('#te-prop-panel').innerHTML = renderHeaderProps();
  }
  renderBoard();
}

function updateContent(field, value) {
  templateBuf.content[field] = value;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  renderBoard();
}

function addFooterItem(type, value) {
  templateBuf.footer.items = templateBuf.footer.items || [];
  templateBuf.footer.items.push({ type, value: value || '' });
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderFooterProps();
  renderBoard();
}

function updateFooterItem(idx, value) {
  if (!templateBuf.footer.items[idx]) return;
  templateBuf.footer.items[idx].value = value;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  renderBoard();
}

function removeFooterItem(idx) {
  templateBuf.footer.items.splice(idx, 1);
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderFooterProps();
  renderBoard();
}

function toggleFooterSymbolPicker() {
  const el = $('#te-symbol-picker');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

/* ─── KOORD-OVERLAY-LINKING ─── */
function updateCoordOverlay(value) {
  const o = templateBuf.overlays.find(x => x.type === 'coord');
  if (!o) return;
  if (!value) {
    o.coord_x = null;
    o.coord_y = null;
  } else {
    const [x, y] = value.split(',').map(Number);
    o.coord_x = x;
    o.coord_y = y;
  }
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
}

function removeCoordOverlay() {
  templateBuf.overlays = templateBuf.overlays.filter(o => o.type !== 'coord');
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderTemplateProps();
  renderBoard();
}

/* ─── LAG-HÅNDTERING (placeholder for del 2) ─── */
function selectLayer(idx) {
  templateSelectedLayer = idx;
  templateSelectedZone = 'content';
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderContentProps();
}

function addTextLayer() {
  templateBuf.content.layers = templateBuf.content.layers || [];
  templateBuf.content.layers.push({
    type: 'text',
    value: 'Ny tekst',
    font_size: 16,
    color: '#1a1610',
    bg_color: 'transparent',
    x_pct: 25, y_pct: 35, w_pct: 50, h_pct: 30,
  });
  templateSelectedLayer = templateBuf.content.layers.length - 1;
  templateSelectedZone = 'content';
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderContentProps();
}

async function addImageLayer(input) {
  const file = input.files[0];
  if (!file) return;
  if (!state.currentScenarioId) {
    showToast('Lagre scenarioet først', 'error');
    return;
  }
  try {
    showToast('Laster opp...', 'info');
    // Beregn neste lag-nummer for dette kortet. Brukes som suffix i filnavnet
    // slik at flere bildelag p\u00e5 samme kort f\u00e5r unike navn:
    //   Grid-kortnavn-1.jpg, Grid-kortnavn-2.jpg, ...
    // Vi teller eksisterende bildelag + 1; hvis lag senere slettes oppst\u00e5r
    // hull i nummereringen, men det er greit \u2014 filnavnet er bare arkivnavn.
    templateBuf.content.layers = templateBuf.content.layers || [];
    const existingImageLayers = templateBuf.content.layers.filter(l => l.type === 'image').length;
    const layerNum = existingImageLayers + 1;
    const baseFilename = buildCardExportFilename(templateBuf).replace(/\.png$/i, '');
    const filename = `${baseFilename}-${layerNum}.jpg`;

    const result = await uploadImage(file, {
      scenario_id: state.currentScenarioId,
      kind: 'originals',
      filename,
      overwrite: true,
    });
    templateBuf.content.layers.push({
      type: 'image',
      url: result.url,
      path: result.path,
      thumb_url: result.thumb_url || result.url,
      thumb_path: result.thumb_path || null,
      original_num: layerNum,  // brukes til navngiving ved re-opplasting
      x_pct: 10, y_pct: 10, w_pct: 80, h_pct: 70,
    });
    templateSelectedLayer = templateBuf.content.layers.length - 1;
    templateSelectedZone = 'content';
    $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
    $('#te-prop-panel').innerHTML = renderContentProps();
    renderBoard();
    showToast('Bildelag lagt til', 'success');
  } catch (e) {
    showToast('Opplasting feilet: ' + e.message, 'error');
  } finally {
    input.value = '';
  }
}

function updateLayer(idx, field, value) {
  const layer = templateBuf.content.layers[idx];
  if (!layer) return;
  layer[field] = value;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  renderBoard();
}

function moveLayer(idx, delta) {
  const layers = templateBuf.content.layers;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= layers.length) return;
  [layers[idx], layers[newIdx]] = [layers[newIdx], layers[idx]];
  templateSelectedLayer = newIdx;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderContentProps();
  renderBoard();
}

async function removeLayer(idx) {
  const layer = templateBuf.content.layers[idx];
  if (!layer) return;
  if (!confirm('Slett dette laget?')) return;
  // Rydd Dropbox-bilder
  if (layer.type === 'image' && layer.path?.startsWith('/Escape Box/')) {
    try { await deleteImage(layer.path, layer.url); } catch (e) { /* ignore */ }
    if (layer.thumb_path?.startsWith('/Escape Box/')) {
      try { await deleteImage(layer.thumb_path, layer.thumb_url); } catch (e) { /* ignore */ }
    }
  }
  templateBuf.content.layers.splice(idx, 1);
  if (templateSelectedLayer === idx) templateSelectedLayer = -1;
  else if (templateSelectedLayer > idx) templateSelectedLayer--;
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderContentProps();
  renderBoard();
}

/* ─── DRAG/RESIZE FOR CONTENT-LAG ─── */
function onLayerMouseDown(e, layerIdx, mode = 'move') {
  e.preventDefault();
  e.stopPropagation();
  if (templateTool !== 'select') return;

  const layer = templateBuf.content.layers[layerIdx];
  if (!layer) return;

  templateSelectedLayer = layerIdx;
  templateSelectedZone = 'content';

  const { cellPx, width, height } = getCardCanvasSize();
  const headerH = (templateBuf.header.rows || HEADER_DEFAULT_ROWS) * cellPx;
  const footerH = (templateBuf.footer.rows || FOOTER_DEFAULT_ROWS) * cellPx;
  const contentH = height - headerH - footerH;

  templateDrag = {
    mode,
    layerIdx,
    startX: e.clientX,
    startY: e.clientY,
    origX: layer.x_pct || 0,
    origY: layer.y_pct || 0,
    origW: layer.w_pct || 50,
    origH: layer.h_pct || 50,
    pxW: width,
    pxH: contentH,
  };
  document.addEventListener('mousemove', onLayerMouseMove);
  document.addEventListener('mouseup', onLayerMouseUp);
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
  $('#te-prop-panel').innerHTML = renderContentProps();
}

function onLayerMouseMove(e) {
  const drag = templateDrag;
  if (!drag) return;
  const layer = templateBuf.content.layers[drag.layerIdx];
  if (!layer) return;

  const dxPct = ((e.clientX - drag.startX) / drag.pxW) * 100;
  const dyPct = ((e.clientY - drag.startY) / drag.pxH) * 100;

  if (drag.mode === 'move') {
    layer.x_pct = Math.max(0, Math.min(100 - (layer.w_pct || 50), drag.origX + dxPct));
    layer.y_pct = Math.max(0, Math.min(100 - (layer.h_pct || 50), drag.origY + dyPct));
  } else if (drag.mode === 'resize-se') {
    layer.w_pct = Math.max(5, Math.min(100 - (layer.x_pct || 0), drag.origW + dxPct));
    layer.h_pct = Math.max(5, Math.min(100 - (layer.y_pct || 0), drag.origH + dyPct));
  }
  $('#te-canvas-wrap').innerHTML = renderTemplateCanvas();
}

function onLayerMouseUp() {
  templateDrag = null;
  document.removeEventListener('mousemove', onLayerMouseMove);
  document.removeEventListener('mouseup', onLayerMouseUp);
  // Oppdater også egenskapspanelet med nye verdier
  $('#te-prop-panel').innerHTML = renderContentProps();
  renderBoard();
}

/* ─── RENDER PÅ INVESTIGATION BOARD ─── */
function renderTemplateOnBoard(card, cx, cy, cw, ch, sel) {
  ensureTemplateShape(card);
  const cellW = cw / card.cols;
  const cellH = ch / card.rows;
  const headerRows = card.header.rows || HEADER_DEFAULT_ROWS;
  const footerRows = card.footer.rows || FOOTER_DEFAULT_ROWS;
  const headerH = headerRows * cellH;
  const footerH = footerRows * cellH;
  const contentY = cy + headerH;
  const contentH = ch - headerH - footerH;
  let s = '';

  // Content-bakgrunn
  s += `<rect x="${cx}" y="${contentY}" width="${cw}" height="${contentH}" fill="${card.content.bg_color}" pointer-events="none"/>`;

  // Content-lag
  (card.content.layers || []).forEach(layer => {
    const lx = cx + (layer.x_pct || 0) * cw / 100;
    const ly = contentY + (layer.y_pct || 0) * contentH / 100;
    const lw = (layer.w_pct || 50) * cw / 100;
    const lh = (layer.h_pct || 50) * contentH / 100;
    if (layer.type === 'image' && (layer.thumb_url || layer.url)) {
      s += `<image href="${escapeHtml(layer.thumb_url || layer.url)}" x="${lx}" y="${ly}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet" pointer-events="none"/>`;
    } else if (layer.type === 'text') {
      const fz = Math.max(6, (layer.font_size || 16) * (cw / 300));
      const txt = (layer.value || '').slice(0, 60);
      if (layer.bg_color && layer.bg_color !== 'transparent') {
        s += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" fill="${layer.bg_color}" pointer-events="none"/>`;
      }
      s += `<text x="${lx + lw/2}" y="${ly + lh/2}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-serif)" font-size="${fz}" fill="${layer.color || '#1a1610'}" pointer-events="none">${escapeHtml(txt)}</text>`;
    }
  });

  // Header
  s += `<rect x="${cx}" y="${cy}" width="${cw}" height="${headerH}" fill="${card.header.bg_color}" pointer-events="none"/>`;

  // Header-tittel: dynamisk skala basert p\u00e5 tittellengde (matcher eksport-versjonen)
  const tboTitle = (card.header.title || '').slice(0, 40);
  const tboBaseHeaderFz = Math.max(7, headerH * 0.34);
  const tboTitleAreaWidth = cw * 0.65;
  const tboEstimatedWidth = tboTitle.length * tboBaseHeaderFz * 0.55;
  const tboScaleDown = tboEstimatedWidth > tboTitleAreaWidth
    ? tboTitleAreaWidth / tboEstimatedWidth
    : 1;
  const headerFz = Math.max(7, tboBaseHeaderFz * tboScaleDown);

  s += `<text x="${cx + cw * 0.06}" y="${cy + headerH/2}" dominant-baseline="middle" font-family="var(--font-serif)" font-size="${headerFz}" font-weight="700" fill="${card.header.text_color}" pointer-events="none">${escapeHtml(tboTitle)}</text>`;

  // 4-kode-badge med stabil st\u00f8rrelse
  if (card.header.code) {
    const codeFz = Math.max(7, headerH * 0.32);
    const padX = codeFz * 0.5;
    const padY = codeFz * 0.15;
    const codeText = (card.header.code || '').slice(0, 6);
    const codeWidth = codeText.length * codeFz * 0.65 + padX * 2;
    const codeHeight = codeFz + padY * 2;
    const codeX = cx + cw * 0.94 - codeWidth;
    const codeY = cy + headerH/2 - codeHeight/2;
    s += `<rect x="${codeX}" y="${codeY}" width="${codeWidth}" height="${codeHeight}" fill="${card.header.code_bg_color || '#c8961a'}" stroke="rgba(0,0,0,0.2)" stroke-width="0.5" rx="2" pointer-events="none"/>`;
    s += `<text x="${codeX + codeWidth/2}" y="${cy + headerH/2}" text-anchor="middle" dominant-baseline="middle" font-family="var(--font-mono)" font-size="${codeFz}" font-weight="700" fill="${card.header.code_text_color || '#1a1610'}" pointer-events="none">${escapeHtml(codeText)}</text>`;
  }

  // Footer
  const fy = cy + ch - footerH;
  s += `<rect x="${cx}" y="${fy}" width="${cw}" height="${footerH}" fill="${card.footer.bg_color}" pointer-events="none"/>`;

  const tboFooterItems = card.footer.items || [];
  if (tboFooterItems.length > 0) {
    const tboBaseFooterFz = Math.max(6, footerH * 0.45);
    const tboPadX = cw * 0.06;
    const tboAvailableW = cw - tboPadX * 2;
    const tboItemGap = tboBaseFooterFz * 0.4;

    let tboEstimatedW = 0;
    tboFooterItems.forEach((item, i) => {
      const txt = item.value || '';
      const itemW = item.type === 'symbol'
        ? tboBaseFooterFz * 1.4
        : txt.length * tboBaseFooterFz * 0.55;
      tboEstimatedW += itemW;
      if (i < tboFooterItems.length - 1) tboEstimatedW += tboItemGap;
    });

    const tboFooterScale = tboEstimatedW > tboAvailableW ? tboAvailableW / tboEstimatedW : 1;
    const footerFz = Math.max(6, tboBaseFooterFz * tboFooterScale);
    const tboGap = tboItemGap * tboFooterScale;

    let fx = cx + tboPadX;
    tboFooterItems.forEach(item => {
      const txt = item.value || '';
      const isSymbol = item.type === 'symbol';
      const itemFz = isSymbol ? footerFz * 1.2 : footerFz;
      s += `<text x="${fx}" y="${fy + footerH/2}" dominant-baseline="middle" font-family="var(--font-cond)" font-size="${itemFz}" fill="${card.footer.text_color}" pointer-events="none">${escapeHtml(txt)}</text>`;
      fx += (isSymbol ? footerFz * 1.4 : txt.length * footerFz * 0.55) + tboGap;
    });
  }

  // Grid-stiplet på toppen
  for (let r = 1; r < card.rows; r++) {
    s += `<line x1="${cx}" y1="${cy + r*cellH}" x2="${cx + cw}" y2="${cy + r*cellH}" stroke="rgba(60,40,20,0.28)" stroke-width="0.5" stroke-dasharray="2 2" pointer-events="none"/>`;
  }
  for (let c = 1; c < card.cols; c++) {
    s += `<line x1="${cx + c*cellW}" y1="${cy}" x2="${cx + c*cellW}" y2="${cy + ch}" stroke="rgba(60,40,20,0.28)" stroke-width="0.5" stroke-dasharray="2 2" pointer-events="none"/>`;
  }

  // Anker / koord-symbol (oppå alt)
  (card.overlays || []).forEach(o => {
    const ox = cx + o.col * cellW + cellW/2;
    const oy = cy + o.row * cellH + cellH/2;
    const cellSize = Math.min(cellW, cellH);
    if (o.type === 'anchor') {
      // Stort anker som SVG-path
      s += renderAnchorSvg(ox, oy, cellSize * 0.78, '#b83228');
    } else if (o.type === 'coord') {
      // Målskive med ?
      const r1 = cellSize * 0.42;
      const r2 = cellSize * 0.26;
      s += `<circle cx="${ox}" cy="${oy}" r="${r1}" fill="#fff" stroke="#1a4a7a" stroke-width="${cellSize * 0.06}" pointer-events="none"/>`;
      s += `<circle cx="${ox}" cy="${oy}" r="${r2}" fill="none" stroke="#1a4a7a" stroke-width="${cellSize * 0.04}" pointer-events="none"/>`;
      s += `<text x="${ox}" y="${oy + cellSize * 0.03}" text-anchor="middle" dominant-baseline="middle" font-size="${cellSize * 0.36}" fill="#1a4a7a" font-weight="700" font-family="var(--font-serif)" pointer-events="none">?</text>`;
    }
  });

  // Ramme (drabar)
  s += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="transparent" stroke="${sel ? 'var(--blue)' : 'var(--ink2)'}" stroke-width="${sel ? 2 : 1}" stroke-dasharray="${sel ? '4 3' : 'none'}" style="cursor:move;"/>`;

  return s;
}


/* ════════════════════════════════════════════════════════
   PNG-EKSPORT — kort og board som bildefiler
   ─────────────────────────────────────────────────────────
   Genererer en PNG-versjon av kort og board ved lagring og
   laster opp til Dropbox. PNG-ene er kladdkvalitet for
   forh\u00e5ndsvisning og print-planlegging.

   - Kort: 5\u00d77 cm @ 150 DPI \u2248 295\u00d7413 px. Inkl. overlays.
   - Board: cellSize px per rute. Grid + ankere + kort-omriss.
     Ingen koord-symboler, ingen kort-grafikk.

   URL-er for de eksporterte PNG-ene lagres p\u00e5:
     card.export_url, card.export_path
     scenarioBuf.scenario_data.board_export_url,
     scenarioBuf.scenario_data.board_export_path
   ─────────────────────────────────────────────────────── */

// Hver grid-rute = 1 cm fysisk @ 150 DPI \u2248 60 px.
// PNG-st\u00f8rrelsen blir s\u00e5ledes (cols \u00d7 PX_PER_CELL) \u00d7 (rows \u00d7 PX_PER_CELL).
// 5\u00d77 kort  \u2192 300\u00d7420 px
// 14\u00d710 kort \u2192 840\u00d7600 px
// PNG-oppl\u00f8sning per grid-rute. 200 px gir god lesbarhet og rimelig filst\u00f8rrelse.
// 5\u00d77 kort  \u2192 1000\u00d71400 px
// 14\u00d710 kort \u2192 2800\u00d72000 px
// Thumb genereres med THUMB_PX_PER_CELL (lavere) for rask kortliste-visning.
const CARD_EXPORT_PX_PER_CELL = 200;
const CARD_THUMB_PX_PER_CELL = 50;

/* Returnerer ren SVG-streng for ett template-kort, klart for PNG-konvertering.
   Dimensjoner f\u00f8lger kortets cols \u00d7 rows. Hver rute er PX_PER_CELL piksler.
*/
function renderTemplateCardForExport(card) {
  ensureTemplateShape(card);
  const cellW = CARD_EXPORT_PX_PER_CELL;
  const cellH = CARD_EXPORT_PX_PER_CELL;
  const W = card.cols * cellW;
  const H = card.rows * cellH;
  const headerRows = card.header.rows || HEADER_DEFAULT_ROWS;
  const footerRows = card.footer.rows || FOOTER_DEFAULT_ROWS;
  const headerH = headerRows * cellH;
  const footerH = footerRows * cellH;
  const contentY = headerH;
  const contentH = H - headerH - footerH;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;

  // Hvit bakgrunn under alt
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;

  // Content-bakgrunn
  s += `<rect x="0" y="${contentY}" width="${W}" height="${contentH}" fill="${card.content.bg_color}"/>`;

  // Content-lag
  (card.content.layers || []).forEach(layer => {
    const lx = (layer.x_pct || 0) * W / 100;
    const ly = contentY + (layer.y_pct || 0) * contentH / 100;
    const lw = (layer.w_pct || 50) * W / 100;
    const lh = (layer.h_pct || 50) * contentH / 100;
    if (layer.type === 'image' && (layer.url || layer.thumb_url)) {
      s += `<image href="${escapeHtml(layer.url || layer.thumb_url)}" x="${lx}" y="${ly}" width="${lw}" height="${lh}" preserveAspectRatio="xMidYMid meet"/>`;
    } else if (layer.type === 'text') {
      const fz = layer.font_size || 16;
      const txt = layer.value || '';
      if (layer.bg_color && layer.bg_color !== 'transparent') {
        s += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" fill="${layer.bg_color}"/>`;
      }
      s += `<text x="${lx + lw/2}" y="${ly + lh/2}" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-size="${fz}" fill="${layer.color || '#1a1610'}">${escapeHtml(txt.slice(0, 100))}</text>`;
    }
  });

  // Header
  s += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${card.header.bg_color}"/>`;

  // Header-tittel: dynamisk fontst\u00f8rrelse basert p\u00e5 b\u00e5de header-h\u00f8yden
  // og tittel-lengden. Lengre titler f\u00e5r mindre font slik at de f\u00e5r plass.
  const title = (card.header.title || '').slice(0, 40);
  const baseHeaderFz = Math.max(7, headerH * 0.34);  // mindre default (0.34 vs 0.42)
  // Anta at 4-koden tar ca 25% av bredden, s\u00e5 tittel-omr\u00e5det er ca 65%
  const titleAreaWidth = W * 0.65;
  // Grov estimat: hver tegn er ~0.55 \u00d7 fontH bred. Skaler ned hvis n\u00f8dvendig.
  const estimatedWidth = title.length * baseHeaderFz * 0.55;
  const scaleDown = estimatedWidth > titleAreaWidth
    ? titleAreaWidth / estimatedWidth
    : 1;
  const headerFz = Math.max(7, baseHeaderFz * scaleDown);

  s += `<text x="${W * 0.06}" y="${headerH/2}" dominant-baseline="middle" font-family="Georgia, serif" font-size="${headerFz}" font-weight="700" fill="${card.header.text_color}">${escapeHtml(title)}</text>`;

  // 4-kode badge \u2014 beholder en stabil st\u00f8rrelse uavhengig av tittellengde
  if (card.header.code) {
    const codeFz = Math.max(7, headerH * 0.32);
    const padX = codeFz * 0.5;
    const padY = codeFz * 0.15;
    const codeText = (card.header.code || '').slice(0, 6);
    const codeWidth = codeText.length * codeFz * 0.65 + padX * 2;
    const codeHeight = codeFz + padY * 2;
    const codeX = W * 0.94 - codeWidth;
    const codeY = headerH/2 - codeHeight/2;
    s += `<rect x="${codeX}" y="${codeY}" width="${codeWidth}" height="${codeHeight}" fill="${card.header.code_bg_color || '#c8961a'}" stroke="rgba(0,0,0,0.2)" stroke-width="0.5" rx="2"/>`;
    s += `<text x="${codeX + codeWidth/2}" y="${headerH/2}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, monospace" font-size="${codeFz}" font-weight="700" fill="${card.header.code_text_color || '#1a1610'}">${escapeHtml(codeText)}</text>`;
  }

  // Footer
  const fy = H - footerH;
  s += `<rect x="0" y="${fy}" width="${W}" height="${footerH}" fill="${card.footer.bg_color}"/>`;

  const footerItems = card.footer.items || [];
  if (footerItems.length > 0) {
    // Auto-skaler font slik at alle items f\u00e5r plass i footer-bredden.
    // Footer-bredde minus padding p\u00e5 begge sider ~= W * 0.88.
    const baseFooterFz = Math.max(6, footerH * 0.45);
    const padX = W * 0.06;
    const availableW = W - padX * 2;
    const itemGap = baseFooterFz * 0.4;

    // Beregn samlet bredde for items ved base-st\u00f8rrelse
    let estimatedW = 0;
    footerItems.forEach((item, i) => {
      const txt = item.value || '';
      const itemW = item.type === 'symbol'
        ? baseFooterFz * 1.4
        : txt.length * baseFooterFz * 0.55;
      estimatedW += itemW;
      if (i < footerItems.length - 1) estimatedW += itemGap;
    });

    const footerScale = estimatedW > availableW ? availableW / estimatedW : 1;
    const footerFz = Math.max(6, baseFooterFz * footerScale);
    const gap = itemGap * footerScale;

    let fx = padX;
    footerItems.forEach(item => {
      const txt = item.value || '';
      const isSymbol = item.type === 'symbol';
      const itemFz = isSymbol ? footerFz * 1.2 : footerFz;
      s += `<text x="${fx}" y="${fy + footerH/2}" dominant-baseline="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="${itemFz}" fill="${card.footer.text_color}">${escapeHtml(txt)}</text>`;
      fx += (isSymbol ? footerFz * 1.4 : txt.length * footerFz * 0.55) + gap;
    });
  }

  // Stiplet grid over alt
  for (let r = 1; r < card.rows; r++) {
    s += `<line x1="0" y1="${r*cellH}" x2="${W}" y2="${r*cellH}" stroke="rgba(60,40,20,0.32)" stroke-width="0.6" stroke-dasharray="2 2"/>`;
  }
  for (let c = 1; c < card.cols; c++) {
    s += `<line x1="${c*cellW}" y1="0" x2="${c*cellW}" y2="${H}" stroke="rgba(60,40,20,0.32)" stroke-width="0.6" stroke-dasharray="2 2"/>`;
  }

  // Anker- og koord-overlays (\u00f8nsket av brukeren p\u00e5 kort-PNG)
  (card.overlays || []).forEach(o => {
    const ox = o.col * cellW + cellW/2;
    const oy = o.row * cellH + cellH/2;
    const cellSize = Math.min(cellW, cellH);
    if (o.type === 'anchor') {
      s += renderAnchorSvg(ox, oy, cellSize * 0.78, '#b83228');
    } else if (o.type === 'coord') {
      const r1 = cellSize * 0.42;
      const r2 = cellSize * 0.26;
      s += `<circle cx="${ox}" cy="${oy}" r="${r1}" fill="#fff" stroke="#1a4a7a" stroke-width="${cellSize * 0.06}"/>`;
      s += `<circle cx="${ox}" cy="${oy}" r="${r2}" fill="none" stroke="#1a4a7a" stroke-width="${cellSize * 0.04}"/>`;
      s += `<text x="${ox}" y="${oy + cellSize * 0.03}" text-anchor="middle" dominant-baseline="middle" font-size="${cellSize * 0.36}" fill="#1a4a7a" font-weight="700" font-family="Georgia, serif">?</text>`;
    }
  });

  s += `</svg>`;
  return s;
}

/* Returnerer ren SVG-streng for hele Investigation Board.
   Inkluderer: grid, kort-omriss, ankere med bokstaver.
   IKKE: kort-grafikk, koord-symboler.
*/
function renderBoardForExport() {
  const sd = scenarioBuf.scenario_data;
  const g = sd.grid;
  const cs = g.cell_size;
  const showLabels = g.show_labels !== false;
  const M = showLabels ? Math.max(22, Math.round(cs * 0.5)) : 0;
  const innerW = g.x * cs;
  const innerH = g.y * cs;
  const W = innerW + M * 2;
  const H = innerH + M * 2;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;

  // Bakgrunn
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="#fbfaf6"/>`;

  // Akse-bakgrunn + overskrifter
  if (showLabels) {
    s += `<rect x="0" y="0" width="${W}" height="${M}" fill="#f0eadb"/>`;
    s += `<rect x="0" y="${H - M}" width="${W}" height="${M}" fill="#f0eadb"/>`;
    s += `<rect x="0" y="0" width="${M}" height="${H}" fill="#f0eadb"/>`;
    s += `<rect x="${W - M}" y="0" width="${M}" height="${H}" fill="#f0eadb"/>`;
    const colFz = Math.max(10, Math.min(16, cs * 0.32));
    for (let x = 0; x < g.x; x++) {
      const px = M + x * cs + cs / 2;
      s += `<text x="${px}" y="${M / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, monospace" font-size="${colFz}" font-weight="700" fill="#1a1610">${x}</text>`;
      s += `<text x="${px}" y="${H - M / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, monospace" font-size="${colFz}" font-weight="700" fill="#1a1610">${x}</text>`;
    }
    for (let y = 0; y < g.y; y++) {
      const py = M + y * cs + cs / 2;
      s += `<text x="${M / 2}" y="${py}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, monospace" font-size="${colFz}" font-weight="700" fill="#1a1610">${y}</text>`;
      s += `<text x="${W - M / 2}" y="${py}" text-anchor="middle" dominant-baseline="middle" font-family="Menlo, monospace" font-size="${colFz}" font-weight="700" fill="#1a1610">${y}</text>`;
    }
    s += `<line x1="0" y1="${M}" x2="${W}" y2="${M}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    s += `<line x1="0" y1="${H - M}" x2="${W}" y2="${H - M}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    s += `<line x1="${M}" y1="0" x2="${M}" y2="${H}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
    s += `<line x1="${W - M}" y1="0" x2="${W - M}" y2="${H}" stroke="rgba(60,40,20,0.35)" stroke-width="0.8"/>`;
  }

  s += `<g transform="translate(${M},${M})">`;

  // Grid-celler (uten tall i hver — n\u00e5 har vi akse-overskrifter)
  for (let y = 0; y < g.y; y++) {
    for (let x = 0; x < g.x; x++) {
      s += `<rect x="${x*cs}" y="${y*cs}" width="${cs}" height="${cs}" fill="none" stroke="#d8d0bd" stroke-width="0.5"/>`;
    }
  }

  // Kort-omriss (stiplet)
  (sd.physical_cards || []).forEach(card => {
    if (card.in_stash) return;  // bunke-kort vises ikke p\u00e5 board-PNG
    const cx = (card.grid_x || 0) * cs;
    const cy = (card.grid_y || 0) * cs;
    const cw = (card.grid_w || 1) * cs;
    const ch = (card.grid_h || 1) * cs;
    s += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" fill="none" stroke="rgba(60,40,20,0.45)" stroke-width="1" stroke-dasharray="6 4"/>`;
    if (card.name) {
      s += `<text x="${cx + 4}" y="${cy + 12}" font-family="Helvetica Neue, Arial, sans-serif" font-size="10" fill="rgba(60,40,20,0.7)">${escapeHtml(card.name.slice(0, 20))}</text>`;
    }
  });

  // Ankere
  const anchors = getBoardAnchors();
  anchors.forEach(a => {
    const ax = a.x * cs + cs / 2;
    const ay = a.y * cs + cs / 2;
    s += renderAnchorSvg(ax, ay, cs * 0.55, '#b83228');
    const labelR = cs * 0.18;
    const lx = a.x * cs + cs - labelR - 2;
    const ly = a.y * cs + labelR + 2;
    s += `<circle cx="${lx}" cy="${ly}" r="${labelR}" fill="#b83228" stroke="#fff" stroke-width="1.5"/>`;
    s += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle" font-family="Helvetica Neue, Arial, sans-serif" font-size="${labelR * 1.3}" font-weight="700" fill="#fff">${escapeHtml(a.label)}</text>`;
  });

  s += `</g>`;
  s += `</svg>`;
  return s;
}

/* Eksporterer ett kort som PNG og laster opp til Dropbox.
   Lagrer URL og path p\u00e5 card.export_url og card.export_path.
   Returnerer { url, path } eller null hvis feil.
*/
/* Bygger filnavn for kort-PNG basert p\u00e5 kortets navn og om det ligger
   p\u00e5 board eller i bunke. Bruker sanitizeFilename for trygge tegn.
   Eksempler:
     "Document Folder 1" p\u00e5 board → "Grid-document-folder-1.png"
     "Hint kart"         i bunke   → "Bunke-hint-kart.png"
*/
function buildCardExportFilename(card) {
  const prefix = card.in_stash ? 'Bunke' : 'Grid';
  const safe = sanitizeFilename(card.name || 'uten-navn');
  return `${prefix}-${safe}.png`;
}

async function exportCardPng(card) {
  if (!card || card.type !== 'template') return null;
  if (!state.currentScenarioId) return null;
  try {
    // Generer to st\u00f8rrelser: en full (h\u00f8y opp\u0142, for produksjon/print)
    // og en thumb (lav opp\u0142, for raske kortliste-visninger).
    const W = (card.cols || 5) * CARD_EXPORT_PX_PER_CELL;
    const H = (card.rows || 7) * CARD_EXPORT_PX_PER_CELL;
    const tW = (card.cols || 5) * CARD_THUMB_PX_PER_CELL;
    const tH = (card.rows || 7) * CARD_THUMB_PX_PER_CELL;
    const svg = renderTemplateCardForExport(card);
    const [fullBlob, thumbBlob] = await Promise.all([
      svgToPngBlob(svg, W, H, '#ffffff'),
      svgToPngBlob(svg, tW, tH, '#ffffff'),
    ]);
    const filename = buildCardExportFilename(card);
    const thumbFilename = `thumb-${filename}`;

    // Hvis kortet er blitt renamed eller flyttet mellom grid/bunke, vil
    // det nye filnavnet skille seg fra det gamle. Da rydder vi opp i
    // den gamle filen f\u00f8r vi laster opp den nye, slik at vi ikke
    // etterlater foreldrel\u00f8se PNG-er i Dropbox.
    const oldPath = card.export_path;
    const oldThumbPath = card.export_thumb_path;
    const oldFilename = oldPath ? oldPath.split('/').pop() : null;
    const filenameChanged = oldFilename && oldFilename !== filename;

    // Last opp begge parallelt
    const [fullResult, thumbResult] = await Promise.all([
      uploadPngBlob(fullBlob, {
        scenario_id: state.currentScenarioId,
        kind: 'cards',
        filename,
        overwrite: true,
      }),
      uploadPngBlob(thumbBlob, {
        scenario_id: state.currentScenarioId,
        kind: 'cards',
        filename: thumbFilename,
        overwrite: true,
      }),
    ]);

    if (fullResult?.url) {
      card.export_url = fullResult.url;
      card.export_path = fullResult.path;
    }
    if (thumbResult?.url) {
      card.export_thumb_url = thumbResult.url;
      card.export_thumb_path = thumbResult.path;
    }

    // Rydd gamle filer hvis filnavnet endret seg
    if (filenameChanged) {
      if (oldPath?.startsWith('/Escape Box/')) {
        deleteImage(oldPath).catch(e => console.warn('Slett-feil full:', e.message));
      }
      if (oldThumbPath?.startsWith('/Escape Box/')) {
        deleteImage(oldThumbPath).catch(e => console.warn('Slett-feil thumb:', e.message));
      }
    }

    return fullResult;
  } catch (e) {
    console.warn('Kort-eksport feilet:', e.message);
    return null;
  }
}

/* Eksporterer hele Investigation Board som PNG og laster opp.
   Lagrer URL p\u00e5 scenario_data.board_export_url.
*/
async function exportBoardPng() {
  if (!state.currentScenarioId) return null;
  if (!scenarioBuf?.scenario_data) return null;
  try {
    const sd = scenarioBuf.scenario_data;
    const g = sd.grid;
    const cs = g.cell_size;
    const showLabels = g.show_labels !== false;
    const M = showLabels ? Math.max(22, Math.round(cs * 0.5)) : 0;
    const W = g.x * cs + M * 2;
    const H = g.y * cs + M * 2;
    const svg = renderBoardForExport();
    const blob = await svgToPngBlob(svg, W, H, '#fbfaf6');
    const result = await uploadPngBlob(blob, {
      scenario_id: state.currentScenarioId,
      kind: 'backgrounds',
      filename: 'Grid-board.png',
      overwrite: true,
    });
    if (result?.url) {
      sd.board_export_url = result.url;
      sd.board_export_path = result.path;
    }
    return result;
  } catch (e) {
    console.warn('Board-eksport feilet:', e.message);
    return null;
  }
}

/* ─── FYSISKE KORT (bilde-kort) — drag, resize, upload ─── */
async function onCardImageUpload(input) {
  const file = input.files[0];
  if (!file) return;

  if (!state.currentScenarioId) {
    showToast('Lagre scenarioet først, så kan du laste opp bilder', 'error');
    input.value = '';
    return;
  }

  const name = (file.name || 'kort').replace(/\.[^.]+$/, '');
  const id = 'card_' + Date.now();

  // Legg inn placeholder-kort med en gang så brukeren ser fremdrift
  const placeholder = {
    id,
    name,
    image_path: null,
    image_url: null,
    uploading: true,
    progress: 0,
    grid_x: 0,
    grid_y: 0,
    grid_w: 3,
    grid_h: 3,
  };
  scenarioBuf.scenario_data.physical_cards.push(placeholder);
  boardState.selectedCard = id;
  renderBoard();

  try {
    const result = await uploadImage(file, {
      scenario_id: state.currentScenarioId,
      kind: 'cards',
      onProgress: (p) => {
        placeholder.progress = p;
        renderCardsList();  // bare oppdater listen, ikke hele boarden
      },
    });

    placeholder.image_path = result.path;
    placeholder.image_url = result.url;
    placeholder.thumb_path = result.thumb_path || null;
    placeholder.thumb_url = result.thumb_url || result.url;
    placeholder.uploading = false;
    placeholder.progress = 1;
    renderBoard();
    showToast(`Bildet er lastet opp (${Math.round(result.size / 1024)} KB)`, 'success');
  } catch (e) {
    // Fjern placeholder-kortet ved feil
    scenarioBuf.scenario_data.physical_cards =
      scenarioBuf.scenario_data.physical_cards.filter(c => c.id !== id);
    if (boardState.selectedCard === id) boardState.selectedCard = null;
    renderBoard();
    showToast('Opplasting feilet: ' + e.message, 'error');
  } finally {
    input.value = '';
  }
}

function selectCard(id) {
  boardState.selectedCard = id;
  boardState.selectedCoord = null;
  renderBoard();
}

/* Sletter alle Dropbox-filer knyttet til et kort.
   Dette inkluderer:
   - card.image_path / card.thumb_path (bilde-kort)
   - card.export_path / card.export_thumb_path (PNG-eksporter)
   - alle bildelag i card.content.layers (template-kort)
   Best-effort: feil ved enkeltsletting stopper ikke totalen.
*/
async function deleteAllCardAssets(card) {
  if (!card) return;
  const candidates = [];

  // Bilde-kort (gammel type)
  if (card.image_path) candidates.push({ path: card.image_path, url: card.image_url });
  if (card.thumb_path) candidates.push({ path: card.thumb_path, url: card.thumb_url });

  // PNG-eksporter (alle korttyper kan ha disse)
  if (card.export_path) candidates.push({ path: card.export_path, url: card.export_url });
  if (card.export_thumb_path) candidates.push({ path: card.export_thumb_path, url: card.export_thumb_url });

  // Template-kort: bildelag i content
  if (card.type === 'template' && card.content?.layers) {
    card.content.layers.forEach(layer => {
      if (layer.type === 'image') {
        if (layer.path) candidates.push({ path: layer.path, url: layer.url });
        if (layer.thumb_path) candidates.push({ path: layer.thumb_path, url: layer.thumb_url });
      }
    });
  }

  // Eldre 'cells'-format (migrerte template-kort)
  if (Array.isArray(card.cells)) {
    card.cells.forEach(c => {
      if (c.path) candidates.push({ path: c.path, url: c.url });
      if (c.thumb_path) candidates.push({ path: c.thumb_path, url: c.thumb_url });
    });
  }

  // Slett alt parallelt — best effort
  await Promise.allSettled(
    candidates
      .filter(c => c.path && c.path.startsWith('/Escape Box/'))
      .map(c => deleteImage(c.path, c.url).catch(e => console.warn('Slett-feil:', c.path, e.message)))
  );
}

async function removeCard(id) {
  if (!confirm('Fjerne dette kortet fra scenarioet? Bilder slettes ogs\u00e5 fra skylagring.')) return;
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === id);

  await deleteAllCardAssets(card);

  scenarioBuf.scenario_data.physical_cards =
    scenarioBuf.scenario_data.physical_cards.filter(c => c.id !== id);
  if (boardState.selectedCard === id) boardState.selectedCard = null;
  renderBoard();
  // Oppdater bunken hvis vi er der
  if (typeof renderStashList === 'function') renderStashList();
}

/* ─── DRAG-LOGIKK FOR FYSISKE KORT ─── */
function onCardMouseDown(e, cardId, mode = 'move') {
  e.preventDefault();
  e.stopPropagation();

  // Block-pick-modus: klikk på et kort = toggle trigger, ikke drag.
  if (blockEditorState.pickMode && blockEditorState.activeBlockId && mode === 'move') {
    toggleBlockTriggerForCard(cardId);
    return;
  }

  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === cardId);
  if (!card) return;
  boardState.selectedCard = cardId;
  boardState.draggingCard = {
    cardId, mode,
    startX: e.clientX,
    startY: e.clientY,
    origX: card.grid_x,
    origY: card.grid_y,
    origW: card.grid_w,
    origH: card.grid_h,
  };
  // Vis live-info-panelet
  updateLiveInfoFromCard(card);
  document.addEventListener('mousemove', onCardMouseMove);
  document.addEventListener('mouseup', onCardMouseUp);
  renderBoard();
}

function onCardMouseMove(e) {
  const drag = boardState.draggingCard;
  if (!drag) return;
  const cs = scenarioBuf.scenario_data.grid.cell_size;
  // Skjerm-piksler / (cellst\u00f8rrelse * zoom) = antall ruter dratt
  const z = boardState.zoom || 1;
  const dx = Math.round((e.clientX - drag.startX) / (cs * z));
  const dy = Math.round((e.clientY - drag.startY) / (cs * z));
  const card = scenarioBuf.scenario_data.physical_cards.find(c => c.id === drag.cardId);
  if (!card) return;
  const g = scenarioBuf.scenario_data.grid;

  if (drag.mode === 'move') {
    card.grid_x = Math.max(0, Math.min(g.x - card.grid_w, drag.origX + dx));
    card.grid_y = Math.max(0, Math.min(g.y - card.grid_h, drag.origY + dy));
  } else if (drag.mode === 'resize-se') {
    card.grid_w = Math.max(1, Math.min(g.x - card.grid_x, drag.origW + dx));
    card.grid_h = Math.max(1, Math.min(g.y - card.grid_y, drag.origH + dy));
  }
  // Oppdater live-info under drag
  updateLiveInfoFromCard(card);
  // Rerender bare kortet, ikke hele grid (rask oppdatering)
  renderBoard();
}

function onCardMouseUp() {
  boardState.draggingCard = null;
  // Behold liveInfo synlig en kort stund etter slipp så brukeren ser sluttverdiene
  setTimeout(() => {
    boardState.liveInfo = null;
    renderLiveInfo();
  }, 2500);
  document.removeEventListener('mousemove', onCardMouseMove);
  document.removeEventListener('mouseup', onCardMouseUp);
  // Synk koord-listen hvis koord-fanen er åpen
  if (activeScTab === 'coords') {
    renderCoordList();
    if (editingCoordIdx >= 0) renderCoordDetail();
  }
}
/* ════════════════════════════════════════════════════════
   COORDINATES & REWARDS TAB — inline kort-editor
   ──────────────────────────────────────────────────────── */
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
          ◇<br><br>Velg en koordinat fra listen, eller klikk en rute på investigation board-en.
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
    body.innerHTML = '<div class="muted text-center" style="padding:30px 14px;font-style:italic;font-family:var(--font-serif);">Ingen koordinater. Plasser et kort med koord-symbol p\u00e5 board, eller klikk «+ Ny».</div>';
    return;
  }
  body.innerHTML = list.map((c, i) => {
    const cardLink = c.from_card
      ? `<span class="cli-card" style="font-size:10px;color:var(--blue);font-style:italic;">⊕ fra kort</span>`
      : '';
    return `
    <div class="coord-list-item ${i === editingCoordIdx ? 'active' : ''}" onclick="selectCoord(${i})">
      <span class="cli-coord">(${c.x ?? '—'}, ${c.y ?? '—'})</span>
      <span class="cli-code">${escapeHtml(c.code || '—')}</span>
      <span class="cli-meta">${(c.rewards || []).length} ${(c.rewards || []).length === 1 ? 'bel.' : 'bel.'} ${cardLink}</span>
    </div>
  `;
  }).join('');
}

function selectCoord(idx) {
  editingCoordIdx = idx;
  const c = scenarioBuf.scenario_data.coordinates[idx];
  boardState.selectedCoord = c ? { x: c.x, y: c.y } : null;
  renderCoordList();
  renderCoordDetail();
}

function addCoord() {
  scenarioBuf.scenario_data.coordinates.push({
    id: 'coord_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now(),
    x: 0, y: 0, code: '', points: 10,
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

  const fromCard = c.from_card
    ? scenarioBuf.scenario_data.physical_cards.find(card => card.id === c.from_card)
    : null;

  // For auto-genererte koord: X/Y/kode er låst (styres av kort-plassering og header.code)
  const isAuto = !!c.from_card;
  const lockedNote = isAuto
    ? `<div style="background:var(--blue-bg);border-left:3px solid var(--blue);padding:8px 12px;font-size:12px;margin-bottom:14px;color:var(--ink2);line-height:1.4;">
         <strong>Auto-generert fra kort:</strong> ${escapeHtml(fromCard?.name || c.from_card)}<br>
         X, Y og 4-koden styres av kortets plassering p\u00e5 board og header-kode. Bel\u00f8nningene under er per koordinat og kan redigeres her.
       </div>`
    : '';

  const xyDisabled = isAuto ? 'readonly disabled' : '';
  const codeDisabled = isAuto ? 'readonly disabled' : '';

  detail.innerHTML = `
    <div class="flex-between mb-2">
      <h3 style="font-family:var(--font-serif);font-size:18px;">Koordinat (${c.x ?? '—'}, ${c.y ?? '—'})${isAuto ? ' <span style="font-size:11px;color:var(--blue);font-style:italic;">⊕ fra kort</span>' : ''}</h3>
      ${isAuto
        ? `<button class="btn btn-sm btn-ghost" onclick="openTemplateEditor('${c.from_card}')">\u270e Rediger kort</button>`
        : `<button class="btn btn-sm btn-danger" onclick="removeCoord(${editingCoordIdx})">\u2715 Slett koordinat</button>`}
    </div>

    ${lockedNote}

    <div class="field-row-3">
      <div class="field">
        <label class="field-label">X</label>
        <input id="cd-x" type="number" min="0" value="${c.x ?? 0}" ${xyDisabled} oninput="updateCoord('x', this.value, true)">
      </div>
      <div class="field">
        <label class="field-label">Y</label>
        <input id="cd-y" type="number" min="0" value="${c.y ?? 0}" ${xyDisabled} oninput="updateCoord('y', this.value, true)">
      </div>
      <div class="field">
        <label class="field-label">Poeng for koordinat</label>
        <input id="cd-points" type="number" min="0" value="${c.points ?? 10}" oninput="updateCoord('points', this.value, true)">
      </div>
    </div>

    <div class="field">
      <label class="field-label">Verifikasjonskode</label>
      <input id="cd-code" type="text" value="${escapeHtml(c.code || '')}" placeholder="F.eks. NORDLYS" ${codeDisabled}
             oninput="updateCoord('code', this.value)">
      <span class="field-hint">${isAuto ? 'Styres av kortets header-kode (4-tegn).' : 'Koden deltagerne må skrive inn for å låse opp denne koordinaten.'}</span>
    </div>

    <div class="divider"></div>

    <div class="muted" style="font-style:italic;padding:10px 0;font-size:13px;line-height:1.5;">
      Belønninger er nå byttet ut med <strong>blocks</strong>. Du finner block-biblioteket i sidekolonnen på Investigation board.
      En block utløses av kort og/eller koordinater du velger inne i selve blocken.
    </div>
  `;
}

function updateCoord(field, value, isNumber = false) {
  const c = scenarioBuf.scenario_data.coordinates[editingCoordIdx];
  if (!c) return;
  c[field] = isNumber ? (value === '' ? null : Number(value)) : value;
  renderCoordList();
  if (field === 'x' || field === 'y') {
    boardState.selectedCoord = { x: c.x, y: c.y };
  }
}

function removeCoord(idx) {
  if (!confirm('Slette denne koordinaten med alle belønninger?')) return;
  scenarioBuf.scenario_data.coordinates.splice(idx, 1);
  editingCoordIdx = -1;
  boardState.selectedCoord = null;
  renderCoordList();
  renderCoordDetail();
}

/* ════════════════════════════════════════════════════════
   BLOCKS — informasjonspaneler som utløses av kort/koordinater

   En block er et frittstående visuelt panel som dokumenterer
   spillflyten. Den har:
   - en innholds-type (6 valg) som styrer hva som vises i midten
   - header (tittel + farger, INGEN 4-kode)
   - footer (tekst + symboler + farger)
   - en liste over hvilke kort og koordinater som utløser den

   Bor i scenario_data.blocks[]. Eksporteres som PNG til
   /Escape Box/scenarios/{id}/blocks/Block-{navn}.png ved
   scenario-lagring.
   ──────────────────────────────────────────────────────── */

// Item-typer en block kan inneholde. Brukes for dropdown og lookup.
const BLOCK_ITEM_TYPES = {
  mc:          { label: 'Multiple choice',  icon: '◉' },
  text:        { label: 'Text input',       icon: '✎' },
  order:       { label: 'Ordering',         icon: '⇅' },
  unlock:      { label: 'Unlock',           icon: '🔓' },
  new_clues:   { label: 'New clues',        icon: '✦' },
  place_clues: { label: 'Place clues',      icon: '⊞' },
};

// Bevart bakover-kompatibilitet: noen funksjoner ute i koden kan referere
// til BLOCK_TYPES. Vi peker den på samme objekt.
const BLOCK_TYPES = BLOCK_ITEM_TYPES;

function genItemId() {
  return 'item_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now();
}

function defaultItem(type) {
  const base = { id: genItemId(), type };
  switch (type) {
    case 'mc':
      return { ...base, question: '', count: 4, options: ['', '', '', ''], correct_index: 0 };
    case 'text':
      return { ...base, question: '', correct_answer: '' };
    case 'order':
      return { ...base, instruction: '', count: 4, options: ['', '', '', ''] };
    case 'unlock':
      return { ...base, text: '', correct_answer: '' };
    case 'new_clues':
      return { ...base, text: '', correct_answer: '' };
    case 'place_clues':
      return { ...base, text: '', correct_answer: '' };
    default:
      return { ...base, type: 'mc', question: '', count: 4, options: ['', '', '', ''], correct_index: 0 };
  }
}

// Hvor mye relativ plass hver type trenger i PNG-content-området.
// Brukes for å auto-foreslå rows og fordele content-høyde i PNG.
function itemWeight(type) {
  switch (type) {
    case 'mc':         return 2.4;  // spørsmål + 2-4 svaralternativer
    case 'order':      return 2.4;  // instruks + 2-4 alternativer
    case 'text':       return 1.4;  // spørsmål + svar-linje
    case 'unlock':     return 1.2;  // fritekst
    case 'new_clues':  return 1.2;
    case 'place_clues':return 1.2;
    default:           return 1.4;
  }
}

// Beregn minimum antall rader basert på items
function computeMinRows(items) {
  // Header (1) + footer (1) + content. Hver weight-enhet = 1 rad.
  const headerRows = 1;
  const footerRows = 1;
  const totalWeight = items.reduce((sum, it) => sum + itemWeight(it.type), 0);
  // Minimum 1 weight-enhet for content selv om tom
  const contentRows = Math.max(5, Math.ceil(totalWeight * 1.4));
  return headerRows + footerRows + contentRows;
}

// Auto-juster b.rows mot computeMinRows(items). Brukes etter items-endring.
// Vi ØKER bare aldri, slik at brukeren manuelt kan strekke høyden uten at vi
// presser den ned igjen.
function autoAdjustBlockRows(b) {
  if (!b || !Array.isArray(b.items)) return;
  const minRows = computeMinRows(b.items);
  if (b.rows < minRows) b.rows = minRows;
}

// Standardisert form for en block (items-array)
function ensureBlockShape(b) {
  if (!b) return;
  if (!b.id) b.id = genBlockId();
  if (!b.name) b.name = 'Block';
  if (!b.cols) b.cols = 10;
  if (!b.rows) b.rows = 7;
  if (!Array.isArray(b.triggered_by_cards)) b.triggered_by_cards = [];
  if (!Array.isArray(b.triggered_by_coords)) b.triggered_by_coords = [];

  // Header (uten 4-kode for blocks)
  if (!b.header) {
    b.header = {
      title: b.name || 'Block',
      bg_color: '#2a6b3c',
      text_color: '#ffffff',
      rows: 1,
    };
  }
  delete b.header.code;
  delete b.header.code_bg_color;
  delete b.header.code_text_color;

  // Footer
  if (!b.footer) {
    b.footer = {
      text: '',
      bg_color: '#ede8dc',
      text_color: '#1a1610',
      symbols: [],
      rows: 1,
    };
  }
  if (!Array.isArray(b.footer.symbols)) b.footer.symbols = [];

  // Items-array (kjernen i nye modellen)
  if (!Array.isArray(b.items)) b.items = [];
  b.items.forEach(it => {
    if (!it.id) it.id = genItemId();
    if (!it.type) it.type = 'mc';
    // Normaliser count for mc/order
    if (it.type === 'mc' || it.type === 'order') {
      if (![2, 3, 4].includes(it.count)) it.count = 4;
      if (!Array.isArray(it.options)) it.options = ['', '', '', ''];
      while (it.options.length < it.count) it.options.push('');
    }
  });

  // Rydd vekk gamle felter hvis de er igjen
  delete b.content_type;
  delete b.content;
}

function createBlock() {
  const b = {
    id: genBlockId(),
    name: 'Ny block',
    cols: 10, rows: 7,
    items: [defaultItem('mc')],
    triggered_by_cards: [],
    triggered_by_coords: [],
  };
  ensureBlockShape(b);
  scenarioBuf.scenario_data.blocks.push(b);
  renderBlockList();
  openBlockEditor(b.id);
}

function renderBlockList() {
  const el = $('#bb-block-list');
  if (!el) return;
  const blocks = scenarioBuf.scenario_data.blocks || [];
  if (blocks.length === 0) {
    el.innerHTML = '<div class="muted" style="font-style:italic;font-size:11px;padding:6px;">Ingen blocks ennå. Klikk «+ Ny» for å lage en.</div>';
    return;
  }
  el.innerHTML = blocks.map((b) => {
    const cards = b.triggered_by_cards || [];
    const coords = b.triggered_by_coords || [];
    const triggerCount = cards.length + coords.length;
    const itemCount = (b.items || []).length;
    const isActive = blockEditorState.activeBlockId === b.id;
    return `
      <div class="bb-block-row ${isActive ? 'is-active' : ''}" onclick="openBlockEditor('${b.id}')">
        <div class="bb-block-name">${escapeHtml(b.name || 'Uten navn')}</div>
        <div class="bb-block-meta">${itemCount}i · ${triggerCount}t</div>
        <button class="bb-block-del" title="Slett block" onclick="event.stopPropagation();deleteBlock('${b.id}')">✕</button>
      </div>
    `;
  }).join('');
}

function deleteBlock(blockId) {
  const blocks = scenarioBuf.scenario_data.blocks || [];
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return;
  const block = blocks[idx];
  if (!confirm(`Slette blocken «${block.name}»? Dette kan ikke angres.`)) return;

  // Rydd PNG-er fra Dropbox i bakgrunnen (ikke-blokkerende)
  if (block.export_path?.startsWith('/Escape Box/')) {
    deleteImage(block.export_path, block.export_url).catch(e => console.warn('Slett-feil block PNG:', e.message));
  }
  if (block.export_thumb_path?.startsWith('/Escape Box/')) {
    deleteImage(block.export_thumb_path, block.export_thumb_url).catch(e => console.warn('Slett-feil block thumb:', e.message));
  }

  blocks.splice(idx, 1);
  if (blockEditorState.activeBlockId === blockId) {
    blockEditorState.activeBlockId = null;
    blockEditorState.pickMode = false;
    hideTriggerPickPin();
  }
  renderBlockList();
  renderBoard();
}

/* ─── BLOCK EDITOR STATE ───────────────────────────────── */
let blockEditorState = {
  activeBlockId: null,
  pickMode: false,
  expandedItemIds: new Set(),  // hvilke item-kort er utvidet i editoren
};

function openBlockEditor(blockId) {
  const block = scenarioBuf.scenario_data.blocks.find(b => b.id === blockId);
  if (!block) return;
  ensureBlockShape(block);
  blockEditorState.activeBlockId = blockId;
  blockEditorState.pickMode = false;
  blockEditorState.expandedItemIds = new Set();
  // Auto-ekspander første item slik at bruker ser noe med en gang
  if (Array.isArray(block.items) && block.items.length > 0) {
    blockEditorState.expandedItemIds.add(block.items[0].id);
  }

  openModal({
    title: 'Block-editor: ' + (block.name || 'Uten navn'),
    size: 'xl',
    body: renderBlockEditorBody(),
    footer: `
      <button class="btn btn-secondary" onclick="closeBlockEditor()">⤺ Tilbake</button>
      <button class="btn btn-success" onclick="saveBlockOnly()">⤳ Lagre block</button>
    `,
  });
}

function closeBlockEditor() {
  blockEditorState.pickMode = false;
  blockEditorState.activeBlockId = null;
  blockEditorState.expandedItemIds = new Set();
  hideTriggerPickPin();
  closeModal();
  if (state.currentScenarioId) {
    activeScTab = 'board';
    openScenarioEditor(state.currentScenarioId);
  }
}

function currentEditingBlock() {
  const id = blockEditorState.activeBlockId;
  if (!id) return null;
  return scenarioBuf.scenario_data.blocks.find(b => b.id === id);
}

/* ─── EDITOR BODY ──────────────────────────────────────── */
function renderBlockEditorBody() {
  const block = currentEditingBlock();
  if (!block) return '';
  return `
    <div class="block-trigger-panel">
      <div class="block-trigger-header">
        <div>
          <div class="block-trigger-title">Triggers</div>
          <div class="block-trigger-sub">Hvilke kort og koordinater skal utløse denne blocken?</div>
        </div>
        <button class="btn btn-sm btn-amber" onclick="startTriggerPick()">
          + Velg triggere på board
        </button>
      </div>
      <div id="block-trigger-summary">${renderBlockTriggerSummary(block)}</div>
    </div>

    <div class="be-layout">
      <!-- Venstre: redigering -->
      <div class="be-left">
        <div class="be-section">
          <h4>Generelt</h4>
          <div class="field">
            <label class="field-label">Block-navn</label>
            <input type="text" value="${escapeHtml(block.name || '')}"
                   oninput="updateBlockField('name', this.value)">
            <span class="field-hint">Brukes som filnavn ved PNG-eksport: Block-{navn}.png</span>
          </div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">Kolonner</label>
              <input type="number" min="6" max="20" value="${block.cols}"
                     oninput="updateBlockSize('cols', this.value)">
            </div>
            <div class="field">
              <label class="field-label">Rader</label>
              <input type="number" min="4" max="14" value="${block.rows}"
                     oninput="updateBlockSize('rows', this.value)">
            </div>
          </div>
        </div>

        <div class="be-section">
          <h4>Header</h4>
          <div class="field">
            <label class="field-label">Tittel (vises i header)</label>
            <input type="text" value="${escapeHtml(block.header.title || '')}"
                   oninput="updateBlockHeader('title', this.value)">
          </div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">Bakgrunn</label>
              ${renderColorPicker(block.header.bg_color, 'bg_color', 'updateBlockHeader')}
            </div>
            <div class="field">
              <label class="field-label">Tekst</label>
              ${renderColorPicker(block.header.text_color, 'text_color', 'updateBlockHeader')}
            </div>
          </div>
        </div>

        <div class="be-section">
          <h4 style="display:flex;align-items:center;gap:8px;">
            <span>Innhold (${(block.items || []).length} element${(block.items || []).length === 1 ? '' : 'er'})</span>
            <span style="flex:1;"></span>
            <select onchange="addBlockItemOfType(this.value);this.selectedIndex=0;" class="be-add-item-select">
              <option value="">+ Legg til element...</option>
              ${Object.entries(BLOCK_ITEM_TYPES).map(([key, info]) =>
                `<option value="${key}">${info.icon}  ${info.label}</option>`
              ).join('')}
            </select>
          </h4>
          <div id="be-items-list" class="be-items-list">
            ${renderBlockItemsList(block)}
          </div>
          <div class="muted" style="font-size:11px;margin-top:8px;line-height:1.4;">
            Dra elementer for å endre rekkefølge. Block-høyden øker automatisk når du legger til.
          </div>
        </div>

        <div class="be-section">
          <h4>Footer</h4>
          <div class="field">
            <label class="field-label">Tekst (valgfri)</label>
            <input type="text" value="${escapeHtml(block.footer.text || '')}"
                   oninput="updateBlockFooter('text', this.value)">
          </div>
          <div class="field-row">
            <div class="field">
              <label class="field-label">Bakgrunn</label>
              ${renderColorPicker(block.footer.bg_color, 'bg_color', 'updateBlockFooter')}
            </div>
            <div class="field">
              <label class="field-label">Tekst</label>
              ${renderColorPicker(block.footer.text_color, 'text_color', 'updateBlockFooter')}
            </div>
          </div>
        </div>
      </div>

      <!-- Høyre: live preview -->
      <div class="be-right">
        <h4>Forhåndsvisning</h4>
        <div class="be-preview-wrap">
          <div class="be-preview" id="be-preview">${renderBlockPreview(block)}</div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:10px;line-height:1.4;">
          Forhåndsvisningen oppdateres mens du redigerer. PNG-eksport skjer ved
          «Lagre block» og ved scenario-lagring.
        </div>
      </div>
    </div>
  `;
}

/* En enkel fargevelger med 8 paletter + custom */
function renderColorPicker(currentValue, field, updateFn) {
  const palette = [
    '#1a4a7a', '#2a6b3c', '#b83228', '#b86c00',
    '#8b3a2a', '#1a1610', '#ede8dc', '#ffffff',
  ];
  let html = '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">';
  for (const c of palette) {
    const sel = c.toLowerCase() === (currentValue || '').toLowerCase() ? 'border:2px solid var(--ink);' : 'border:1px solid var(--rule);';
    html += `<button type="button" title="${c}" style="width:22px;height:22px;${sel}background:${c};border-radius:3px;cursor:pointer;padding:0;" onclick="${updateFn}('${field}', '${c}')"></button>`;
  }
  html += `<input type="color" value="${currentValue || '#000000'}" oninput="${updateFn}('${field}', this.value)" style="width:34px;height:24px;padding:1px;cursor:pointer;">`;
  html += '</div>';
  return html;
}

function renderBlockItemsList(block) {
  const items = block.items || [];
  if (items.length === 0) {
    return '<div class="muted" style="font-style:italic;padding:14px;text-align:center;font-size:13px;">Ingen elementer ennå. Bruk dropdown over for å legge til.</div>';
  }
  return items.map((it, idx) => renderBlockItemCard(it, idx, items.length)).join('');
}

function renderBlockItemCard(item, idx, total) {
  const info = BLOCK_ITEM_TYPES[item.type] || { label: '?', icon: '?' };
  // Items er kollapserbare for å spare plass når man har mange.
  const isExpanded = blockEditorState.expandedItemIds.has(item.id);
  return `
    <div class="be-item-card" data-item-id="${item.id}" draggable="true"
         ondragstart="onItemDragStart(event, '${item.id}')"
         ondragover="onItemDragOver(event, '${item.id}')"
         ondragleave="onItemDragLeave(event)"
         ondrop="onItemDrop(event, '${item.id}')"
         ondragend="onItemDragEnd(event)">
      <div class="be-item-head" onclick="toggleItemExpanded('${item.id}')">
        <span class="be-item-drag" title="Dra for å endre rekkefølge">⋮⋮</span>
        <span class="be-item-num">${idx + 1}</span>
        <span class="be-item-type-icon">${info.icon}</span>
        <select class="be-item-type-select" onclick="event.stopPropagation();" onchange="changeItemType('${item.id}', this.value)">
          ${Object.entries(BLOCK_ITEM_TYPES).map(([key, i]) =>
            `<option value="${key}" ${item.type === key ? 'selected' : ''}>${i.icon}  ${i.label}</option>`
          ).join('')}
        </select>
        <span class="be-item-summary">${renderItemSummary(item)}</span>
        <button class="be-item-up" title="Flytt opp" onclick="event.stopPropagation();moveItem('${item.id}', -1)" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="be-item-down" title="Flytt ned" onclick="event.stopPropagation();moveItem('${item.id}', 1)" ${idx === total - 1 ? 'disabled' : ''}>▼</button>
        <button class="be-item-del" title="Slett element" onclick="event.stopPropagation();removeBlockItem('${item.id}')">✕</button>
        <span class="be-item-chevron">${isExpanded ? '▾' : '▸'}</span>
      </div>
      ${isExpanded ? `<div class="be-item-body">${renderItemEditor(item)}</div>` : ''}
    </div>
  `;
}

// Kort sammendrag som vises på sammenfoldet kort
function renderItemSummary(item) {
  const text = item.question || item.instruction || item.text || '';
  if (!text) return '<em class="muted" style="font-size:11px;">(tomt)</em>';
  const short = text.length > 60 ? text.slice(0, 57) + '...' : text;
  return `<span class="be-item-summary-text">${escapeHtml(short)}</span>`;
}

function renderItemEditor(item) {
  if (item.type === 'mc')          return renderItemEditorMC(item);
  if (item.type === 'text')        return renderItemEditorText(item);
  if (item.type === 'order')       return renderItemEditorOrder(item);
  if (item.type === 'unlock')      return renderItemEditorFreeText(item, 'Beskrivelse av boks/lås', 'Tekst som forteller deltagerne hva som skal låses opp');
  if (item.type === 'new_clues')   return renderItemEditorFreeText(item, 'Hvilke kort skal åpnes', 'Beskriv hvilke ledetråder/kort spillerne nå får tilgang til');
  if (item.type === 'place_clues') return renderItemEditorFreeText(item, 'Instruks om plassering', 'Beskriv hva som skal plasseres hvor');
  return '<div class="muted">Ukjent type</div>';
}

function renderItemEditorMC(item) {
  if (!Array.isArray(item.options)) item.options = ['', '', '', ''];
  while (item.options.length < (item.count || 4)) item.options.push('');
  const count = item.count || 4;
  return `
    <div class="field">
      <label class="field-label">Spørsmål</label>
      <textarea rows="2" oninput="updateItemField('${item.id}', 'question', this.value)">${escapeHtml(item.question || '')}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Antall svaralternativer</label>
      <div class="be-count-switch">
        ${[2, 3, 4].map(n => `
          <button type="button" class="be-count-btn ${count === n ? 'active' : ''}" onclick="updateItemCount('${item.id}', ${n})">${n}</button>
        `).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">Svaralternativer (velg riktig)</label>
      ${[0, 1, 2, 3].slice(0, count).map(i => `
        <div class="be-option-row ${item.correct_index === i ? 'is-correct' : ''}">
          <button type="button" class="be-option-letter" onclick="updateItemField('${item.id}', 'correct_index', ${i})" title="Sett som riktig svar">${'ABCD'[i]}</button>
          <input type="text" value="${escapeHtml(item.options[i] || '')}" placeholder="Svaralternativ ${'ABCD'[i]}"
                 oninput="updateItemOption('${item.id}', ${i}, this.value)">
          ${item.correct_index === i
            ? '<span class="be-option-check">✓ Riktig</span>'
            : `<button type="button" class="btn btn-sm btn-ghost" onclick="updateItemField('${item.id}', 'correct_index', ${i})">Sett riktig</button>`}
        </div>
      `).join('')}
    </div>
  `;
}

function renderItemEditorText(item) {
  return `
    <div class="field">
      <label class="field-label">Spørsmål</label>
      <textarea rows="2" oninput="updateItemField('${item.id}', 'question', this.value)">${escapeHtml(item.question || '')}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Fasit-svar</label>
      <input type="text" value="${escapeHtml(item.correct_answer || '')}" placeholder="Det riktige svaret"
             oninput="updateItemField('${item.id}', 'correct_answer', this.value)">
      <span class="field-hint">Brukes for validering senere. Case-insensitive sammenligning.</span>
    </div>
  `;
}

function renderItemEditorOrder(item) {
  if (!Array.isArray(item.options)) item.options = ['', '', '', ''];
  while (item.options.length < (item.count || 4)) item.options.push('');
  const count = item.count || 4;
  return `
    <div class="field">
      <label class="field-label">Instruks</label>
      <textarea rows="2" oninput="updateItemField('${item.id}', 'instruction', this.value)">${escapeHtml(item.instruction || '')}</textarea>
      <span class="field-hint">F.eks. «Sett hendelsene i riktig kronologisk rekkefølge»</span>
    </div>
    <div class="field">
      <label class="field-label">Antall alternativer</label>
      <div class="be-count-switch">
        ${[2, 3, 4].map(n => `
          <button type="button" class="be-count-btn ${count === n ? 'active' : ''}" onclick="updateItemCount('${item.id}', ${n})">${n}</button>
        `).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">Alternativer (skriv i RIKTIG rekkefølge — stokkes for spilleren senere)</label>
      ${[0, 1, 2, 3].slice(0, count).map(i => `
        <div class="be-option-row">
          <span class="be-option-letter">${i + 1}</span>
          <input type="text" value="${escapeHtml(item.options[i] || '')}" placeholder="Steg ${i + 1}"
                 oninput="updateItemOption('${item.id}', ${i}, this.value)">
        </div>
      `).join('')}
    </div>
  `;
}

function renderItemEditorFreeText(item, label, hint) {
  return `
    <div class="field">
      <label class="field-label">${escapeHtml(label)}</label>
      <textarea rows="4" oninput="updateItemField('${item.id}', 'text', this.value)">${escapeHtml(item.text || '')}</textarea>
      <span class="field-hint">${escapeHtml(hint)}</span>
    </div>
    <div class="field">
      <label class="field-label">Fasit-svar (valgfritt)</label>
      <input type="text" value="${escapeHtml(item.correct_answer || '')}" placeholder="Valgfritt — for senere validering"
             oninput="updateItemField('${item.id}', 'correct_answer', this.value)">
    </div>
  `;
}

/* ─── ITEMS-OPERASJONER ──────────────────────────────── */
function addBlockItemOfType(type) {
  if (!type || !BLOCK_ITEM_TYPES[type]) return;
  const b = currentEditingBlock();
  if (!b) return;
  if (!Array.isArray(b.items)) b.items = [];
  const newItem = defaultItem(type);
  b.items.push(newItem);
  // Auto-ekspander nytt item slik at brukeren ser det med en gang
  blockEditorState.expandedItemIds.add(newItem.id);
  autoAdjustBlockRows(b);
  refreshBlockEditor();
  renderBlockList();
}

function removeBlockItem(itemId) {
  const b = currentEditingBlock();
  if (!b || !Array.isArray(b.items)) return;
  const idx = b.items.findIndex(it => it.id === itemId);
  if (idx < 0) return;
  if (!confirm('Slette dette elementet?')) return;
  b.items.splice(idx, 1);
  blockEditorState.expandedItemIds.delete(itemId);
  refreshBlockEditor();
  renderBlockList();
}

function moveItem(itemId, delta) {
  const b = currentEditingBlock();
  if (!b || !Array.isArray(b.items)) return;
  const idx = b.items.findIndex(it => it.id === itemId);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= b.items.length) return;
  const [item] = b.items.splice(idx, 1);
  b.items.splice(newIdx, 0, item);
  refreshItemsList();
}

function toggleItemExpanded(itemId) {
  if (blockEditorState.expandedItemIds.has(itemId)) {
    blockEditorState.expandedItemIds.delete(itemId);
  } else {
    blockEditorState.expandedItemIds.add(itemId);
  }
  refreshItemsList();
}

function changeItemType(itemId, newType) {
  if (!BLOCK_ITEM_TYPES[newType]) return;
  const b = currentEditingBlock();
  if (!b || !Array.isArray(b.items)) return;
  const idx = b.items.findIndex(it => it.id === itemId);
  if (idx < 0) return;
  const old = b.items[idx];
  const newItem = defaultItem(newType);
  newItem.id = old.id;  // behold id slik at expandedItemIds fortsatt peker rett
  // Forsøk å bevare tekst
  const oldText = old.question || old.instruction || old.text || '';
  if ('text' in newItem) newItem.text = oldText;
  else if ('question' in newItem) newItem.question = oldText;
  else if ('instruction' in newItem) newItem.instruction = oldText;
  b.items[idx] = newItem;
  autoAdjustBlockRows(b);
  refreshBlockEditor();
}

function updateItemField(itemId, field, value) {
  const b = currentEditingBlock();
  if (!b) return;
  const it = (b.items || []).find(x => x.id === itemId);
  if (!it) return;
  it[field] = value;
  // correct_index krever full re-render (radio-tilstand)
  if (field === 'correct_index') refreshItemsList();
  else refreshBlockPreview();
}

function updateItemOption(itemId, optIdx, value) {
  const b = currentEditingBlock();
  if (!b) return;
  const it = (b.items || []).find(x => x.id === itemId);
  if (!it) return;
  if (!Array.isArray(it.options)) it.options = ['', '', '', ''];
  it.options[optIdx] = value;
  refreshBlockPreview();
}

function updateItemCount(itemId, n) {
  const b = currentEditingBlock();
  if (!b) return;
  const it = (b.items || []).find(x => x.id === itemId);
  if (!it) return;
  it.count = n;
  if (!Array.isArray(it.options)) it.options = ['', '', '', ''];
  while (it.options.length < n) it.options.push('');
  if (it.correct_index !== undefined && it.correct_index >= n) it.correct_index = 0;
  refreshItemsList();
}

// Re-render kun items-listen (bevarer fokus i andre felter i editor)
function refreshItemsList() {
  const b = currentEditingBlock();
  const el = $('#be-items-list');
  if (el && b) el.innerHTML = renderBlockItemsList(b);
  refreshBlockPreview();
  renderBlockList();
}

/* ─── DRAG-AND-DROP for items ────────────────────────── */
let itemDragState = { draggedId: null };

function onItemDragStart(e, itemId) {
  itemDragState.draggedId = itemId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', itemId);
  e.currentTarget.classList.add('is-dragging');
}

function onItemDragOver(e, itemId) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (itemDragState.draggedId && itemDragState.draggedId !== itemId) {
    e.currentTarget.classList.add('drag-over');
  }
}

function onItemDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

function onItemDrop(e, targetId) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const draggedId = itemDragState.draggedId;
  if (!draggedId || draggedId === targetId) return;
  const b = currentEditingBlock();
  if (!b || !Array.isArray(b.items)) return;
  const fromIdx = b.items.findIndex(it => it.id === draggedId);
  const toIdx = b.items.findIndex(it => it.id === targetId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = b.items.splice(fromIdx, 1);
  b.items.splice(toIdx, 0, moved);
  refreshItemsList();
}

function onItemDragEnd(e) {
  e.currentTarget.classList.remove('is-dragging');
  document.querySelectorAll('.be-item-card.drag-over').forEach(el => el.classList.remove('drag-over'));
  itemDragState.draggedId = null;
}


function refreshBlockEditor() {
  const body = $('#modal-body');
  if (body) body.innerHTML = renderBlockEditorBody();
}

function refreshBlockPreview() {
  const b = currentEditingBlock();
  const el = $('#be-preview');
  if (el && b) el.innerHTML = renderBlockPreview(b);
}

/* ─── PREVIEW (HTML for live editor-visning) ──────────── */
function renderBlockPreview(block) {
  // Forhåndsvisningen viser SAMME HTML som PNG-renderingen,
  // bare i mindre skala. Vi bruker en grov skalering basert på
  // antall ruter — 50 px per rute er passe for editor-preview.
  const cellPx = 50;
  const W = block.cols * cellPx;
  const H = block.rows * cellPx;
  const headerRows = block.header.rows || 1;
  const footerRows = block.footer.rows || 1;
  const headerH = headerRows * cellPx;
  const footerH = footerRows * cellPx;
  const contentH = H - headerH - footerH;

  let html = `<div class="be-preview-card" style="width:${W}px;height:${H}px;background:#fff;">`;

  // Header
  html += `<div class="be-prev-header" style="height:${headerH}px;background:${block.header.bg_color};color:${block.header.text_color};">
    <span class="be-prev-header-title">${escapeHtml(block.header.title || '')}</span>
  </div>`;

  // Content
  html += `<div class="be-prev-content" style="height:${contentH}px;background:#faf8f3;">`;
  html += renderBlockContentPreview(block);
  html += `</div>`;

  // Footer
  html += `<div class="be-prev-footer" style="height:${footerH}px;background:${block.footer.bg_color};color:${block.footer.text_color};">
    <span class="be-prev-footer-text">${escapeHtml(block.footer.text || '')}</span>
  </div>`;

  html += `</div>`;
  return html;
}

function renderBlockContentPreview(block) {
  const items = block.items || [];
  if (items.length === 0) {
    return '<div class="muted" style="font-style:italic;text-align:center;padding:30px 0;">Ingen innhold ennå.</div>';
  }
  return items.map(it => renderItemPreview(it)).join('<hr class="be-prev-sep">');
}

function renderItemPreview(item) {
  const t = item.type;
  if (t === 'mc') {
    const count = item.count || 4;
    let html = `<div class="be-prev-item"><div class="be-prev-question">${escapeHtml(item.question || '(spørsmål)')}</div>`;
    html += '<div class="be-prev-options">';
    for (let i = 0; i < count; i++) {
      const isCorrect = item.correct_index === i;
      html += `<div class="be-prev-option ${isCorrect ? 'is-correct' : ''}">
        <span class="be-prev-option-letter">${'ABCD'[i]}</span>
        <span>${escapeHtml(item.options?.[i] || `(alternativ ${'ABCD'[i]})`)}</span>
        ${isCorrect ? '<span class="be-prev-check">✓</span>' : ''}
      </div>`;
    }
    html += '</div></div>';
    return html;
  }
  if (t === 'text') {
    return `<div class="be-prev-item">
      <div class="be-prev-question">${escapeHtml(item.question || '(spørsmål)')}</div>
      <div class="be-prev-input-line">Svar: ____________________________</div>
      ${item.correct_answer ? `<div class="be-prev-fasit">Fasit: ${escapeHtml(item.correct_answer)}</div>` : ''}
    </div>`;
  }
  if (t === 'order') {
    const count = item.count || 4;
    let html = `<div class="be-prev-item"><div class="be-prev-question">${escapeHtml(item.instruction || '(instruks)')}</div>`;
    html += '<div class="be-prev-options">';
    for (let i = 0; i < count; i++) {
      html += `<div class="be-prev-option">
        <span class="be-prev-option-letter">${i + 1}</span>
        <span>${escapeHtml(item.options?.[i] || `(steg ${i + 1})`)}</span>
      </div>`;
    }
    html += '</div></div>';
    return html;
  }
  // Unlock / new_clues / place_clues
  return `<div class="be-prev-item">
    <div class="be-prev-text">${escapeHtml(item.text || `(${BLOCK_ITEM_TYPES[t]?.label || 'innhold'})`)}</div>
    ${item.correct_answer ? `<div class="be-prev-fasit">Fasit: ${escapeHtml(item.correct_answer)}</div>` : ''}
  </div>`;
}

/* ─── TRIGGER PICK (uendret fra forrige iter) ──────────── */
async function startTriggerPick() {
  if (!blockEditorState.activeBlockId) return;
  if (!state.currentScenarioId) return;

  try {
    const block = currentEditingBlock();
    if (block) {
      showToast('Lagrer block...', 'info', 1500);
      try { await exportBlockPng(block); } catch (e) { console.warn('Block PNG-eksport feilet:', e.message); }
      await api(`/api/scenarios/${state.currentScenarioId}`, {
        method: 'PATCH',
        body: { scenario_data: scenarioBuf.scenario_data },
      });
    }
  } catch (e) {
    showToast('Kunne ikke lagre block før pick-modus: ' + e.message, 'error');
    return;
  }

  blockEditorState.pickMode = true;
  closeModal();

  await openScenarioEditor(state.currentScenarioId);
  activeScTab = 'board';
  setTimeout(() => {
    if (typeof switchScTab === 'function') switchScTab('board');
    showTriggerPickPin();
  }, 50);
}

function endTriggerPick() {
  blockEditorState.pickMode = false;
  hideTriggerPickPin();
  renderBoard();
}

function reopenActiveBlockEditor() {
  const id = blockEditorState.activeBlockId;
  if (!id) {
    hideTriggerPickPin();
    return;
  }
  hideTriggerPickPin();
  openBlockEditor(id);
}

function showTriggerPickPin() {
  let pin = $('#block-pick-pin');
  if (!pin) {
    pin = document.createElement('div');
    pin.id = 'block-pick-pin';
    pin.className = 'block-pick-pin';
    document.body.appendChild(pin);
  }
  const block = currentEditingBlock();
  const blockName = block ? (block.name || 'Block') : 'Block';
  const count = block ? (block.triggered_by_cards.length + block.triggered_by_coords.length) : 0;
  pin.innerHTML = `
    <span class="bp-pin-dot"></span>
    <div style="display:flex;flex-direction:column;line-height:1.2;">
      <span class="bp-pin-text">Velger triggere for «${escapeHtml(blockName)}»</span>
      <span style="font-size:10px;opacity:0.7;text-transform:none;letter-spacing:0;">Klikk på kort eller koord-celler. ${count} valgt.</span>
    </div>
    <button class="btn btn-sm btn-secondary" onclick="reopenActiveBlockEditor()">↩ Tilbake til editor</button>
    <button class="btn btn-sm" onclick="endTriggerPick()">✓ Ferdig</button>
  `;
  pin.style.display = '';
}

function hideTriggerPickPin() {
  const pin = $('#block-pick-pin');
  if (pin) pin.style.display = 'none';
}

function renderBlockTriggerSummary(block) {
  if (!block) return '';
  const cards = scenarioBuf.scenario_data.physical_cards || [];
  const coords = scenarioBuf.scenario_data.coordinates || [];

  const cardItems = (block.triggered_by_cards || []).map(cardId => {
    const card = cards.find(c => c.id === cardId);
    if (!card) {
      return `<span class="bt-chip bt-chip-missing">⃞ Mangler kort
                <button class="bt-chip-x" onclick="removeBlockTriggerCard('${cardId}')">✕</button>
              </span>`;
    }
    const where = card.in_stash ? 'bunke' : `grid (${card.grid_x},${card.grid_y})`;
    return `<span class="bt-chip bt-chip-card">
              ⃞ ${escapeHtml(card.name || 'Uten navn')}
              <span class="bt-chip-meta">${where}${card.header?.code ? ' · ' + escapeHtml(card.header.code) : ''}</span>
              <button class="bt-chip-x" onclick="removeBlockTriggerCard('${cardId}')" title="Fjern trigger">✕</button>
            </span>`;
  });

  const coordItems = (block.triggered_by_coords || []).map(coordId => {
    const coord = coords.find(c => c.id === coordId);
    if (!coord) {
      return `<span class="bt-chip bt-chip-missing">⊕ Mangler koord
                <button class="bt-chip-x" onclick="removeBlockTriggerCoord('${coordId}')">✕</button>
              </span>`;
    }
    return `<span class="bt-chip bt-chip-coord">
              ⊕ (${coord.x},${coord.y})
              <span class="bt-chip-meta">${coord.code ? escapeHtml(coord.code) : '(ingen kode)'}</span>
              <button class="bt-chip-x" onclick="removeBlockTriggerCoord('${coordId}')" title="Fjern trigger">✕</button>
            </span>`;
  });

  const all = [...cardItems, ...coordItems];
  if (all.length === 0) {
    return '<div class="muted" style="font-style:italic;padding:6px 0;font-size:12px;">Ingen triggere ennå. Klikk «Velg triggere på board» og deretter på kort eller koord-celler.</div>';
  }
  return `<div class="bt-chip-list">${all.join('')}</div>`;
}

function removeBlockTriggerCard(cardId) {
  const block = currentEditingBlock();
  if (!block) return;
  block.triggered_by_cards = (block.triggered_by_cards || []).filter(id => id !== cardId);
  refreshBlockTriggerSummary();
  renderBoard();
  renderBlockList();
}

function removeBlockTriggerCoord(coordId) {
  const block = currentEditingBlock();
  if (!block) return;
  block.triggered_by_coords = (block.triggered_by_coords || []).filter(id => id !== coordId);
  refreshBlockTriggerSummary();
  renderBoard();
  renderBlockList();
}

function refreshBlockTriggerSummary() {
  const block = currentEditingBlock();
  const el = $('#block-trigger-summary');
  if (el && block) el.innerHTML = renderBlockTriggerSummary(block);
}

function toggleBlockTriggerForCard(cardId) {
  const block = currentEditingBlock();
  if (!block || !blockEditorState.pickMode) return false;
  block.triggered_by_cards = block.triggered_by_cards || [];
  const idx = block.triggered_by_cards.indexOf(cardId);
  if (idx >= 0) block.triggered_by_cards.splice(idx, 1);
  else block.triggered_by_cards.push(cardId);
  refreshBlockTriggerSummary();
  renderBoard();
  renderBlockList();
  if ($('#block-pick-pin')?.style.display !== 'none') showTriggerPickPin();
  return true;
}

function toggleBlockTriggerForCoord(coordId) {
  const block = currentEditingBlock();
  if (!block || !blockEditorState.pickMode) return false;
  block.triggered_by_coords = block.triggered_by_coords || [];
  const idx = block.triggered_by_coords.indexOf(coordId);
  if (idx >= 0) block.triggered_by_coords.splice(idx, 1);
  else block.triggered_by_coords.push(coordId);
  refreshBlockTriggerSummary();
  renderBoard();
  renderBlockList();
  if ($('#block-pick-pin')?.style.display !== 'none') showTriggerPickPin();
  return true;
}

function coordIdAtCell(x, y) {
  const coords = scenarioBuf.scenario_data.coordinates || [];
  const c = coords.find(c => c.x === x && c.y === y);
  return c ? c.id : null;
}

/* ─── LAGRING ──────────────────────────────────────────── */
async function saveBlockOnly() {
  if (!state.currentScenarioId) {
    showToast('Ingen scenario åpen', 'error');
    return;
  }
  const block = currentEditingBlock();
  if (!block) return;
  try {
    showToast('Lagrer block og genererer PNG...', 'info');
    await exportBlockPng(block);
    await api(`/api/scenarios/${state.currentScenarioId}`, {
      method: 'PATCH',
      body: { scenario_data: scenarioBuf.scenario_data },
    });
    showToast('Block lagret', 'success');
    closeBlockEditor();
  } catch (e) {
    showToast('Lagring feilet: ' + e.message, 'error');
  }
}

/* ─── PNG-EKSPORT ──────────────────────────────────────── */
const BLOCK_EXPORT_PX_PER_CELL = 120;
const BLOCK_THUMB_PX_PER_CELL = 30;

/* Bygger ren SVG for en block som kan konverteres til PNG.
   Layout speiler renderBlockPreview, men i SVG-form og høyere
   oppløsning.
*/
function renderBlockForExport(block) {
  ensureBlockShape(block);
  const cell = BLOCK_EXPORT_PX_PER_CELL;
  const W = block.cols * cell;
  const H = block.rows * cell;
  const headerRows = block.header.rows || 1;
  const footerRows = block.footer.rows || 1;
  const headerH = headerRows * cell;
  const footerH = footerRows * cell;
  const contentY = headerH;
  const contentH = H - headerH - footerH;
  const footerY = H - footerH;

  // ASCII-safe escape for SVG-tekst
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#fff"/>`;

  // ─── Header ──────────────────────────────────────────
  svg += `<rect x="0" y="0" width="${W}" height="${headerH}" fill="${block.header.bg_color}"/>`;
  const titleFz = Math.min(headerH * 0.55, 48);
  svg += `<text x="${W / 2}" y="${headerH / 2}" text-anchor="middle" dominant-baseline="middle"
            font-family="Libre Baskerville, Georgia, serif" font-size="${titleFz}" font-weight="700"
            fill="${block.header.text_color}">${esc(block.header.title || '')}</text>`;

  // ─── Content ─────────────────────────────────────────
  svg += `<rect x="0" y="${contentY}" width="${W}" height="${contentH}" fill="#faf8f3"/>`;
  svg += renderBlockContentSVG(block, 0, contentY, W, contentH, esc);

  // ─── Footer ──────────────────────────────────────────
  svg += `<rect x="0" y="${footerY}" width="${W}" height="${footerH}" fill="${block.footer.bg_color}"/>`;
  if (block.footer.text) {
    const footerFz = Math.min(footerH * 0.45, 32);
    svg += `<text x="${W * 0.04}" y="${footerY + footerH / 2}" dominant-baseline="middle"
              font-family="Barlow Condensed, sans-serif" font-size="${footerFz}"
              fill="${block.footer.text_color}">${esc(block.footer.text)}</text>`;
  }

  svg += `</svg>`;
  return svg;
}

function renderBlockContentSVG(block, x, y, w, h, esc) {
  const items = block.items || [];
  if (items.length === 0) return '';

  // Fordel høyden mellom items basert på weight
  const totalWeight = items.reduce((sum, it) => sum + itemWeight(it.type), 0) || 1;
  const sepH = items.length > 1 ? 8 : 0;  // separator-høyde mellom items
  const availH = h - sepH * (items.length - 1);

  let s = '';
  let cursorY = y;
  items.forEach((item, idx) => {
    const itemH = availH * (itemWeight(item.type) / totalWeight);
    s += renderItemSVG(item, x, cursorY, w, itemH, esc);
    cursorY += itemH;
    // Separator
    if (idx < items.length - 1) {
      const sepY = cursorY + sepH / 2;
      s += `<line x1="${x + w * 0.06}" y1="${sepY}" x2="${x + w * 0.94}" y2="${sepY}"
              stroke="#c8bfaa" stroke-width="1" stroke-dasharray="4 4"/>`;
      cursorY += sepH;
    }
  });
  return s;
}

function renderItemSVG(item, x, y, w, h, esc) {
  const t = item.type;
  const pad = w * 0.04;
  const cx = x + pad;
  const cw = w - 2 * pad;
  let s = '';

  if (t === 'mc') {
    const count = item.count || 4;
    const qFz = Math.min(h * 0.16, 38);
    const optFz = Math.min(h * 0.12, 28);
    const qY = y + h * 0.10;
    s += `<text x="${cx}" y="${qY}" font-family="Libre Baskerville, Georgia, serif" font-size="${qFz}"
            font-weight="700" fill="#1a1610">${wrapSvgText(item.question || '(spørsmål)', cw, qFz, esc, cx)}</text>`;
    const optStartY = y + h * 0.32;
    const rowH = (h * 0.62) / count;
    for (let i = 0; i < count; i++) {
      const isCorrect = item.correct_index === i;
      const rowY = optStartY + i * rowH;
      const bgFill = isCorrect ? '#2a6b3c' : '#ede8dc';
      const fg = isCorrect ? '#ffffff' : '#1a1610';
      s += `<rect x="${cx}" y="${rowY}" width="${cw}" height="${rowH * 0.85}" rx="3" fill="${bgFill}"/>`;
      s += `<circle cx="${cx + rowH * 0.5}" cy="${rowY + rowH * 0.425}" r="${rowH * 0.32}" fill="#fff" stroke="${fg}" stroke-width="2"/>`;
      s += `<text x="${cx + rowH * 0.5}" y="${rowY + rowH * 0.425}" text-anchor="middle" dominant-baseline="middle"
              font-family="Barlow Condensed" font-size="${optFz}" font-weight="700" fill="${fg}">${'ABCD'[i]}</text>`;
      s += `<text x="${cx + rowH * 1.15}" y="${rowY + rowH * 0.425}" dominant-baseline="middle"
              font-family="Barlow Condensed" font-size="${optFz}" fill="${fg}">${esc(item.options?.[i] || '')}</text>`;
      if (isCorrect) {
        s += `<text x="${cx + cw - rowH * 0.5}" y="${rowY + rowH * 0.425}" text-anchor="middle" dominant-baseline="middle"
                font-family="Barlow Condensed" font-size="${optFz * 1.2}" font-weight="700" fill="#fff">✓</text>`;
      }
    }
    return s;
  }

  if (t === 'text') {
    const qFz = Math.min(h * 0.20, 36);
    const inputFz = Math.min(h * 0.16, 28);
    const fasitFz = Math.min(h * 0.12, 20);
    const qY = y + h * 0.18;
    s += `<text x="${cx}" y="${qY}" font-family="Libre Baskerville, Georgia, serif" font-size="${qFz}"
            font-weight="700" fill="#1a1610">${wrapSvgText(item.question || '(spørsmål)', cw, qFz, esc, cx)}</text>`;
    const lineY = y + h * 0.62;
    s += `<text x="${cx}" y="${lineY}" font-family="Barlow Condensed" font-size="${inputFz}" fill="#6b6050">Svar:</text>`;
    s += `<line x1="${cx + inputFz * 2.5}" y1="${lineY + 4}" x2="${cx + cw - 10}" y2="${lineY + 4}"
            stroke="#3d3628" stroke-width="2"/>`;
    if (item.correct_answer) {
      const fY = y + h * 0.92;
      s += `<text x="${cx}" y="${fY}" font-family="Barlow Condensed" font-size="${fasitFz}"
              font-style="italic" fill="#2a6b3c">Fasit: ${esc(item.correct_answer)}</text>`;
    }
    return s;
  }

  if (t === 'order') {
    const count = item.count || 4;
    const qFz = Math.min(h * 0.15, 34);
    const optFz = Math.min(h * 0.12, 26);
    const qY = y + h * 0.10;
    s += `<text x="${cx}" y="${qY}" font-family="Libre Baskerville, Georgia, serif" font-size="${qFz}"
            font-weight="700" fill="#1a1610">${wrapSvgText(item.instruction || '(instruks)', cw, qFz, esc, cx)}</text>`;
    const optStartY = y + h * 0.32;
    const rowH = (h * 0.62) / count;
    for (let i = 0; i < count; i++) {
      const rowY = optStartY + i * rowH;
      s += `<rect x="${cx}" y="${rowY}" width="${cw}" height="${rowH * 0.85}" rx="3" fill="#ede8dc"/>`;
      s += `<circle cx="${cx + rowH * 0.5}" cy="${rowY + rowH * 0.425}" r="${rowH * 0.32}" fill="#c8961a"/>`;
      s += `<text x="${cx + rowH * 0.5}" y="${rowY + rowH * 0.425}" text-anchor="middle" dominant-baseline="middle"
              font-family="Barlow Condensed" font-size="${optFz}" font-weight="700" fill="#fff">${i + 1}</text>`;
      s += `<text x="${cx + rowH * 1.15}" y="${rowY + rowH * 0.425}" dominant-baseline="middle"
              font-family="Barlow Condensed" font-size="${optFz}" fill="#1a1610">${esc(item.options?.[i] || '')}</text>`;
    }
    return s;
  }

  // Unlock / new_clues / place_clues
  const tFz = Math.min(h * 0.18, 30);
  const fasitFz = Math.min(h * 0.12, 20);
  const topY = y + h * 0.25;
  const lines = wrapTextLines(item.text || `(${BLOCK_ITEM_TYPES[t]?.label || 'innhold'})`, Math.floor(cw / (tFz * 0.5)));
  lines.slice(0, 4).forEach((line, i) => {
    s += `<text x="${cx}" y="${topY + i * tFz * 1.3}" font-family="Libre Baskerville, Georgia, serif"
            font-size="${tFz}" fill="#1a1610">${esc(line)}</text>`;
  });
  if (item.correct_answer) {
    s += `<text x="${cx}" y="${y + h - h * 0.08}" font-family="Barlow Condensed" font-size="${fasitFz}"
            font-style="italic" fill="#2a6b3c">Fasit: ${esc(item.correct_answer)}</text>`;
  }
  return s;
}

// Veldig enkel tekst-wrapping for SVG (return en flat <tspan>-streng).
// Trenger x-koordinat fordi tspan starter på 0 ellers, ikke der text er.
function wrapSvgText(text, maxW, fontSize, esc, anchorX = 0) {
  const charW = fontSize * 0.5;
  const maxChars = Math.floor(maxW / charW);
  const lines = wrapTextLines(text, maxChars);
  return lines.map((l, i) =>
    `<tspan x="${anchorX}" dy="${i === 0 ? 0 : fontSize * 1.2}">${esc(l)}</tspan>`
  ).join('');
}

function wrapTextLines(text, maxChars) {
  if (!text) return [''];
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

async function exportBlockPng(block) {
  if (!block || !state.currentScenarioId) return null;
  try {
    ensureBlockShape(block);
    const W = block.cols * BLOCK_EXPORT_PX_PER_CELL;
    const H = block.rows * BLOCK_EXPORT_PX_PER_CELL;
    const tW = block.cols * BLOCK_THUMB_PX_PER_CELL;
    const tH = block.rows * BLOCK_THUMB_PX_PER_CELL;
    const svg = renderBlockForExport(block);
    const [fullBlob, thumbBlob] = await Promise.all([
      svgToPngBlob(svg, W, H, '#ffffff'),
      svgToPngBlob(svg, tW, tH, '#ffffff'),
    ]);
    const safeName = sanitizeFilename(block.name || 'uten-navn');
    const filename = `Block-${safeName}.png`;
    const thumbFilename = `thumb-${filename}`;

    const oldPath = block.export_path;
    const oldThumbPath = block.export_thumb_path;
    const oldFilename = oldPath ? oldPath.split('/').pop() : null;
    const filenameChanged = oldFilename && oldFilename !== filename;

    const [fullResult, thumbResult] = await Promise.all([
      uploadPngBlob(fullBlob, {
        scenario_id: state.currentScenarioId,
        kind: 'blocks',
        filename,
        overwrite: true,
      }),
      uploadPngBlob(thumbBlob, {
        scenario_id: state.currentScenarioId,
        kind: 'blocks',
        filename: thumbFilename,
        overwrite: true,
      }),
    ]);

    if (fullResult?.url) {
      block.export_url = fullResult.url;
      block.export_path = fullResult.path;
    }
    if (thumbResult?.url) {
      block.export_thumb_url = thumbResult.url;
      block.export_thumb_path = thumbResult.path;
    }

    if (filenameChanged) {
      if (oldPath?.startsWith('/Escape Box/')) {
        deleteImage(oldPath).catch(e => console.warn('Slett-feil full block:', e.message));
      }
      if (oldThumbPath?.startsWith('/Escape Box/')) {
        deleteImage(oldThumbPath).catch(e => console.warn('Slett-feil thumb block:', e.message));
      }
    }

    return fullResult;
  } catch (e) {
    console.warn('Block-eksport feilet:', e.message);
    return null;
  }
}

/* ─── LAGRING ─── */
async function saveScenario() {
  const name = $('#sc-meta-name')?.value.trim();
  const description = $('#sc-meta-desc')?.value.trim();
  const timeMin = parseInt($('#sc-meta-time')?.value, 10) || 60;

  // Settings (kun hvis settings-tab er rendret minst én gang)
  const setEl = $('#set-time-en');
  if (setEl) {
    const s = scenarioBuf.scenario_data.settings || {};
    s.time_limit_enabled = setEl.checked;
    s.show_score = $('#set-show-score').checked;
    s.penalty_enabled = $('#set-pen-en').checked;
    s.penalty_amount = parseInt($('#set-pen-amount').value, 10) || 0;
    s.penalty_escalation = $('#set-pen-esc').checked;
    s.penalty_escalation_after = parseInt($('#set-pen-after').value, 10) || 3;
    s.penalty_escalation_amount = parseInt($('#set-pen-esc-amount').value, 10) || 2;
    scenarioBuf.scenario_data.settings = s;
  }

  if (!name) { showToast('Navn påkrevd', 'error'); return; }

  try {
    // 1. Eksporter board som PNG og last opp til Dropbox.
    //    Vi tar dette først slik at board_export_url er med når vi PATCHer.
    showToast('Lagrer scenario og genererer board-PNG...', 'info', 2000);
    await exportBoardPng();

    // 1b. Eksporter alle blocks som PNG.
    //     Vi gjør dette sekvensielt for å unngå å overlaste Dropbox-API-et,
    //     men feil på én block stopper ikke resten.
    const blocks = scenarioBuf.scenario_data.blocks || [];
    if (blocks.length > 0) {
      showToast(`Genererer PNG for ${blocks.length} block${blocks.length === 1 ? '' : 's'}...`, 'info', 2000);
      for (const b of blocks) {
        try {
          ensureBlockShape(b);
          await exportBlockPng(b);
        } catch (e) {
          console.warn('Block-eksport feilet:', b.name, e.message);
        }
      }
    }

    // 2. Lagre scenario_data
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
