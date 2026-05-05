// Genererer kort kode (f.eks. 4-6 tegn) — utelater I, O, 0, 1 for å unngå forvirring
function generateCode(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Genererer 4-sifret PIN
function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Genererer slug fra et navn
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[æåa]/g, 'a')
    .replace(/[øö]/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// Genererer ledige farger til lag
const TEAM_COLORS = [
  '#ff4444', // rød
  '#4dabf7', // blå
  '#51cf66', // grønn
  '#ffd43b', // gul
  '#cc5de8', // lilla
  '#ff922b', // oransje
  '#20c997', // teal
  '#f783ac', // rosa
  '#9775fa', // purple
  '#fab005', // amber
];

function getTeamColor(index) {
  return TEAM_COLORS[index % TEAM_COLORS.length];
}

module.exports = {
  generateCode,
  generatePin,
  slugify,
  getTeamColor,
  TEAM_COLORS,
};
