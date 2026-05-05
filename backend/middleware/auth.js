const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Generell auth — krever gyldig token uansett rolle
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Mangler token' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) {
    return res.status(401).json({ error: 'Ugyldig token' });
  }
  req.user = decoded;
  next();
}

// Krever en spesifikk rolle (eller en av flere)
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

// Hjelper: sjekker at brukerens organization_id matcher en gitt org
// (superadmin kan se alt)
function canAccessOrg(user, orgId) {
  if (user.role === 'superadmin') return true;
  return user.organization_id === orgId;
}

module.exports = {
  signToken,
  verifyToken,
  requireAuth,
  requireRole,
  canAccessOrg,
};
