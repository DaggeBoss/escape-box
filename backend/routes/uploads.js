const express = require('express');
const multer = require('multer');
const { requireRole } = require('../middleware/auth');
const {
  uploadFile,
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
// Vi bruker memoryStorage fordi bildene allerede er komprimert i frontend
// før opplasting (typisk ender på <500KB) — ingen grunn til å skrive til
// disk.
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

const VALID_KINDS = ['coords', 'cards', 'backgrounds'];

// ─── POST /api/uploads/image ───────────────────────────────
// multipart/form-data:
//   - file: hovedbildet (komprimert, max ~1600px)
//   - thumb: thumbnail (300px, valgfri)
//   - scenario_id: påkrevd
//   - kind: 'coords' | 'cards' | 'backgrounds' (default: 'coords')
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
    const kind = req.body.kind || 'coords';

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
      const fullResult = await uploadFile(fullFile.buffer, full.fullPath, false);
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
        const thumbResult = await uploadFile(thumbFile.buffer, thumb.fullPath, false);
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
//   - path: påkrevd, brukes til å slette selve filen
//   - url:  valgfri, brukes til å revoke shared link
//
// Hvis url ikke er gitt, slettes bare filen — Dropbox revoker shared
// links automatisk når filen er borte, men det er litt slurv siden
// linken da returnerer 404 mellom sletting og revoke. Send med url
// hvis du har den.
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
    // Revoke shared link først hvis vi har den (best effort — feil her
    // er ikke kritiske, vi sletter filen uansett)
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

module.exports = router;
