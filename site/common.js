// Cardlopedia: helpers shared by the search page (index.html) and advanced search (advanced.html).
// Loaded after engine.js.

// onAccent is the text color used on top of the game's color (dark on the yellow games).
const GAMES = [
  { id: 'mtg', name: 'Magic', color: '#d9772b', onAccent: '#fff', example: 't:dragon c:r', tip: 'Full Scryfall syntax works: <b>t:dragon c:r</b>, <b>o:"draw a card" mv<=2</b>' },
  { id: 'pkm', name: 'Pokémon', color: '#e8b400', onAccent: '#1c1500', example: 'charizard', tip: 'Search by card name' },
  { id: 'ygo', name: 'Yu-Gi-Oh!', color: '#8b5cf6', onAccent: '#fff', example: 'blue-eyes', tip: 'Search by card name' },
  { id: 'op', name: 'One Piece', color: '#dc3b3b', onAccent: '#fff', example: 'luffy', tip: 'Name or card number (<b>OP05-119</b>)' },
  { id: 'lor', name: 'Lorcana', color: '#3a7bd5', onAccent: '#fff', example: 'stitch', tip: 'Name or card number' },
  { id: 'dgm', name: 'Digimon', color: '#1ea37a', onAccent: '#fff', example: 'omnimon', tip: 'Name or card number (<b>BT1-084</b>)' },
  { id: 'rb', name: 'Riftbound', color: '#c89b3c', onAccent: '#1c1400', example: 'jinx', tip: 'Name or card number' },
  { id: 'cp', name: 'Cyberpunk', color: '#d6c400', onAccent: '#1a1800', example: 'judy', tip: 'Name or card number' },
  { id: 'swu', name: 'Star Wars Unlimited', color: '#5a6478', onAccent: '#fff', example: 'vader', tip: 'Name or card number' },
  { id: 'hv', name: 'Haikyu!!', color: '#f0601c', onAccent: '#fff', example: 'hinata', tip: 'Name in English or Japanese, or card number (<b>HV-P01-001</b>). Cards are translated from Japanese' },
];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const isSet = (v) => (Array.isArray(v) ? v.some((x) => x !== '' && x !== null && x !== undefined) : v !== '' && v != null);
const opt = (o) => (typeof o === 'string' ? { value: o, label: o } : o);
const cleanFilters = (f) => Object.fromEntries(Object.entries(f || {}).filter(([, v]) => isSet(v)));

// The results page and advanced page share state through the URL: ?game=op&q=luffy&f={...}
function readParams() {
  const p = new URLSearchParams(location.search);
  let f = {};
  try { f = JSON.parse(p.get('f') || '{}') || {}; } catch {}
  const id = p.get('game') || location.hash.slice(1) || store.get('game');
  return { game: GAMES.find((g) => g.id === id) || GAMES[0], q: p.get('q') || '', f: cleanFilters(f) };
}

function pageUrl(pagePath, game, q, f) {
  const p = new URLSearchParams({ game: game.id });
  if (q) p.set('q', q);
  const clean = cleanFilters(f);
  if (Object.keys(clean).length) p.set('f', JSON.stringify(clean));
  return `${pagePath}?${p}`;
}

function renderGamePills(el, current, onPick) {
  el.innerHTML = GAMES.map((g) =>
    `<button class="game" type="button" data-id="${g.id}" style="--c:${g.color}" aria-pressed="${g === current}"><i></i>${g.name}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('.game'); if (!b) return;
    const g = GAMES.find((x) => x.id === b.dataset.id);
    el.querySelectorAll('.game').forEach((x) => x.setAttribute('aria-pressed', x === b));
    onPick(g);
  };
}

function applyAccent(g) {
  document.documentElement.style.setProperty('--accent', g.color);
  document.documentElement.style.setProperty('--on-accent', g.onAccent);
  store.set('game', g.id);
}

// Filter definitions per game (engine.js caches them for the page's lifetime).
const getFields = (gameId) => Engine.fields(gameId);

// Page addresses are relative, so the site works at a domain root or in a GitHub Pages
// project folder (username.github.io/cardlopedia/).
const PAGES = { results: './', advanced: 'advanced.html' };

// A short, readable description of one applied filter: "Power 6000–8000", "Color Red or Green".
function describeFilter(fl, v) {
  const labelOf = (x) => (fl?.options || []).map(opt).find((o) => o.value === x)?.label || x;
  const name = fl?.label || '';
  if (fl?.kind === 'exclude') return `Hiding ${v.map(labelOf).join(', ')}`;
  if (fl?.describeAs === 'all') return `${name}: ${v.map(labelOf).join(' + ')}`;   // e.g. Commander deck colors: Blue + Red
  if (fl?.kind === 'range' || Array.isArray(v) && fl?.kind !== 'multi') {
    const [lo, hi] = v.map((x) => (x === '' || x == null ? null : x));
    const span = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : lo != null ? `${lo}+` : `up to ${hi}`;
    return `${name} ${span}`;
  }
  if (Array.isArray(v)) return `${name}: ${v.map(labelOf).join(' or ')}`;
  if (fl?.kind === 'text') return `${name} contains “${v}”`;
  return `${name}: ${labelOf(v)}`;
}
