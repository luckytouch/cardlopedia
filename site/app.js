// Cardlopedia: search results page (loaded after common.js).
const start = readParams();
let game = start.game;
let filters = start.f;          // filters from the advanced search page, for the current game
let state = { q: '', page: 1, cards: [], seq: 0 };

$('q').value = start.q;
renderGamePills($('games'), game, (g) => {
  game = g;
  filters = {};                 // filters are specific to one game
  setGame();
  $('q').focus();
  search($('q').value);
});

function setGame() {
  applyAccent(game);
  $('q').placeholder = `Search ${game.name} cards — try “${game.example}”`;
  $('hint').innerHTML = game.tip;
}

// Keep the address bar in step, so refresh, back and shared links reproduce the results.
function syncUrl() {
  const url = new URL(pageUrl(PAGES.results, game, $('q').value.trim(), filters), location.href);
  if (url.href !== location.href) history.replaceState(null, '', url);
  $('advLink').href = pageUrl(PAGES.advanced, game, $('q').value.trim(), filters);
}

// ---------- Applied filters ----------

async function renderApplied() {
  const entries = Object.entries(filters);
  $('fcount').hidden = !entries.length;
  $('fcount').textContent = entries.length;
  if (!entries.length) { $('applied').hidden = true; return; }
  const g = game;
  let fields = [];
  try { fields = await getFields(g.id); } catch {}
  if (g !== game) return;
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  $('applied').innerHTML =
    entries.map(([k, v]) => `<span class="tag"><b>${esc(describeFilter(byKey[k] || { label: k }, v))}</b>
      <button type="button" data-key="${esc(k)}" aria-label="Remove filter">×</button></span>`).join('') +
    `<span class="sep">|</span><a class="linkbtn" href="${esc(pageUrl(PAGES.advanced, game, $('q').value.trim(), filters))}">Edit</a>
     <button class="linkbtn" type="button" id="clearAll">Clear all</button>`;
  $('applied').hidden = false;
}

$('applied').addEventListener('click', (e) => {
  const x = e.target.closest('button[data-key]');
  if (x) delete filters[x.dataset.key];
  else if (e.target.id === 'clearAll') filters = {};
  else return;
  search($('q').value);
});

// ---------- Search ----------

$('form').addEventListener('submit', (e) => { e.preventDefault(); search($('q').value); });
let t;
$('q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search($('q').value), 350); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('q') && !$('dlg').open) { e.preventDefault(); $('q').focus(); $('q').select(); }
});

// An empty query with no filters browses the game's full catalog.
async function search(q, page = 1) {
  q = q.trim();
  const seq = ++state.seq;
  const filtered = Object.keys(filters).length > 0;
  if (page === 1) {
    state = { q, page, cards: [], seq, loading: true, hasMore: false, filtered };
    $('grid').innerHTML = Array(12).fill('<div class="card skel"><div class="img"></div></div>').join('');
    $('more').hidden = true;
    if (scrollY > $('grid').offsetTop) scrollTo(0, 0);
    syncUrl();
    renderApplied();
  }
  state.loading = true;
  $('more').disabled = true;
  $('more').textContent = 'Loading…';
  try {
    const r = await Engine.query(game.id, q, filters, page);
    if (seq !== state.seq) return;
    const first = state.cards.length;
    state.page = page;
    state.hasMore = r.hasMore;
    state.cards.push(...r.cards);
    render(r, first);
  } catch (err) {
    if (seq !== state.seq) return;
    if (page === 1) {
      $('grid').innerHTML = `<p class="empty">${esc(err.message || 'Search failed. Check your connection and try again.')}</p>`;
      $('more').hidden = true;
    } else {
      state.hasMore = false; // stop auto-loading; the button still retries
      $('more').textContent = 'Couldn’t load more. Try again';
    }
  } finally {
    if (seq === state.seq) { state.loading = false; $('more').disabled = false; }
  }
  // The observer only fires on changes, so keep filling if the button is still in range.
  if (seq === state.seq && state.hasMore && nearBottom()) search(state.q, state.page + 1);
}
const nearBottom = () => !$('more').hidden && $('more').getBoundingClientRect().top < innerHeight + 800;

// Stand-in for cards with no image yet (newly revealed cards before images are posted).
const noImage = (c) => `<div class="noimg"><b>${esc(c.name)}</b><span>${esc(c.type || '')}</span><small>Image coming soon</small></div>`;

const tile = (c, i) => `
  <button class="card${c.landscape ? ' land' : ''}" data-i="${i}">
    <div class="img">${c.image ? `<img loading="lazy" src="${esc(c.image)}" alt="${esc(c.name)}">` : noImage(c)}</div>
    <div class="meta"><b>${esc(c.name)}</b><span class="mono">${esc([c.number, c.set].filter(Boolean).join(' · '))}</span></div>
  </button>`;

// Fade card images in once loaded. Load events don't bubble, so listen during capture.
$('grid').addEventListener('load', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('ok'); }, true);
$('grid').addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') retryImage(e.target, state.cards[+e.target.closest('.card')?.dataset.i]);
}, true);

// Some image links expire (Cyberpunk's last about five minutes). Ask the engine for a current
// link and retry once before giving up on the image.
async function retryImage(img, card) {
  const url = !img.dataset.retried && card ? await Engine.freshImage(game.id, card.id).catch(() => null) : null;
  img.dataset.retried = '1';
  if (url && url !== img.src) img.src = url;
  else img.classList.add('ok', 'broken');
}

function render(r, first) {
  const html = state.cards.slice(first).map((c, i) => tile(c, first + i)).join('');
  if (first === 0) {
    const what = [state.q && `“${esc(state.q)}”`, state.filtered && 'these filters'].filter(Boolean).join(' with ');
    $('grid').innerHTML = html || (what
      ? `<p class="empty">No ${esc(game.name)} cards match ${what}.</p>`
      : `<p class="empty">This card database returned no cards.</p>`);
  } else {
    $('grid').insertAdjacentHTML('beforeend', html);
  }
  $('more').hidden = !r.hasMore;
  $('more').textContent = 'Show more';
  const n = r.total ?? state.cards.length;
  const count = `<b>${n.toLocaleString()}${r.total == null && r.hasMore ? '+' : ''}</b> ${n === 1 ? 'card' : 'cards'}`;
  $('hint').innerHTML = !state.cards.length ? game.tip
    : state.q || state.filtered ? `${count} in ${esc(game.name)}`
    : `All ${count} in ${esc(game.name)} · type to search, or use <a class="linkbtn" href="${esc(pageUrl(PAGES.advanced, game, '', {}))}">Advanced search</a>`;
}

$('more').addEventListener('click', () => search(state.q, state.page + 1));

// Load the next page as the "Show more" button nears the viewport.
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.hasMore && !state.loading) search(state.q, state.page + 1);
}, { rootMargin: '800px 0px' }).observe($('more'));

// ---------- Card detail ----------

$('grid').addEventListener('click', async (e) => {
  const b = e.target.closest('.card[data-i]'); if (!b) return;
  const c = state.cards[+b.dataset.i];
  showCard(c);
  if (c.lazy) {
    const full = await Engine.card(game.id, c.id).catch(() => null);
    if (full && $('dlg').open && $('dlg').dataset.id === c.id) {
      Object.assign(c, full, { lazy: false });
      showCard(c);
    }
  }
});

function showCard(c) {
  const stats = (c.stats || []).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('dlg').dataset.id = c.id;
  $('dlgBody').innerHTML = `
    <div class="detail">
      <div class="art">${c.large || c.image ? `<img src="${esc(c.large || c.image)}" alt="${esc(c.name)}">` : `<div class="card"><div class="img">${noImage(c)}</div></div>`}</div>
      <div>
        <h2>${esc(c.name)}</h2>
        <div class="type">${esc(c.type || (c.lazy ? 'Loading details…' : ''))}</div>
        ${c.untranslated ? '<p class="pnote">Not translated yet. Shown in the original Japanese.</p>' : ''}
        ${c.preview ? '<p class="pnote">Newly revealed card. Its details come from TCGplayer’s listing until the card database adds this set.</p>' : ''}
        ${c.text ? `<div class="text">${esc(c.text)}</div>` : ''}
        ${stats ? `<dl class="stats">${stats}</dl>` : ''}
        ${c.jp && !c.untranslated ? `<details class="original"><summary>Original Japanese</summary>
          <p lang="ja"><b>${esc(c.jp.name)}</b>${c.jp.team ? ` · ${esc(c.jp.team)}` : ''}</p>
          ${c.jp.text ? `<p lang="ja" class="jptext">${esc(c.jp.text)}</p>` : ''}
          <p class="pnote">Translated by Cardlopedia. The game is only published in Japanese.</p></details>` : ''}
        <section class="pricebox" id="pricebox" aria-live="polite">${priceHtml(c._price)}</section>
        <div class="foot">
          ${c.set ? `<span>${esc(c.set)}</span>` : ''}
          ${c.number ? `<span class="mono">${esc(c.number)}</span>` : ''}
          ${c.rarity ? `<span>${esc(c.rarity)}</span>` : ''}
          ${c.artist ? `<span>Art by ${esc(c.artist)}</span>` : ''}
          ${c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">Source ↗</a>` : ''}
        </div>
      </div>
    </div>`;
  $('dlgBody').querySelector('.art img').addEventListener('error', (e) => {
    if (e.target.dataset.retried) return;
    Engine.freshImage(game.id, c.id).then((url) => { e.target.dataset.retried = '1'; if (url) e.target.src = url; }, () => {});
  });
  if (!$('dlg').open) $('dlg').showModal();
  // Pokémon cards open twice (brief, then full details), so guard against a second request.
  if (c._price === undefined && !c._priceLoading) {
    c._priceLoading = true;
    loadPrice(c).finally(() => { c._priceLoading = false; });
  }
}

// ---------- TCGplayer prices (via TCGCSV) ----------

const money = (n) => (n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function priceHtml(p) {
  const label = '<span class="plabel">TCGplayer price</span>';
  if (p === undefined) return `${label}<p class="pnote">Loading price…</p>`;
  if (p === null) return `${label}<p class="pnote">Couldn’t reach the price service. Close and reopen the card to try again.</p>`;
  if (p.unsupported) return `${label}<p class="pnote">TCGplayer doesn’t sell this game, so there’s no price.</p>`;
  if (p.none) return `${label}<p class="pnote">No matching TCGplayer listing found for this card.</p>`;
  const rows = p.prices.map((r) => `
    <div class="prow">
      <span class="amt">${money(r.market ?? r.mid)}</span>
      <span class="kind">${esc(r.type)}</span>
      <span class="range">${r.market == null ? 'listed' : 'market'} · low ${money(r.low)} · mid ${money(r.mid)} · high ${money(r.high)}</span>
    </div>`).join('');
  return `${label}
    ${rows || '<p class="pnote">Listed on TCGplayer, but no recent sales or listings to price it from.</p>'}
    <p class="pnote"><a href="${esc(p.url)}" target="_blank" rel="noopener">View on TCGplayer ↗</a>
      <span>Prices update daily from TCGplayer via TCGCSV.</span></p>`;
}

async function loadPrice(c) {
  let p = null;
  try { p = await Engine.price(game.id, c.tcg); } catch {}
  if (p) c._price = p;           // keep failures unset so reopening the card retries
  render(p);
  function render(value = c._price) {
    if ($('dlg').open && $('dlg').dataset.id === c.id) $('pricebox').innerHTML = priceHtml(value);
  }
}
$('close').addEventListener('click', () => $('dlg').close());
$('dlg').addEventListener('click', (e) => { if (e.target === $('dlg')) $('dlg').close(); });

setGame();
search($('q').value);
