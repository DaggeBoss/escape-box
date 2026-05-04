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

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Mangler token' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded || decoded.role !== 'admin') {
    return res.status(401).json({ error: 'Ugyldig token' });
  }
  req.admin = decoded;
  next();
}

module.exports = { signToken, verifyToken, requireAdmin };
