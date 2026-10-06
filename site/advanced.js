// Cardlopedia: advanced search page (loaded after common.js).
const start = readParams();
let game = start.game;
let filters = { ...start.f };
$('name').value = start.q;
$('text').value = filters.text || '';
delete filters.text;             // the text box owns this one

renderGamePills($('games'), game, (g) => {
  game = g;
  filters = {};                   // filters differ per game; name and text carry over
  setGame();
});

function setGame() {
  applyAccent(game);
  $('title').textContent = `Advanced ${game.name} search`;
  $('name').placeholder = `e.g. ${game.example}`;
  $('nameHelp').innerHTML = game.id === 'mtg' ? 'Also accepts Scryfall syntax' : 'Name or card number';
  $('back').href = pageUrl(PAGES.results, game, '', {});
  document.title = `Advanced ${game.name} Search · Cardlopedia`;
  loadFields();
}

async function loadFields() {
  const g = game;
  $('fields').innerHTML = '<p class="muted">Loading filters…</p>';
  try {
    const fields = await getFields(g.id);
    if (g !== game) return;
    const textField = fields.find((f) => f.key === 'text');
    if (textField?.placeholder) $('text').placeholder = textField.placeholder;
    renderFields(fields.filter((f) => f.key !== 'text'));
  } catch (err) {
    if (g === game) $('fields').innerHTML = `<p class="muted">Couldn’t load filters (${esc(err.message)}). Reload the page to try again.</p>`;
  }
  updateCount();
}

function renderFields(fields) {
  const id = (k) => `f-${game.id}-${k}`;
  // Full-width chip rows go first so the remaining fields pack into an even grid.
  const chipRow = (fl) => fl.kind === 'multi' || fl.kind === 'exclude';
  fields = [...fields].sort((a, b) => chipRow(b) - chipRow(a));
  $('fields').innerHTML = fields.map((fl) => {
    const v = filters[fl.key];
    const label = `<span>${esc(fl.label)}</span>`;
    switch (fl.kind) {
      case 'multi':
      case 'exclude':   // chips that hide matching cards instead of selecting them
        return `<div class="fld wide" role="group" aria-label="${esc(fl.label)}">${label}<div class="chips">${fl.options.map(opt).map((o) =>
          `<button type="button" class="chip${fl.kind === 'exclude' ? ' exclude' : ''}" data-key="${fl.key}" data-value="${esc(o.value)}" aria-pressed="${(v || []).includes(o.value)}">${esc(o.label)}</button>`).join('')}</div>${fl.help ? `<small>${esc(fl.help)}</small>` : ''}</div>`;
      case 'select':
        return `<label class="fld">${label}<select id="${id(fl.key)}" data-key="${fl.key}"><option value="">Any</option>${fl.options.map(opt).map((o) =>
          `<option value="${esc(o.value)}"${v === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      case 'combo':
        return `<label class="fld">${label}<input id="${id(fl.key)}" data-key="${fl.key}" list="${id(fl.key)}-list" placeholder="Any" value="${esc(v || '')}">
          <datalist id="${id(fl.key)}-list">${fl.options.map(opt).map((o) => `<option value="${esc(o.value)}">`).join('')}</datalist></label>`;
      case 'range':
        return `<div class="fld" role="group" aria-label="${esc(fl.label)}">${label}<div class="pair">
          <input id="${id(fl.key)}-min" data-key="${fl.key}" data-end="0" type="number" inputmode="numeric" placeholder="Min" aria-label="${esc(fl.label)} minimum" value="${esc(v?.[0] ?? '')}">
          <em>–</em>
          <input id="${id(fl.key)}-max" data-key="${fl.key}" data-end="1" type="number" inputmode="numeric" placeholder="Max" aria-label="${esc(fl.label)} maximum" value="${esc(v?.[1] ?? '')}">
        </div></div>`;
      default:
        return `<label class="fld">${label}<input id="${id(fl.key)}" data-key="${fl.key}" type="text" placeholder="${esc(fl.placeholder || 'Contains…')}" value="${esc(v || '')}"></label>`;
    }
  }).join('') || '<p class="muted">This game has no extra filters.</p>';
}

$('fields').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip'); if (!chip) return;
  const on = chip.getAttribute('aria-pressed') !== 'true';
  chip.setAttribute('aria-pressed', on);
  const list = new Set(filters[chip.dataset.key] || []);
  on ? list.add(chip.dataset.value) : list.delete(chip.dataset.value);
  filters[chip.dataset.key] = [...list];
  updateCount();
});

$('fields').addEventListener('input', (e) => {
  const el = e.target, key = el.dataset.key; if (!key) return;
  if (el.dataset.end !== undefined) {
    const r = filters[key] || ['', ''];
    r[+el.dataset.end] = el.value;
    filters[key] = r;
  } else {
    filters[key] = el.value;
  }
  updateCount();
});
$('name').addEventListener('input', updateCount);
$('text').addEventListener('input', updateCount);

// Everything the search will send: name as the query, text alongside the other filters.
const query = () => ({ q: $('name').value.trim(), f: cleanFilters({ ...filters, text: $('text').value.trim() }) });

// Live count on the search button, so people see how many cards they'll get.
let ct, cseq = 0;
function updateCount() {
  clearTimeout(ct);
  const { q, f } = query();
  const n = Object.keys(f).length + (q ? 1 : 0);
  $('summary').textContent = n ? 'Counting matches…' : 'Choose any filters, then search.';
  ct = setTimeout(async () => {
    const seq = ++cseq;
    try {
      const r = await Engine.query(game.id, q, f, 1);
      if (seq !== cseq) return;
      const total = r.total ?? r.cards.length;
      const count = `${total.toLocaleString()}${r.total == null && r.hasMore ? '+' : ''}`;
      $('summary').innerHTML = total
        ? `<b>${count}</b> ${game.name} ${total === 1 ? 'card matches' : 'cards match'}`
        : `No ${esc(game.name)} cards match. Try loosening a filter.`;
      $('go').textContent = total ? `Show ${count} ${total === 1 ? 'card' : 'cards'}` : 'Search';
    } catch {
      if (seq === cseq) { $('summary').textContent = 'Couldn’t count matches right now. You can still search.'; $('go').textContent = 'Search'; }
    }
  }, 450);
}

$('adv').addEventListener('submit', (e) => {
  e.preventDefault();
  const { q, f } = query();
  location.href = pageUrl(PAGES.results, game, q, f);
});

$('reset').addEventListener('click', () => {
  filters = {};
  $('name').value = '';
  $('text').value = '';
  loadFields();
});

setGame();
