// lib/dropbox.js — Dropbox-klient for Escape Box
// Basert på BME Portal-modulen, men med:
//   - egen rotmappe (/Escape Box/)
//   - permanente shared links per fil
//   - sti-byggere for scenario-bilder og kort-bilder
//   - valgfri namespace-id via env (for team folder-bruk)

const https = require('https');
const querystring = require('querystring');

// ─── Konstanter ────────────────────────────────────────────
// Toppmappe i Dropbox. Alle Escape Box-filer ligger under denne.
const ROOT = '/Escape Box';

// Namespace-id for team folder. Settes som env-variabel hvis Escape Box-
// mappen ligger i en delt team folder (ikke personlig Dropbox-rot). Tom
// streng = ingen namespace-header sendes.
const NAMESPACE_ID = process.env.DROPBOX_NAMESPACE_ID || '';
const NAMESPACE_HEADER = NAMESPACE_ID
  ? JSON.stringify({ '.tag': 'namespace_id', 'namespace_id': NAMESPACE_ID })
  : null;

// ─── ASCII-safe JSON ────────────────────────────────────────
// Dropbox-API-Arg-headeren MÅ være ASCII. Norske tegn og andre Unicode
// må escapes til \uXXXX-form, ellers returnerer Dropbox 401 (cryptic).
function asciiSafeJson(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uffff]/g, ch =>
    '\\u' + ('0000' + ch.charCodeAt(0).toString(16)).slice(-4)
  );
}

// Bygger headers med (eller uten) namespace, avhengig av env-konfig
function dropboxHeaders(extra = {}) {
  const h = { ...extra };
  if (NAMESPACE_HEADER) h['Dropbox-API-Path-Root'] = NAMESPACE_HEADER;
  return h;
}

// ─── Token-håndtering ───────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

function invalidateAccessToken() {
  cachedToken = null;
  tokenExpiry = 0;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const data = querystring.stringify({
    grant_type: 'refresh_token',
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
    client_id: process.env.DROPBOX_APP_KEY,
    client_secret: process.env.DROPBOX_APP_SECRET,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.dropbox.com',
      path: '/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.access_token) {
            cachedToken = json.access_token;
            tokenExpiry = Date.now() + (json.expires_in * 1000);
            resolve(cachedToken);
          } else {
            reject(new Error('Token refresh feilet: ' + body));
          }
        } catch (e) {
          reject(new Error('Token refresh parse-feil: ' + body));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Generisk API-kall ──────────────────────────────────────
async function dropboxApi(endpoint, body, token) {
  const accessToken = token || await getAccessToken();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.dropboxapi.com',
      path: `/2/${endpoint}`,
      method: 'POST',
      headers: dropboxHeaders({
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      }),
    }, (res) => {
      let resp = '';
      res.on('data', c => resp += c);
      res.on('end', () => {
        try { resolve(JSON.parse(resp)); } catch { resolve(resp); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Opplasting ─────────────────────────────────────────────
function uploadFileAttempt(fileBuffer, dropboxPath, token, overwrite) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'content.dropboxapi.com',
      path: '/2/files/upload',
      method: 'POST',
      headers: dropboxHeaders({
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiSafeJson({
          path: dropboxPath,
          mode: overwrite ? 'overwrite' : 'add',
          autorename: !overwrite,
          mute: false,
        }),
        'Content-Length': fileBuffer.length,
      }),
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(fileBuffer);
    req.end();
  });
}

async function uploadFile(fileBuffer, dropboxPath, overwrite = false) {
  let token = await getAccessToken();
  let result = await uploadFileAttempt(fileBuffer, dropboxPath, token, overwrite);

  // 401 = token er ugyldig (kan skje ved app-restart eller hvis Dropbox
  // invaliderer tokenen tidlig). Refresh og prøv på nytt én gang.
  if (result.statusCode === 401) {
    console.warn('[DROPBOX] uploadFile 401 — refresher token og prøver på nytt');
    invalidateAccessToken();
    token = await getAccessToken();
    result = await uploadFileAttempt(fileBuffer, dropboxPath, token, overwrite);
  }

  if (result.statusCode !== 200) {
    throw new Error(`Dropbox upload feilet (${result.statusCode}) for ${dropboxPath}: ${result.body}`);
  }

  try { return JSON.parse(result.body); } catch { return result.body; }
}

// ─── Shared links (permanente offentlige URL-er) ───────────
// Lager en delt lenke som peker direkte til filen. Vi konverterer
// "?dl=0" til "?raw=1" slik at lenken kan brukes direkte i <img src>.
//
// Dropbox returnerer 'shared_link_already_exists' hvis det finnes en
// fra før — da henter vi den eksisterende i stedet for å feile.
async function getOrCreateSharedLink(dropboxPath) {
  const token = await getAccessToken();

  // Forsøk å lage ny
  const create = await dropboxApi('sharing/create_shared_link_with_settings', {
    path: dropboxPath,
    settings: {
      requested_visibility: 'public',
      audience: 'public',
      access: 'viewer',
    },
  }, token);

  let url;
  if (create.url) {
    url = create.url;
  } else if (create.error_summary && create.error_summary.includes('shared_link_already_exists')) {
    // Hent eksisterende
    const list = await dropboxApi('sharing/list_shared_links', {
      path: dropboxPath,
      direct_only: true,
    }, token);
    if (list.links && list.links.length > 0) {
      url = list.links[0].url;
    } else {
      throw new Error('Shared link finnes men kunne ikke hentes for ' + dropboxPath);
    }
  } else {
    throw new Error('Kunne ikke lage shared link: ' + JSON.stringify(create));
  }

  // Konverter til direkte bilde-URL.
  // Dropbox shared links er på formen https://www.dropbox.com/scl/fi/.../filnavn.jpg?rlkey=...&dl=0
  // ?dl=0 = nedlastingsside, ?raw=1 = rå fil (kan brukes i <img>).
  return url.replace(/[?&]dl=0/, '').replace(/(\?|&)/, m => m) + (url.includes('?') ? '&raw=1' : '?raw=1');
}

// Trekk tilbake en shared link (men ikke slett selve filen)
async function revokeSharedLink(sharedUrl) {
  const token = await getAccessToken();
  // Dropbox vil ha originalen, ikke ?raw=1-versjonen — strip det
  const cleanUrl = sharedUrl.replace(/[?&]raw=1/, '').replace(/&$/, '');
  const result = await dropboxApi('sharing/revoke_shared_link', { url: cleanUrl }, token);
  return result;
}

// ─── Sletting med retry ─────────────────────────────────────
async function deleteFile(dropboxPath) {
  return deleteWithRetry(dropboxPath, 'fil');
}

async function deleteFolder(dropboxPath) {
  return deleteWithRetry(dropboxPath, 'mappe');
}

async function deleteWithRetry(dropboxPath, kind) {
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 500;
  let lastErr = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const token = await getAccessToken();
      const result = await dropboxApi('files/delete_v2', { path: dropboxPath }, token);

      if (!result.error_summary) return result;
      // Allerede borte = OK
      if (result.error_summary.includes('path_lookup/not_found')) return result;

      // Forbigående feil — retry
      if (result.error_summary.includes('too_many_requests') ||
          result.error_summary.includes('too_many_write_operations') ||
          result.error_summary.includes('internal_error')) {
        lastErr = new Error(`Dropbox slett ${kind}: ${result.error_summary}`);
        const wait = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[DROPBOX] ${result.error_summary} på ${dropboxPath}, venter ${wait}ms (forsøk ${attempt + 1}/${MAX_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      throw new Error(`Dropbox slett ${kind}: ${result.error_summary}`);
    } catch (err) {
      if (err.message?.startsWith('Dropbox slett ')) throw err;
      lastErr = err;
      if (attempt === MAX_ATTEMPTS - 1) break;
      await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error(`Dropbox slett ${kind} feilet etter ${MAX_ATTEMPTS} forsøk`);
}

// ─── Mappehåndtering ───────────────────────────────────────
async function ensureFolder(dropboxPath) {
  const token = await getAccessToken();
  const result = await dropboxApi('files/create_folder_v2', {
    path: dropboxPath,
    autorename: false,
  }, token);

  if (result.error_summary && !result.error_summary.includes('path/conflict')) {
    throw new Error(`Kunne ikke opprette mappe ${dropboxPath}: ${result.error_summary}`);
  }
  return result;
}

// ─── Sti-byggere for Escape Box ────────────────────────────
// Tar vekk alt utenom bokstaver, tall, æøå, mellomrom og bindestrek
function cleanFilename(name) {
  return name.replace(/[^a-zA-Z0-9æøåÆØÅ\s\-\.]/g, '').trim();
}

function buildScenarioImagePath(scenarioId, kind, originalFilename) {
  // kind: 'coords' | 'cards' | 'backgrounds'
  const validKinds = ['coords', 'cards', 'backgrounds', 'originals', 'blocks'];
  if (!validKinds.includes(kind)) {
    throw new Error(`Ugyldig bilde-kind: ${kind}. Må være en av ${validKinds.join(', ')}`);
  }

  // Behold det innsendte filnavnet hvis det ser ut som et "ekte" navn
  // (dvs. inneholder bokstaver utover bare tall/streker). Dette gjør at
  // PNG-eksporter med deterministiske navn som "Grid-foo.png" forblir
  // stabile mellom redigeringer slik at overwrite faktisk fungerer.
  //
  // For ad-hoc opplastinger (kort-bilder fra brukeren med navn som
  // "skjermbilde.png") legges det til et timestamp-prefix slik at flere
  // bilder med samme navn ikke kolliderer.
  let filename;
  const safeName = (originalFilename || '').replace(/[\u0000-\u001f\\\/]/g, '').trim();
  const looksDeterministic = /^(Grid|Bunke|Block|export|thumb-Grid|thumb-Bunke|thumb-Block|thumb-export)/i.test(safeName);

  if (safeName && looksDeterministic) {
    // Bruk filnavnet som-er — krevet for overwrite-flyten
    filename = safeName;
  } else {
    // Ad-hoc upload: legg p\u00e5 timestamp + random for \u00e5 unng\u00e5 kollisjoner
    const ext = (safeName.match(/\.[^.]+$/) || ['.jpg'])[0].toLowerCase();
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    filename = `${ts}-${rand}${ext}`;
  }

  return {
    dir: `${ROOT}/scenarios/${scenarioId}/${kind}`,
    filename,
    fullPath: `${ROOT}/scenarios/${scenarioId}/${kind}/${filename}`,
  };
}

// Slett hele scenarioets bildemappe (brukes ved scenario-sletting)
async function deleteScenarioFolder(scenarioId) {
  const path = `${ROOT}/scenarios/${scenarioId}`;
  return deleteFolder(path);
}

// ─── Eksport ────────────────────────────────────────────────
module.exports = {
  // Token
  getAccessToken,
  invalidateAccessToken,
  // Generisk
  dropboxApi,
  asciiSafeJson,
  // Filer
  uploadFile,
  deleteFile,
  // Mapper
  ensureFolder,
  deleteFolder,
  deleteScenarioFolder,
  // Shared links
  getOrCreateSharedLink,
  revokeSharedLink,
  // Sti-byggere
  buildScenarioImagePath,
  cleanFilename,
  // Konstanter
  ROOT,
};
