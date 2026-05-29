const express = require('express');
const multer = require('multer');
const { requireRole } = require('../middleware/auth');
const {
  uploadFile,
  downloadFile,
  deleteFile,
  ensureFolder,
  getOrCreateSharedLink,
  revokeSharedLink,
  buildScenarioImagePath,
  ROOT,
} = require('../lib/dropbox');

const router = express.Router();

// ─── Multer (in-memory) ────────────────────────────────────
// Bilder cap'es på 10 MB. Større blir avvist før de når Dropbox.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
      return cb(new Error('Kun bilder (jpeg, png, webp, gif) er tillatt'));
    }
    cb(null, true);
  },
});

// Egen opplaster for minispill-HTML (maks 2 MB, kun .html/.htm).
const uploadHtml = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okMime = /^(text\/html|application\/xhtml\+xml|application\/octet-stream|text\/plain)$/i.test(file.mimetype);
    const okExt = /\.html?$/i.test(file.originalname || '');
    if (!okExt) return cb(new Error('Kun .html-filer er tillatt'));
    if (!okMime) return cb(new Error('Ugyldig filtype for HTML'));
    cb(null, true);
  },
});

// Etter at grid/koordinatsystemet er fjernet er disse de eneste gyldige
// bilde-typene. 'cards' brukes for kort-bilder i passord-triggere.
// 'minigames' er reservert for ikoner/thumbnails per minispill (sesjon 3).
const VALID_KINDS = ['cards', 'minigames'];

// ─── POST /api/uploads/image ───────────────────────────────
// multipart/form-data:
//   - file: hovedbildet (komprimert, max ~1600px)
//   - thumb: thumbnail (300px, valgfri)
//   - scenario_id: påkrevd
//   - kind: 'cards' | 'minigames' (default: 'cards')
//
// Returnerer { path, url, thumb_path?, thumb_url?, size, mimetype }
router.post('/image', requireRole('superadmin'), (req, res) => {
  upload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }])(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    const fullFile = req.files?.file?.[0];
    const thumbFile = req.files?.thumb?.[0];
    if (!fullFile) {
      return res.status(400).json({ error: 'Ingen fil mottatt' });
    }

    const scenarioId = parseInt(req.body.scenario_id, 10);
    const kind = req.body.kind || 'cards';
    const overwrite = req.body.overwrite === 'true' || req.body.overwrite === true;

    if (!scenarioId || isNaN(scenarioId)) {
      return res.status(400).json({ error: 'scenario_id påkrevd' });
    }
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind må være en av ${VALID_KINDS.join(', ')}` });
    }

    try {
      // Sørg for mappestruktur én gang
      await ensureFolder(`${ROOT}/scenarios/${scenarioId}`);

      // Last opp full-versjon
      const full = buildScenarioImagePath(scenarioId, kind, fullFile.originalname || 'image.jpg');
      await ensureFolder(full.dir);
      const fullResult = await uploadFile(fullFile.buffer, full.fullPath, overwrite);
      const fullPath = fullResult.path_display || full.fullPath;
      const fullUrl = await getOrCreateSharedLink(fullPath);

      const response = {
        path: fullPath,
        url: fullUrl,
        size: fullFile.size,
        mimetype: fullFile.mimetype,
      };

      // Last opp thumbnail hvis vedlagt
      if (thumbFile) {
        const thumb = buildScenarioImagePath(scenarioId, kind, 'thumb-' + (thumbFile.originalname || 'thumb.jpg'));
        const thumbResult = await uploadFile(thumbFile.buffer, thumb.fullPath, overwrite);
        const thumbPath = thumbResult.path_display || thumb.fullPath;
        const thumbUrl = await getOrCreateSharedLink(thumbPath);
        response.thumb_path = thumbPath;
        response.thumb_url = thumbUrl;
        response.thumb_size = thumbFile.size;
      }

      res.json(response);
    } catch (e) {
      console.error('Upload-feil:', e);
      res.status(500).json({ error: e.message || 'Server feil' });
    }
  });
});

// ─── DELETE /api/uploads/image ─────────────────────────────
// body eller query: { path, url? }
router.delete('/image', requireRole('superadmin'), async (req, res) => {
  const path = req.body?.path || req.query?.path;
  const url = req.body?.url || req.query?.url;

  if (!path) {
    return res.status(400).json({ error: 'path påkrevd' });
  }

  // Sikkerhetsguard: tillat kun sletting innenfor /Escape Box/-rotmappen
  if (!path.startsWith(ROOT + '/')) {
    return res.status(400).json({ error: 'Ugyldig sti — må være innenfor ' + ROOT });
  }

  try {
    if (url) {
      try {
        await revokeSharedLink(url);
      } catch (e) {
        console.warn('Kunne ikke revoke shared link:', e.message);
      }
    }

    await deleteFile(path);
    res.json({ success: true });
  } catch (e) {
    console.error('Slette-feil:', e);
    res.status(500).json({ error: e.message || 'Server feil' });
  }
});

// ─── POST /api/uploads/html ────────────────────────────────
// multipart/form-data: { file: <.html>, scenario_id }
// Lagrer minispill-HTML under scenarios/<id>/minigames/ og returnerer
// { path, url, size, filename }. Selve innholdet serveres senere via
// GET /api/uploads/html?path=… (iframe srcdoc).
router.post('/html', requireRole('superadmin'), (req, res) => {
  uploadHtml.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const file = req.files?.file?.[0] || req.file;
    if (!file) return res.status(400).json({ error: 'Ingen fil mottatt' });

    const scenarioId = parseInt(req.body.scenario_id, 10);
    const overwrite = req.body.overwrite === 'true' || req.body.overwrite === true;
    if (!scenarioId || isNaN(scenarioId)) {
      return res.status(400).json({ error: 'scenario_id påkrevd' });
    }

    try {
      await ensureFolder(`${ROOT}/scenarios/${scenarioId}`);
      const target = buildScenarioImagePath(scenarioId, 'minigames', file.originalname || 'minigame.html');
      await ensureFolder(target.dir);
      const result = await uploadFile(file.buffer, target.fullPath, overwrite);
      const path = result.path_display || target.fullPath;
      const url = await getOrCreateSharedLink(path);
      res.json({
        path,
        url,
        size: file.size,
        filename: file.originalname || 'minigame.html',
      });
    } catch (e) {
      console.error('HTML-upload-feil:', e);
      res.status(500).json({ error: e.message || 'Server feil' });
    }
  });
});

// ─── GET /api/uploads/html?path=… ──────────────────────────
// Henter rå HTML-innhold (for iframe srcdoc). Offentlig (deltagere må
// kunne laste minispill uten innlogging), men låst til /Escape Box/-roten.
router.get('/html', async (req, res) => {
  const path = req.query?.path;
  if (!path) return res.status(400).json({ error: 'path påkrevd' });
  if (!path.startsWith(ROOT + '/') || !/\.html?$/i.test(path)) {
    return res.status(400).json({ error: 'Ugyldig sti' });
  }
  try {
    const buf = await downloadFile(path);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf.toString('utf-8'));
  } catch (e) {
    console.error('HTML-hent-feil:', e);
    res.status(500).json({ error: e.message || 'Server feil' });
  }
});

module.exports = router;
