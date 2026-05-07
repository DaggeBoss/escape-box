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
//   - file: bildet
//   - scenario_id: påkrevd
//   - kind: 'coords' | 'cards' | 'backgrounds' (default: 'coords')
//
// Returnerer { path, url, size, mimetype } der:
//   - path: Dropbox-stien (lagres permanent i scenario_data)
//   - url:  permanent shared link til direkte bruk i <img src>
router.post('/image', requireRole('superadmin'), (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
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
      const { dir, fullPath } = buildScenarioImagePath(
        scenarioId,
        kind,
        req.file.originalname || 'image.jpg'
      );

      // Sørg for at scenario-rot og kind-mappen finnes.
      // path/conflict ignoreres internt i ensureFolder.
      await ensureFolder(`${ROOT}/scenarios/${scenarioId}`);
      await ensureFolder(dir);

      // Last opp bildet
      const uploadResult = await uploadFile(req.file.buffer, fullPath, false);
      const finalPath = uploadResult.path_display || fullPath;

      // Lag permanent shared link (eller hent eksisterende)
      const url = await getOrCreateSharedLink(finalPath);

      res.json({
        path: finalPath,
        url,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });
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
