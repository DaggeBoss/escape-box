const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// Token-levetid splittet etter brukertype:
//   - Admin/gamemaster/org_admin/superadmin: 180 dager (lang nok til
//     at man slipper å re-logge ofte under et engasjement, men kort
//     nok til at en stjålet token ikke gir evig tilgang)
//   - Deltager (participant): 12 timer hard cutoff. Realistisk event
//     varer 1-3 timer; 12t gir romslig margin uten å være risikabelt.
const ADMIN_TOKEN_EXPIRY  = '180d';
const PARTICIPANT_TOKEN_EXPIRY = '12h';

// ─── Signering ───────────────────────────────────────────
// signToken brukes for admin/gamemaster/org_admin/superadmin.
// Beholder samme navn for bakoverkompatibilitet med eksisterende kode.
function signToken(payload) {
  return jwt.sign(
    { ...payload, kind: 'admin' },
    JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_EXPIRY }
  );
}

// signParticipantToken brukes for deltagere som har registrert seg
// og bekreftet via SMS. Payload bør inneholde minst { team_id, participant_id }.
function signParticipantToken(payload) {
  return jwt.sign(
    { ...payload, kind: 'participant' },
    JWT_SECRET,
    { expiresIn: PARTICIPANT_TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Middleware ──────────────────────────────────────────

// Generell auth — krever gyldig token, ingen rolle-sjekk.
// Avviser participant-tokens slik at admin-endepunkter aldri kan
// nås med en deltager-token (selv om noen skulle finne på å sende
// den). Endepunkter som eksplisitt vil støtte begge, bruker
// requireAnyAuth i stedet.
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Mangler token' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) {
    return res.status(401).json({ error: 'Ugyldig token' });
  }
  if (decoded.kind === 'participant') {
    return res.status(403).json({ error: 'Deltager-token gir ikke tilgang her' });
  }
  req.user = decoded;
  next();
}

// Krever en spesifikk rolle (eller en av flere) — kun admin-tokens
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    requireAuth(req, res, (err) => {
      if (err) return;
      if (!allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Ikke tilgang' });
      }
      next();
    });
  };
}

// Krever gyldig deltager-token. Brukes på participant-endepunkter
// (registrering har bekreftet SMS og fått token tilbake).
function requireParticipant(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Mangler token' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) {
    return res.status(401).json({ error: 'Ugyldig eller utløpt token — logg inn på nytt' });
  }
  if (decoded.kind !== 'participant') {
    return res.status(403).json({ error: 'Krever deltager-token' });
  }
  req.participant = decoded;
  next();
}

// Aksepterer både admin- og deltager-tokens. Brukes på endepunkter
// der både kan trenge tilgang (f.eks. henting av eget lag-info).
// req.user ELLER req.participant settes avhengig av token-type.
function requireAnyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Mangler token' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) {
    return res.status(401).json({ error: 'Ugyldig token' });
  }
  if (decoded.kind === 'participant') {
    req.participant = decoded;
  } else {
    req.user = decoded;
  }
  next();
}

// Hjelper: sjekker at brukerens organization_id matcher en gitt org
// (superadmin kan se alt)
function canAccessOrg(user, orgId) {
  if (!user) return false;
  if (user.role === 'superadmin') return true;
  return user.organization_id === orgId;
}

module.exports = {
  signToken,
  signParticipantToken,
  verifyToken,
  requireAuth,
  requireRole,
  requireParticipant,
  requireAnyAuth,
  canAccessOrg,
  ADMIN_TOKEN_EXPIRY,
  PARTICIPANT_TOKEN_EXPIRY,
};
