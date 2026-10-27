#!/usr/bin/env node
// Builds site/data/: everything Cardlopedia needs that a browser can't fetch for itself.
// Runs daily in GitHub Actions (see .github/workflows/pages.yml), or locally with `npm run build`.
//
//   data/catalog/<game>.json  Full catalogs + filter options for One Piece, Lorcana, Digimon,
//                             Riftbound, Cyberpunk and Star Wars (filtered in the browser)
//   data/fields/<game>.json   Filter options for Magic, Pokémon, Yu-Gi-Oh! (searched live)
//   data/pkm-sets.json        Pokémon set release order, for newest-first browsing
//   data/pkm-text.json        Pokémon attack/ability/trainer text, for card-text search
//   data/tcg/...              TCGplayer products and prices from TCGCSV, for price lookups
//
// If a card source fails after retries, the build fails and GitHub Pages keeps serving the
// previous day's site. Individual TCGCSV price groups that fail are skipped with a warning.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Haikyu from './haikyu.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'site', 'data');
const SITE_URL = process.env.SITE_URL || '';
const UA = { 'User-Agent': `Cardlopedia-build/1.0${SITE_URL ? ` (+${SITE_URL})` : ''}`, Accept: 'application/json' };
const ONLY = process.argv.slice(2);      // e.g. `npm run build -- op lor` rebuilds just those parts
const want = (part) => !ONLY.length || ONLY.includes(part);

// ---------- Helpers ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let warnings = 0;

// TCGCSV listings for the smaller games are used twice per build (new-card fill-in, then
// prices), so keep them for the run. Magic, Pokémon and Yu-Gi-Oh! are too big to hold.
const tcgcsvCache = new Map();
const CACHED_CATEGORIES = /^https:\/\/tcgcsv\.com\/tcgplayer\/(63|68|71|79|89|92)\//;
function getJSON(url, opts = {}) {
  if (!CACHED_CATEGORIES.test(url) || opts.body) return fetchJSON(url, opts);
  if (!tcgcsvCache.has(url)) tcgcsvCache.set(url, fetchJSON(url, opts).catch((e) => { tcgcsvCache.delete(url); throw e; }));
  return tcgcsvCache.get(url);
}

async function fetchJSON(url, { tries = 3, timeout = 90e3, method = 'GET', body } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method, body, signal: AbortSignal.timeout(timeout),
        headers: body ? { ...UA, 'Content-Type': 'application/json' } : UA,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= tries) throw new Error(`${url}: ${e.message}`);
      await sleep(1500 * attempt ** 2);
    }
  }
}

// Run fn over items with at most n requests in flight.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

let bytes = 0;
async function write(rel, data) {
  const file = path.join(OUT, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(data);
  await fs.writeFile(file, text);
  bytes += text.length;
  return text.length;
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const clean = (o) => o.filter(([, v]) => v !== null && v !== undefined && v !== '');
const num = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : +v);
const asList = (v) => [].concat(v ?? []).filter((x) => x !== null && x !== undefined && x !== '');
const field = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });

function sortOptions(values, order) {
  const uniq = [...new Set(values.filter((v) => v !== null && v !== undefined && v !== '').map(String))];
  if (order === 'seen') return uniq;
  const known = (order || []).filter((o) => uniq.includes(o));
  const rest = uniq.filter((v) => !known.includes(v));
  const numeric = rest.every((v) => !isNaN(+v));
  rest.sort(numeric ? (a, b) => a - b : (a, b) => a.localeCompare(b));
  return [...known, ...rest];
}

// ---------- Card mappers: source shape -> Cardlopedia shape ----------

const opCard = (c, i) => ({
  id: `${c.card_image_id || c.card_set_id}-${i}`, name: c.card_name,
  image: c.card_image, large: c.card_image,
  type: [c.card_type, c.card_color].filter(Boolean).join(' — '), text: c.card_text,
  set: c.set_name, number: c.card_set_id, rarity: c.rarity,
  stats: clean([['Cost', c.card_cost], ['Power', c.card_power], ['Counter', c.counter_amount],
    ['Life', c.life], ['Attribute', c.attribute], ['Type', c.sub_types]]),
  tcg: { num: c.card_set_id, name: c.card_name },
});

const lorCard = (c) => ({
  id: c.Unique_ID, name: c.Name, image: c.Image, large: c.Image,
  type: [c.Type, c.Classifications].filter(Boolean).join(' — '),
  text: [c.Body_Text, c.Flavor_Text && `“${c.Flavor_Text.replace(/^"|"$/g, '')}”`].filter(Boolean).join('\n\n'),
  set: c.Set_Name, number: c.Unique_ID, rarity: c.Rarity, artist: c.Artist,
  stats: clean([['Ink', c.Color], ['Cost', c.Cost], ['Inkable', c.Inkable ? 'Yes' : 'No'],
    ['Strength', c.Strength], ['Willpower', c.Willpower], ['Lore', c.Lore]]),
  tcg: { set: c.Set_Name, num: c.Card_Num, name: c.Name },
});

const dgmCard = (c) => ({
  id: c.id, name: c.name,
  image: `https://images.digimoncard.io/images/cards/${c.id}.jpg`,
  large: `https://images.digimoncard.io/images/cards/${c.id}.jpg`,
  type: [c.type, c.color, c.color2].filter(Boolean).join(' — '),
  text: [c.main_effect, c.source_effect && `Inherited: ${c.source_effect}`].filter(Boolean).join('\n\n'),
  number: c.id, set: c.set_name?.[0], rarity: c.rarity?.toUpperCase(), artist: c.artist,
  stats: clean([['Level', c.level], ['Play cost', c.play_cost], ['DP', c.dp],
    ['Digivolve', c.evolution_cost ? `${c.evolution_cost} from ${c.evolution_color} Lv${c.evolution_level ?? ''}` : null],
    ['Attribute', c.attribute], ['Type', c.digi_type]]),
  tcg: { num: c.id, name: c.name },
});

const rbCard = (c) => ({
  id: c.id, name: c.name, image: c.media?.image_url, large: c.media?.image_url,
  landscape: c.orientation === 'landscape',
  type: [c.classification?.supertype, c.classification?.type, c.tags?.join(', ')].filter(Boolean).join(' — '),
  text: [c.text?.plain, c.text?.flavour && `“${c.text.flavour}”`].filter(Boolean).join('\n\n'),
  set: c.set?.label, number: c.riftbound_id?.split('-').slice(0, 2).join('-').toUpperCase(),
  rarity: c.classification?.rarity, artist: c.media?.artist,
  stats: clean([['Domain', c.classification?.domain?.join(', ')], ['Energy', c.attributes?.energy],
    ['Might', c.attributes?.might], ['Power', c.attributes?.power]]),
  tcg: { pid: c.tcgplayer_id, set: c.set?.label, num: c.collector_number, name: c.name },
});

// Cyberpunk image links are signed and expire within a day, so the browser refreshes them
// live from NetDeck (see site/engine.js); the ones stored here are only a fallback.
const cpCard = (c) => ({
  id: c.printing_id || c.id, name: c.display_name || c.name, image: c.image_url, large: c.image_url,
  type: [c.card_type, c.classifications?.join(', ')].filter(Boolean).join(' — '),
  text: [c.official_rules_text_en || c.rules_text, c.flavor_text && `“${c.flavor_text}”`].filter(Boolean).join('\n\n'),
  set: c.set?.name, number: c.print_number, rarity: c.rarity, artist: c.artist,
  stats: clean([['Color', c.color], ['Cost', c.cost], ['Power', c.power], ['RAM', c.ram],
    ['Eddiable', c.is_eddiable == null ? null : c.is_eddiable ? 'Yes' : 'No'], ['Keywords', c.keywords?.join(', ')]]),
  link: c.slug ? `https://cyberpunktcg.com/cards/${c.slug}` : null,
  tcg: { set: c.set?.name, num: c.print_number, name: c.display_name || c.name },
});

const swuCard = (c) => ({
  id: `${c.Set}-${c.Number}`, name: c.Subtitle ? `${c.Name}, ${c.Subtitle}` : c.Name,
  image: c.FrontArt, large: c.FrontArt, landscape: c.Type === 'Leader' || c.Type === 'Base',
  type: [c.Type, c.Traits?.join(', ')].filter(Boolean).join(' — '),
  text: [c.FrontText, c.EpicAction, c.BackText && `Back: ${c.BackText}`].filter(Boolean).join('\n\n'),
  set: c.SetName || c.Set, number: c.Number, rarity: c.Rarity, artist: c.Artist,
  stats: clean([['Cost', c.Cost], ['Power', c.Power], ['HP', c.HP],
    ['Aspects', c.Aspects?.join(', ')], ['Arena', c.Arenas?.join(', ')]]),
  link: `https://www.swu-db.com/card/${c.Set}/${c.Number}`,
  tcg: { set: c.Set, num: c.Number, name: c.Subtitle ? `${c.Name} - ${c.Subtitle}` : c.Name },
});

// Haikyu!! Vobaca!! BREAK: Takara Tomy's official card list, in Japanese, translated with
// scripts/haikyu.mjs. Cards missing a translation keep their Japanese and are logged.
const HV_LIST = 'https://www.takaratomy.co.jp/products/haikyuvobacabreak/cardlist/';
const hvMissing = new Set();
function hvCard(c) {
  const tr = (jp, fn) => {
    if (!jp || jp.trim() === '-') return '';
    const en = fn(jp);
    if (en === null || en === undefined) { hvMissing.add(Haikyu.norm(jp).slice(0, 60)); return null; }
    return en;
  };
  const name = tr(c.name, Haikyu.translateName);
  const skill = tr(c.skill, Haikyu.translateText);
  const note = tr(c.annotation, Haikyu.translateText);
  const { rarity, version } = Haikyu.rarityOf(c.vobarity);
  const positions = Haikyu.positionsOf(c.position);
  const stat = (v) => (v === '' || v === '-' || v == null ? null : v);
  const jpText = [c.skill, c.annotation].filter((t) => t && t.trim() !== '-').map(Haikyu.norm).join('\n\n');
  return {
    id: `${c.card_no}-${c.image_end}`, name: name ?? c.name,
    image: `${HV_LIST}card/${c.card_no}-${c.image_end}.webp`, large: `${HV_LIST}card/${c.card_no}-${c.image_end}.webp`,
    type: [c.category === 'EVENT' ? 'Event' : 'Character', positions.join(', ')].filter(Boolean).join(' — '),
    text: [skill ?? Haikyu.norm(c.skill), note === null ? Haikyu.norm(c.annotation) : note && `(${note})`].filter(Boolean).join('\n\n'),
    set: Haikyu.productOf(c.product_type, c.product_name), number: c.card_no,
    rarity: version === 'Regular' ? rarity : `${rarity} · ${version}`, artist: c.illustrator,
    stats: clean([['Team', Haikyu.translateAffiliation(c.affiliation)], ['Serve', stat(c.serve)], ['Block', stat(c.block)],
      ['Receive', stat(c.receive)], ['Toss', stat(c.toss)], ['Attack', stat(c.attack)]]),
    link: `${HV_LIST}card.html?no=${encodeURIComponent(c.card_no)}&voba=${encodeURIComponent(c.vobarity)}`,
    // Shown under "Original Japanese" in the card window, so players can check the translation.
    jp: { name: c.name, text: jpText, team: c.affiliation && c.affiliation !== '-' ? c.affiliation : '' },
    untranslated: name === null || skill === null || note === null || undefined,
  };
}

// ---------- Local catalogs: fetched here, filtered in the browser ----------

const OP_ORDER = ['OP', 'EB', 'PRB', 'ST'];
function opSort(a, b) {
  const [pa, na] = [a.card_set_id.replace(/\d.*/, ''), parseInt(a.card_set_id.replace(/^\D+/, ''))];
  const [pb, nb] = [b.card_set_id.replace(/\d.*/, ''), parseInt(b.card_set_id.replace(/^\D+/, ''))];
  const oa = OP_ORDER.indexOf(pa), ob = OP_ORDER.indexOf(pb);
  return (oa < 0 ? 9 : oa) - (ob < 0 ? 9 : ob) || nb - na || a.card_set_id.localeCompare(b.card_set_id);
}
const OP_COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'];

// One Piece block icons (the rotation marker printed on each card) aren't in the card API, so
// read them from Bandai's official card list: one page per product. Returns
// card number -> block ("1".."5", or "X" for cards legal in every block). A card number printed
// with several icons (reprints, block updates) takes the newest, since any legal printing makes
// the card legal. If the official site can't be read, the Block filter is left out for the day.
const OFFICIAL_OP = 'https://en.onepiece-cardgame.com/cardlist/';
const blockRank = (b) => (b === 'X' ? 1e6 : Number(b) || -1);
let opBlocks = new Map();

async function loadOpBlocks() {
  const page = async (url) => {
    const res = await fetch(url, { headers: { ...UA, Accept: 'text/html' }, signal: AbortSignal.timeout(60e3) });
    if (!res.ok) throw new Error(`official card list answered ${res.status}`);
    return res.text();
  };
  try {
    const index = await page(OFFICIAL_OP);
    const series = [...new Set([...index.matchAll(/<option value="(\d{6})"/g)].map((m) => m[1]))];
    if (!series.length) throw new Error('no products found on the official card list');
    const pages = await pool(series, 2, (id) => page(`${OFFICIAL_OP}?series=${id}`));
    const blocks = new Map();
    const re = /<dl class="modalCol" id="([^"]+)">[\s\S]*?<div class="block"><h3>[\s\S]*?<\/h3>([^<]*)<\/div>/g;
    for (const html of pages) {
      for (const [, id, value] of html.matchAll(re)) {
        const num = id.replace(/_.*$/, '').toUpperCase();   // OP01-016_p1 -> OP01-016
        const b = value.trim().toUpperCase();
        if (!/^(\d+|X)$/.test(b)) continue;
        if (!blocks.has(num) || blockRank(b) > blockRank(blocks.get(num))) blocks.set(num, b);
      }
    }
    const overrides = await loadOpBlockOverrides(page);
    for (const [num, b] of overrides) blocks.set(num, b);
    opBlocks = blocks;
    log(`one piece blocks: ${blocks.size} card numbers from ${series.length} products, ${overrides.size} official overrides`);
  } catch (e) {
    warnings++;
    console.warn(`  warn: One Piece block icons unavailable, Block filter skipped: ${e.message}`);
  }
}

// Bandai's "Overview of Cards Subject to Block Number Updates" overrides printed icons:
// cards "generally permitted in Standard" (treated here as X) and cards that belong to a named
// block "regardless of reprints". Returns card number -> block. Missing page = no overrides.
async function loadOpBlockOverrides(page) {
  const out = new Map();
  try {
    const html = await page('https://en.onepiece-cardgame.com/rules/blockicon-card/');
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const circled = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9' };
    // Split the page at its section headings, then take every card number inside each section.
    const heads = [...text.matchAll(/Cards Generally Permitted in Standard Regulation|Cards Eligible for Use Under Block Number\s*([①-⑨]|\d+)|Updated Block Number and cards|RELATED PAGE/g)];
    heads.forEach((h, i) => {
      const block = /Generally Permitted/.test(h[0]) ? 'X' : h[1] ? circled[h[1]] || h[1] : null;
      if (!block) return;
      const section = text.slice(h.index + h[0].length, heads[i + 1]?.index ?? text.length);
      for (const [num] of section.matchAll(/\b[A-Z]{1,4}\d{0,2}-\d{3}\b/g)) out.set(num, block);
    });
    if (!out.size) throw new Error('no cards found on the block number page');
  } catch (e) {
    warnings++;
    console.warn(`  warn: official block overrides unavailable, using printed icons only: ${e.message}`);
  }
  return out;
}
const opBlock = (r) => opBlocks.get(String(r.card_set_id || '').replace(/_.*$/, '').toUpperCase()) || null;
const OP_ATTRS = ['Strike', 'Slash', 'Ranged', 'Special', 'Wisdom'];

// Each game: load() -> raw cards in browse order; card(raw, i); searchable(raw) for the name box;
// fields with get(raw) -> facet values. `norm` names a text normalizer the browser applies.
const LOCAL = {
  op: {
    async load() {
      const [sets, starters] = await Promise.all([
        getJSON('https://optcgapi.com/api/allSetCards/'), getJSON('https://optcgapi.com/api/allSTCards/'), loadOpBlocks()]);
      return [...(sets || []), ...(starters || [])].filter((c) => c.card_set_id).sort(opSort);
    },
    card: (raw, i) => {
      const card = opCard(raw, i);
      const b = opBlock(raw);
      if (b) card.stats.push(['Block', b === 'X' ? 'X (always legal)' : b]);
      return card;
    },
    searchable: (r) => [r.card_name, r.card_set_id],
    fields: [
      field('color', 'Color', 'multi', { get: (r) => r.card_color?.split(/[\s/]+/).filter((c) => OP_COLORS.includes(c)), order: OP_COLORS }),
      // Deck building around a Leader (Comprehensive Rules 5-1-2-1, 5-1-2-2 and 2-3-5): only
      // Characters, Events and Stages, and every color on the card must be one of the Leader's.
      field('leader', 'Leader colors', 'within', {
        get: (r) => r.card_color?.split(/[\s/]+/).filter((c) => OP_COLORS.includes(c)), order: OP_COLORS,
        onlyTypes: ['Character', 'Event', 'Stage'], typeKey: 'type', describeAs: 'all',
        help: 'Pick your Leader’s colors. Shows only Characters, Events and Stages you can put in that Leader’s deck.',
      }),
      field('type', 'Card type', 'select', { get: (r) => r.card_type, order: ['Leader', 'Character', 'Event', 'Stage'] }),
      field('cost', 'Cost', 'range', { get: (r) => r.card_cost }),
      field('power', 'Power', 'range', { get: (r) => r.card_power }),
      field('counter', 'Counter', 'select', { get: (r) => (num(r.counter_amount) ? r.counter_amount : null) }),
      field('attribute', 'Attribute', 'select', { get: (r) => r.attribute?.split(/[\s/]+/).filter((a) => OP_ATTRS.includes(a)), order: OP_ATTRS }),
      field('subtypes', 'Type', 'text', { get: (r) => r.sub_types, placeholder: 'e.g. Straw Hat Crew' }),
      field('text', 'Effect text', 'text', { get: (r) => r.card_text, norm: 'opDon', placeholder: 'e.g. don x1, On Play' }),
      field('set', 'Set', 'combo', { get: (r) => r.set_name, order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => r.rarity, order: ['C', 'UC', 'R', 'SR', 'SEC', 'L', 'SP', 'TR', 'PR'] }),
      // "exclude" chips hide cards with the chosen values. Block X cards are never hidden.
      field('block', 'Exclude blocks', 'exclude', {
        get: (r) => { const b = opBlock(r); return b && b !== 'X' ? b : null; },
        labels: { prefix: 'Block ' },
        help: 'Hides cards from rotated blocks. Cards reprinted in a newer block, and Block X cards, stay.',
      }),
    ],
  },
  lor: {
    async load() {
      const r = await getJSON('https://api.lorcana-api.com/cards/all');
      return Array.isArray(r) ? r : [];
    },
    card: lorCard,
    searchable: (r) => [r.Name, r.Unique_ID],
    fields: [
      field('ink', 'Ink', 'multi', { get: (r) => r.Color?.split(/,\s*/), order: ['Amber', 'Amethyst', 'Emerald', 'Ruby', 'Sapphire', 'Steel'] }),
      field('type', 'Card type', 'select', { get: (r) => r.Type, order: ['Character', 'Action', 'Action - Song', 'Item', 'Location'] }),
      field('cost', 'Cost', 'range', { get: (r) => r.Cost }),
      field('inkable', 'Inkable', 'select', { get: (r) => (r.Inkable ? 'Yes' : 'No'), order: ['Yes', 'No'] }),
      field('strength', 'Strength', 'range', { get: (r) => r.Strength }),
      field('willpower', 'Willpower', 'range', { get: (r) => r.Willpower }),
      field('lore', 'Lore', 'range', { get: (r) => r.Lore }),
      field('class', 'Classification', 'combo', { get: (r) => r.Classifications?.split(/,\s*/) }),
      field('text', 'Card text', 'text', { get: (r) => r.Body_Text, placeholder: 'e.g. Singer' }),
      field('set', 'Set', 'select', { get: (r) => r.Set_Name, order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => r.Rarity, order: ['Common', 'Uncommon', 'Rare', 'Super Rare', 'Legendary', 'Epic', 'Enchanted', 'Iconic'] }),
    ],
  },
  dgm: {
    async load() {
      const r = await getJSON('https://digimoncard.io/api-public/search?series=Digimon%20Card%20Game&sort=name');
      return Array.isArray(r) ? r : [];
    },
    card: dgmCard,
    searchable: (r) => [r.name, r.id],
    fields: [
      field('color', 'Color', 'multi', { get: (r) => [r.color, r.color2], order: ['Red', 'Blue', 'Yellow', 'Green', 'Black', 'Purple', 'White'] }),
      field('type', 'Card type', 'select', { get: (r) => r.type, order: ['Digimon', 'Digi-Egg', 'Tamer', 'Option'] }),
      field('level', 'Level', 'select', { get: (r) => r.level }),
      field('cost', 'Play cost', 'range', { get: (r) => r.play_cost }),
      field('dp', 'DP', 'range', { get: (r) => r.dp }),
      field('attribute', 'Attribute', 'select', { get: (r) => r.attribute?.replace(/[^\w\s-]/g, '').trim() }),
      field('digitype', 'Digimon type', 'combo', { get: (r) => [r.digi_type, r.digi_type2, r.digi_type3, r.digi_type4, r.digi_type5].filter((t) => t && isNaN(+t)) }),
      field('text', 'Effect text', 'text', { get: (r) => [r.main_effect, r.source_effect], placeholder: 'e.g. Blocker' }),
      field('set', 'Set', 'combo', { get: (r) => r.set_name }),
      field('rarity', 'Rarity', 'select', { get: (r) => (r.rarity && r.rarity !== 'Unknown' ? r.rarity.toUpperCase() : null), order: ['C', 'U', 'R', 'SR', 'SEC', 'P'] }),
    ],
  },
  rb: {
    async load() {
      const first = await getJSON('https://api.riftcodex.com/cards?size=100&page=1');
      const rest = await pool(Array.from({ length: Math.max(0, (first?.pages || 1) - 1) }, (_, i) => i + 2), 4,
        (p) => getJSON(`https://api.riftcodex.com/cards?size=100&page=${p}`));
      return [first, ...rest].flatMap((r) => r?.items || []);
    },
    card: rbCard,
    searchable: (r) => [r.name, r.riftbound_id],
    fields: [
      field('domain', 'Domain', 'multi', { get: (r) => r.classification?.domain, order: ['Fury', 'Calm', 'Mind', 'Body', 'Chaos', 'Order', 'Colorless'] }),
      field('type', 'Card type', 'select', { get: (r) => r.classification?.type, order: ['Legend', 'Unit', 'Spell', 'Gear', 'Rune', 'Battlefield'] }),
      field('supertype', 'Supertype', 'select', { get: (r) => r.classification?.supertype }),
      field('energy', 'Energy', 'range', { get: (r) => r.attributes?.energy }),
      field('might', 'Might', 'range', { get: (r) => r.attributes?.might }),
      field('power', 'Power', 'range', { get: (r) => r.attributes?.power }),
      field('tag', 'Tag', 'combo', { get: (r) => r.tags }),
      field('text', 'Card text', 'text', { get: (r) => r.text?.plain, placeholder: 'e.g. conquer' }),
      field('set', 'Set', 'select', { get: (r) => r.set?.label, order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => r.classification?.rarity, order: ['Common', 'Uncommon', 'Rare', 'Epic', 'Showcase', 'Promo'] }),
    ],
  },
  cp: {
    async load() {
      const url = (offset) => `https://api.netdeck.gg/api/cards/cyberpunk?language=en&limit=100&offset=${offset}`;
      const first = await getJSON(url(0));
      const rest = await pool(Array.from({ length: Math.max(0, Math.ceil((first?.total || 0) / 100) - 1) }, (_, i) => (i + 1) * 100), 3,
        (o) => getJSON(url(o)));
      return [first, ...rest].flatMap((r) => r?.items || []);
    },
    card: cpCard,
    searchable: (r) => [r.display_name, r.name, r.print_number],
    fields: [
      field('color', 'Color', 'multi', { get: (r) => r.color }),
      field('type', 'Card type', 'select', { get: (r) => r.card_type, order: ['Legend', 'Unit', 'Gear', 'Program'] }),
      field('cost', 'Cost', 'range', { get: (r) => r.cost }),
      field('power', 'Power', 'range', { get: (r) => r.power }),
      field('ram', 'RAM', 'range', { get: (r) => r.ram }),
      field('eddiable', 'Eddiable', 'select', { get: (r) => (r.is_eddiable == null ? null : r.is_eddiable ? 'Yes' : 'No'), order: ['Yes', 'No'] }),
      field('class', 'Classification', 'select', { get: (r) => r.classifications }),
      field('keyword', 'Keyword', 'select', { get: (r) => r.keywords }),
      field('text', 'Rules text', 'text', { get: (r) => r.official_rules_text_en || r.rules_text, placeholder: 'e.g. Trash' }),
      field('set', 'Set', 'select', { get: (r) => r.set?.name, order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => r.rarity, order: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'] }),
    ],
  },
  hv: {
    async load() {
      const page = (p) => getJSON(`${HV_LIST}itemsearch.php?p=${p}`);
      const first = await page(1);
      const pages = Math.ceil((first?.count || 0) / Math.max(1, first?.items?.length || 1));
      const rest = await pool(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2), 3, page);
      const cards = [first, ...rest].flatMap((r) => r?.items || []);
      if (hvMissing.size) hvMissing.clear();
      return cards;
    },
    card: hvCard,
    searchable: (r) => [r.name, r.name_ruby?.replace(/\s+/g, ''), Haikyu.translateName(r.name), r.card_no],
    fields: [
      field('position', 'Position', 'multi', { get: (r) => Haikyu.positionsOf(r.position),
        order: ['WS', 'MB', 'S', 'Li', 'OP', 'Head Coach', 'Former Head Coach', 'Coach', 'Manager', 'Cheer Captain', 'Cheer Squad', 'Ball Boy', 'Mascot'] }),
      field('team', 'Team', 'select', { get: (r) => Haikyu.teamsOf(r.affiliation),
        order: ['Karasuno', 'Nekoma', 'Aoba Johsai', 'Fukurodani', 'Date Tech', 'Shiratorizawa', 'Inarizaki', 'Kamomedai', 'Itachiyama', 'Nohebi'] }),
      field('year', 'Year', 'select', { get: (r) => Haikyu.yearsOf(r.affiliation), order: ['1st-year', '2nd-year', '3rd-year'] }),
      field('squad', 'Squad', 'select', { get: (r) => Haikyu.squadsOf(r.affiliation) }),
      field('type', 'Card type', 'select', { get: (r) => (r.category === 'EVENT' ? 'Event' : 'Character'), order: ['Character', 'Event'] }),
      field('serve', 'Serve', 'range', { get: (r) => r.serve }),
      field('block', 'Block', 'range', { get: (r) => r.block }),
      field('receive', 'Receive', 'range', { get: (r) => r.receive }),
      field('toss', 'Toss', 'range', { get: (r) => r.toss }),
      field('attack', 'Attack', 'range', { get: (r) => r.attack }),
      field('text', 'Card text', 'text', { get: (r) => [Haikyu.translateText(r.skill), Haikyu.translateText(r.annotation), r.skill, r.annotation],
        placeholder: 'e.g. Kill Block, draw 1 card' }),
      field('set', 'Set', 'select', { get: (r) => Haikyu.productOf(r.product_type, r.product_name), order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => Haikyu.rarityOf(r.vobarity).rarity,
        order: ['Ultimate (極)', 'Secret (秘)', 'Pinnacle (頂)', 'S', 'R', 'N', 'Deck (D)', 'Promo (P)'] }),
      field('version', 'Version', 'select', { get: (r) => Haikyu.rarityOf(r.vobarity).version, order: ['Regular', 'Parallel', 'Alt Art'] }),
    ],
  },
  swu: {
    async load() {
      const sets = (await getJSON('https://api.swu-db.com/sets?format=json')) || [];
      const base = sets.filter((s) => s.isBaseSet).sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
      const lists = await pool(base, 3, (s) => getJSON(`https://api.swu-db.com/cards/${s.setId.toLowerCase()}?format=json`));
      const names = new Map(sets.map((s) => [s.setId, s.fullName]));
      return lists.flatMap((r) => (r?.data || []).filter((c) => c.VariantType === 'Normal' || !c.VariantType))
        .map((c) => ({ ...c, SetName: names.get(c.Set) || c.Set }));
    },
    card: swuCard,
    searchable: (r) => [r.Name, r.Subtitle, `${r.Set}-${r.Number}`],
    fields: [
      field('aspect', 'Aspect', 'multi', { get: (r) => r.Aspects, order: ['Vigilance', 'Command', 'Aggression', 'Cunning', 'Heroism', 'Villainy'] }),
      field('type', 'Card type', 'select', { get: (r) => r.Type, order: ['Leader', 'Base', 'Unit', 'Event', 'Upgrade'] }),
      field('cost', 'Cost', 'range', { get: (r) => r.Cost }),
      field('power', 'Power', 'range', { get: (r) => r.Power }),
      field('hp', 'HP', 'range', { get: (r) => r.HP }),
      field('arena', 'Arena', 'select', { get: (r) => r.Arenas, order: ['Ground', 'Space'] }),
      field('trait', 'Trait', 'combo', { get: (r) => r.Traits }),
      field('text', 'Card text', 'text', { get: (r) => [r.FrontText, r.BackText, r.EpicAction], placeholder: 'e.g. Sentinel' }),
      field('set', 'Set', 'select', { get: (r) => r.SetName, order: 'seen' }),
      field('rarity', 'Rarity', 'select', { get: (r) => r.Rarity, order: ['Common', 'Uncommon', 'Rare', 'Legendary', 'Special'] }),
    ],
  },
};

// ---------- Newly revealed cards from TCGplayer ----------
// Fan databases often add a new set days or weeks after its cards are revealed, while
// TCGplayer lists them right away. For each smaller game, any TCGplayer set published in the
// last SUPPLEMENT_DAYS that the fan database doesn't have yet is added from TCGplayer's own
// card details (via TCGCSV), converted into that database's format so every filter works.
// Once the fan database adds the set, it's detected as present and the fill-in stops.

const SUPPLEMENT_DAYS = 150;
const tcgText = (html = '') => String(html).replace(/\r/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/[ \t]+\n/g, '\n').trim();
const tcgList = (v) => (v ? String(v).split(/\s*;\s*/).filter(Boolean) : []);
const tcgNum = (v) => (v == null || v === '' ? null : num(String(v).replace(/^[^\d-]+/, '')));
const looseName = (s = '') => String(s).toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
const baseNumber = (s = '') => String(s).trim().replace(/\s*-\s*/g, '-').split(/\s+/)[0].replace(/_[a-z]\d+$/i, '').toUpperCase();

// How to read each game's TCGplayer listing. present(raws) builds a test for whether the fan
// database already has a TCGplayer set; raw(product, ext, group) converts one card.
const TCG_FILL = {
  op: {
    byNumber: true,
    present: (raws) => { const nums = new Set(raws.map((r) => baseNumber(r.card_set_id))); return (p) => nums.has(baseNumber(p.ext.Number)); },
    raw: (p, x, g) => ({
      card_name: p.name, card_set_id: baseNumber(x.Number), card_image_id: `tcg-${p.productId}`,
      card_text: tcgText(x.Description), card_color: tcgList(x.Color).join(' '), card_type: x.CardType,
      card_cost: tcgNum(x.Cost), card_power: tcgNum(x.Power), counter_amount: tcgNum(x.Counterplus),
      life: tcgNum(x.Life), attribute: tcgList(x.Attribute).join(' '), sub_types: tcgList(x.Subtypes).join(' '),
      rarity: x.Rarity, set_name: g.name,
    }),
  },
  dgm: {
    byNumber: true,
    present: (raws) => { const nums = new Set(raws.map((r) => baseNumber(r.id))); return (p) => nums.has(baseNumber(p.ext.Number)); },
    raw: (p, x, g) => {
      const colors = tcgList(x.Color);
      return {
        id: baseNumber(x.Number), name: p.name, type: x.CardType, color: colors[0], color2: colors[1] || null,
        level: tcgNum(String(x.LevelLv || '').replace(/\D+/g, '') || null), play_cost: tcgNum(x.PlayCost), dp: tcgNum(x.DigimonPowerDP),
        evolution_cost: tcgNum(x.Digivolve1Cost), evolution_color: x.Digivolve1Color, evolution_level: tcgNum(x.Digivolve1Level),
        attribute: x.DigimonAttribute, digi_type: x.DigimonType,
        main_effect: [tcgText(x.Description), tcgText(x['Security Effect'])].filter(Boolean).join('\n'),
        source_effect: tcgText(x['Inherited Effect']), set_name: [g.name], rarity: x.Rarity,
      };
    },
  },
  lor: {
    present: (raws) => { const names = new Set(raws.map((r) => looseName(r.Name))); return (p) => names.has(looseName(p.name)); },
    raw: (p, x, g) => {
      const n = String(x.Number || '').split('/')[0];
      return {
        Name: p.name, Unique_ID: `${g.abbreviation || 'NEW'}-${n.padStart(3, '0')}`, Card_Num: num(n), Set_Name: g.name,
        Type: x.CardType, Classifications: tcgList(x.Classification).join(', '), Body_Text: tcgText(x.Description),
        Flavor_Text: tcgText(x['Flavor Text']), Rarity: x.Rarity, Color: tcgList(x.InkType).join(', '),
        Cost: tcgNum(x['Cost Ink']), Inkable: x.InkwellIcononCard === 'Yes', Strength: tcgNum(x.Strength),
        Willpower: tcgNum(x.Willpower), Lore: tcgNum(x['Lore Value']),
      };
    },
  },
  rb: {
    present: (raws) => { const names = new Set(raws.map((r) => looseName(r.name))); return (p) => names.has(looseName(p.name)); },
    raw: (p, x, g) => {
      const [n, total] = String(x.Number || '').split('/');
      return {
        id: `tcg-${p.productId}`, name: p.name, tcgplayer_id: String(p.productId), collector_number: num(n),
        riftbound_id: `${(g.abbreviation || 'new').toLowerCase()}-${n}-${total || ''}`,
        orientation: x['Card Type'] === 'Battlefield' ? 'landscape' : 'portrait',
        classification: { type: x['Card Type'], rarity: x.Rarity, domain: tcgList(x.Domain), supertype: null },
        attributes: { energy: tcgNum(x['Energy Cost']), might: tcgNum(x.Might), power: tcgNum(x['Power Cost']) },
        text: { plain: tcgText(x.Description), flavour: tcgText(x['Flavor Text']) || null },
        set: { label: g.name }, tags: tcgList(x.Tag), media: {},
      };
    },
  },
  cp: {
    present: (raws) => { const names = new Set(raws.map((r) => looseName(r.display_name || r.name))); return (p) => names.has(looseName(p.name)); },
    raw: (p, x, g) => ({
      printing_id: `tcg-${p.productId}`, display_name: p.name.replace(/\s+\([^)]*\)$/, ''), name: p.name,
      card_type: x.CardType, color: x.Color, cost: tcgNum(x.Cost), power: tcgNum(x.Power),
      ram: tcgNum(String(x.RAM || '').replace(/^x/i, '')), is_eddiable: x.Eddies == null ? null : /true/i.test(x.Eddies),
      classifications: tcgList(x.Tags), keywords: [], official_rules_text_en: tcgText(x.Description),
      set: { name: g.name }, print_number: x.Number, rarity: x.Rarity,
    }),
  },
  swu: {
    present: (raws) => { const names = new Set(raws.map((r) => looseName(`${r.Name} ${r.Subtitle || ''}`))); return (p) => names.has(looseName(p.name)); },
    raw: (p, x, g) => {
      const [name, subtitle] = p.name.split(/\s+-\s+/);
      return {
        Set: g.abbreviation || g.name, SetName: g.name, Number: x.Number, Name: name, Subtitle: subtitle || null,
        Type: x.CardType, Traits: tcgList(x.Traits), Aspects: tcgList(x.Aspect), Arenas: tcgList(x['Arena Type']),
        Cost: tcgNum(x.Cost), Power: tcgNum(x.Power), HP: tcgNum(x.HP), FrontText: tcgText(x.Description), Rarity: x.Rarity,
      };
    },
  },
};

async function tcgFillIn(game, raws) {
  const fill = TCG_FILL[game];
  if (!fill) return [];
  const cat = CATEGORY[game];
  const cutoff = Date.now() - SUPPLEMENT_DAYS * 864e5;
  const groups = ((await getJSON(`${TCGCSV}/${cat}/groups`))?.results || [])
    .filter((g) => Date.parse(g.publishedOn) >= cutoff)
    .sort((a, b) => b.publishedOn.localeCompare(a.publishedOn));            // newest first
  const isPresent = fill.present(raws);
  const extra = [];
  const added = [];
  for (const g of groups) {
    const products = ((await getJSON(`${TCGCSV}/${cat}/${g.groupId}/products`))?.results || [])
      .map((p) => ({ ...p, ext: Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value])) }))
      .filter((p) => p.ext.Number);                                          // cards only, not sealed product
    if (!products.length) continue;
    // A set the fan database has (most of its cards match) is left alone, except that games
    // matched by card number still get the newly revealed cards the database hasn't added yet.
    // (Name matching is too loose for that: "Judy Álvarez" vs "Judy Alvarez" would duplicate.)
    let wanted = products;
    if (products.filter(isPresent).length >= products.length / 2) {
      if (!fill.byNumber) continue;
      wanted = products.filter((p) => !isPresent(p));
      if (!wanted.length) continue;
    }
    for (const p of wanted) {
      const raw = fill.raw(p, p.ext, g);
      // Revealed cards often have no image on TCGplayer yet (imageCount 0); the site then shows
      // a placeholder, and a later daily build picks the image up once it's posted.
      const img = (p.imageUrl || `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_200w.jpg`).replace(/_\d+w\.jpg$/, '');
      const hasImage = p.imageCount > 0;
      raw._tcg = { productId: p.productId, image: hasImage ? `${img}_400w.jpg` : null, large: hasImage ? `${img}_in_1000x1000.jpg` : null, set: g.name };
      extra.push(raw);
    }
    if (fill.art) await fill.art(g, extra.filter((r) => r._tcg.set === g.name && !r._tcg.image));
    added.push(wanted === products ? `${g.name} (${products.length})` : `${g.name} (${wanted.length} new cards)`);
  }
  if (added.length) log(`  ${game}: added from TCGplayer, not yet in the fan database: ${added.join(', ')}`);
  return extra;
}

// One Piece reveals reach TCGplayer as text-only presale listings, but One Piece Top Decks posts
// each set's revealed card art (named by card number, e.g. EB05-006.jpg, EB05-006_p2.jpg for its
// parallel) on a "full card list" page. Use that art for cards TCGplayer has no image for yet.
// Parallels are only matched when there's exactly one, so a card never shows the wrong version.
const OPTD = 'https://onepiecetopdecks.com';
let optdPages = null;
async function opTopDecksArt(group, cards) {
  if (!cards.length || !group.abbreviation) return;
  const text = async (url, tries = 3) => {
    const res = await fetch(url, { headers: { ...UA, Accept: 'text/html,application/xml' }, signal: AbortSignal.timeout(60e3) }).catch((e) => ({ ok: false, status: e.message }));
    if (res.ok) return res.text();
    if (tries > 1) { await new Promise((r) => setTimeout(r, 5e3)); return text(url, tries - 1); }
    throw new Error(`${url} answered ${res.status}`);
  };
  try {
    optdPages ??= (await Promise.all(['page', 'post'].map((t) => text(`${OPTD}/wp-sitemap-posts-${t}-1.xml`))))
      .flatMap((xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
    const code = group.abbreviation.toLowerCase().replace(/[^a-z0-9]/g, '');
    const url = optdPages.find((u) => u.includes(`/cards/${code}-cards-`));
    if (!url) return;
    const html = await text(url);
    const art = new Map();                                          // EB05-006_p2 -> image url
    for (const [, src, id] of html.matchAll(/(?:data-)?src="(https:\/\/onepiecetopdecks\.com\/wp-content\/gallery\/[^"]+?\/([A-Z]+\d+-\d+(?:_p\d+)?)\.(?:jpe?g|png|webp))"/gi)) {
      art.set(id.toUpperCase().replace('_P', '_p'), src);
    }
    const variant = (r) => /\((Alternate Art|SP|Manga|Full Art|Treasure[^)]*|[^)]*Parallel[^)]*|Wanted Poster|Gold)\)/i.test(r.card_name)
      || !r.card_set_id.replace(/-.*/, '').toLowerCase().startsWith(code.slice(0, 4));   // reprint from another set
    const byNumber = Map.groupBy(cards, (r) => r.card_set_id);
    let found = 0;
    for (const [n, rs] of byNumber) {
      const regular = rs.filter((r) => !variant(r)), parallels = rs.filter(variant);
      const pics = [...art.keys()].filter((k) => k.startsWith(`${n}_p`));
      const pairs = [];
      if (regular.length === 1 && art.has(n)) pairs.push([regular[0], art.get(n)]);
      if (parallels.length === 1 && pics.length === 1) pairs.push([parallels[0], art.get(pics[0])]);
      for (const [r, src] of pairs) { r._tcg.image = r._tcg.large = src; found++; }
    }
    if (found) log(`    ${group.abbreviation}: ${found} of ${cards.length} images from One Piece Top Decks`);
  } catch (e) {
    console.warn(`  warn: One Piece Top Decks art unavailable for ${group.abbreviation}: ${e.message}`);
  }
}
TCG_FILL.op.art = opTopDecksArt;

// Stores each card with its precomputed facet values (f) and lowercased name/number text (s),
// so the browser can filter without knowing each source's raw format.
// If one game's source is down, keep that game's catalog from the live site instead of
// failing the whole build, so every other game still updates. Needs SITE_URL (set in CI).
async function buildCatalog(game) {
  try {
    await buildCatalogFresh(game);
  } catch (e) {
    if (!SITE_URL) throw e;
    const url = new URL(`data/catalog/${game}.json`, SITE_URL).href;
    const previous = await fetchJSON(url).catch(() => null);
    if (!previous?.cards?.length) throw e;   // nothing to fall back to: fail as before
    warnings++;
    console.warn(`  warn: ${game} source failed (${e.message}); keeping the live site's ${previous.cards.length} cards`);
    await write(`catalog/${game}.json`, previous);
  }
}

// A filled-in card with no art this time keeps the art the live site already shows for it, so
// a source that's briefly unreachable (e.g. One Piece Top Decks) doesn't take images away.
async function keepLiveArt(game, extra) {
  const missing = extra.filter((r) => !r._tcg.image);
  if (!SITE_URL || !missing.length) return;
  const live = await fetchJSON(new URL(`data/catalog/${game}.json`, SITE_URL).href).catch(() => null);
  const art = new Map((live?.cards || []).filter((x) => x.c.preview && x.c.image).map((x) => [x.c.id, x.c]));
  let kept = 0;
  for (const r of missing) {
    const c = art.get(`tcg-${r._tcg.productId}`);
    if (c) { r._tcg.image = c.image; r._tcg.large = c.large || c.image; kept++; }
  }
  if (kept) log(`  ${game}: kept the live site's art for ${kept} newly revealed cards`);
}

async function buildCatalogFresh(game) {
  const def = LOCAL[game];
  const primary = await def.load();
  if (!primary.length) throw new Error(`${game}: the card source returned no cards`);
  // Newly revealed sets from TCGplayer go first, since browsing shows newest first.
  const extra = await tcgFillIn(game, primary);
  await keepLiveArt(game, extra);
  const raws = [...extra, ...primary];
  const cards = raws.map((raw, i) => {
    const f = {};
    for (const fl of def.fields) {
      const vals = asList(fl.get(raw)).map((v) => (fl.kind === 'range' ? num(v) : String(v))).filter((v) => v !== null);
      if (vals.length) f[fl.key] = vals.length === 1 ? vals[0] : vals;
    }
    const c = def.card(raw, i);
    if (raw._tcg) {
      // Filled in from TCGplayer: use its images, and say where the details came from.
      Object.assign(c, { id: `tcg-${raw._tcg.productId}`, image: raw._tcg.image, large: raw._tcg.large, preview: true });
      c.link = `https://www.tcgplayer.com/product/${raw._tcg.productId}`;
    }
    return { c, f, s: def.searchable(raw).filter(Boolean).join('\n').toLowerCase() };
  });
  const fields = def.fields.map(({ get, order, labels, ...fl }) => {
    if (fl.kind === 'range' || fl.kind === 'text') return fl;
    const options = sortOptions(raws.flatMap((r) => asList(get(r))), order);
    return { ...fl, options: labels ? options.map((o) => ({ value: o, label: labels.prefix + o })) : options };
  }).filter((fl) => !fl.options || fl.options.length > (fl.kind === 'exclude' ? 0 : 1));   // hide filters with nothing to choose
  const size = await write(`catalog/${game}.json`, { fields, cards });
  log(`catalog ${game}: ${cards.length} cards, ${kb(size)}`);
  if (game === 'hv') {
    const untranslated = cards.filter((e) => e.c.untranslated).length;
    log(`  haikyu translations: ${cards.length - untranslated} of ${cards.length} cards fully in English`);
    // New cards show in Japanese until scripts/haikyu-en.json gains their names and text.
    for (const jp of hvMissing) console.warn(`  untranslated: ${jp}`);
  }
}

// ---------- Magic, Pokémon, Yu-Gi-Oh!: searched live, but filter options are built here ----------

const MTG_FORMATS = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper', 'brawl',
  'historic', 'timeless', 'alchemy', 'explorer', 'oathbreaker', 'penny', 'premodern', 'oldschool', 'predh'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

async function buildMtgFields() {
  const sets = await getJSON('https://api.scryfall.com/sets');
  const setNames = (sets?.data || []).filter((s) => !s.digital && s.card_count > 0).map((s) => `${s.name} (${s.code.toUpperCase()})`);
  await write('fields/mtg.json', [
    field('colors', 'Color', 'multi', { options: [
      { value: 'w', label: 'White' }, { value: 'u', label: 'Blue' }, { value: 'b', label: 'Black' },
      { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'c', label: 'Colorless' }] }),
    // Commander deck building: only cards legal in Commander whose color identity fits inside
    // the chosen colors (Scryfall's id<= plus f:commander). Colorless alone means colorless only.
    field('commander', 'Commander deck colors', 'multi', {
      options: [
        { value: 'w', label: 'White' }, { value: 'u', label: 'Blue' }, { value: 'b', label: 'Black' },
        { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'c', label: 'Colorless' }],
      describeAs: 'all',
      help: 'Pick your commander’s colors. Shows only cards legal in Commander whose color identity fits those colors.',
    }),
    field('type', 'Type line', 'text', { placeholder: 'e.g. legendary creature' }),
    field('text', 'Rules text', 'text', { placeholder: 'e.g. draw a card' }),
    field('mv', 'Mana value', 'range'),
    field('pow', 'Power', 'range'),
    field('tou', 'Toughness', 'range'),
    field('rarity', 'Rarity', 'select', { options: ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus'].map((r) => ({ value: r, label: cap(r) })) }),
    field('format', 'Legal in', 'select', { options: MTG_FORMATS.map((f) => ({ value: f, label: cap(f) })) }),
    field('set', 'Set', 'combo', { options: setNames }),
    field('artist', 'Artist', 'text'),
    field('usd', 'Price (USD)', 'range'),
  ]);
  // Scryfall set code -> TCGplayer group id, for price lookups.
  await write('tcg/mtg/sets.json', Object.fromEntries((sets?.data || []).filter((s) => s.tcgplayer_id).map((s) => [s.code, s.tcgplayer_id])));
  log(`fields mtg: ${setNames.length} sets`);
}

async function buildPokemon() {
  // Set order: TCGdex lists series oldest first, each with its sets in release order.
  // TCG Pocket (a mobile-only game) is left out.
  const series = ((await getJSON('https://api.tcgdex.net/v2/en/series')) || []).filter((s) => s.id !== 'misc');
  const details = await pool(series, 4, (s) => getJSON(`https://api.tcgdex.net/v2/en/series/${s.id}`));
  const order = [], pocket = [], names = [];
  details.forEach((d) => d?.sets?.forEach((set) => {
    if (d.id === 'tcgp') return pocket.push(set.id);
    order.push(set.id);
    names.push(`${set.name} (${set.id})`);
  }));
  await write('pkm-sets.json', { order, pocket });

  const list = async (endpoint) => (await getJSON(`https://api.tcgdex.net/v2/en/${endpoint}`)) || [];
  const [category, types, stage, trainerType, rarity, marks] = await Promise.all(
    ['categories', 'types', 'stages', 'trainer-types', 'rarities', 'regulation-marks'].map(list));
  await write('fields/pkm.json', [
    field('category', 'Card type', 'select', { options: category }),
    field('types', 'Energy type', 'multi', { options: types }),
    field('stage', 'Stage', 'select', { options: stage }),
    field('trainerType', 'Trainer type', 'select', { options: trainerType }),
    field('hp', 'HP', 'range'),
    field('retreat', 'Retreat cost', 'range'),
    field('rarity', 'Rarity', 'select', { options: rarity }),
    field('set', 'Set', 'combo', { options: names.reverse() }),
    field('regulationMark', 'Regulation mark', 'select', { options: [...new Set(marks.filter((m) => m !== 'None').map((m) => m.toUpperCase()))] }),
    field('illustrator', 'Illustrator', 'text'),
    field('text', 'Card text', 'text', { placeholder: 'Attacks, abilities and trainer text' }),
  ]);
  log(`fields pkm: ${order.length} sets`);

  // Card text index. TCGdex's REST filters can't search attack or ability text, so collect it
  // from its GraphQL API (max 100 cards per request): id -> lowercased text.
  const text = {};
  const pageOf = async (category, page) => {
    const query = `{ cards(filters:{category:"${category}"}, pagination:{page:${page}, count:100}) {
      id effect description attacks { name effect } abilities { name effect } } }`;
    const r = await getJSON('https://api.tcgdex.net/v2/graphql', { method: 'POST', body: JSON.stringify({ query }) });
    return r?.data?.cards || [];
  };
  for (const cat of ['Pokemon', 'Trainer', 'Energy']) {
    for (let page = 1, done = false; !done; page += 6) {
      const batch = await pool(Array.from({ length: 6 }, (_, i) => page + i), 6, (p) => pageOf(cat, p));
      for (const cards of batch) {
        for (const c of cards) {
          if (!c?.id) continue;
          // Some cards carry null entries in their attack or ability lists.
          const parts = [c.effect, c.description,
            ...(c.attacks || []).flatMap((a) => [a?.name, a?.effect]),
            ...(c.abilities || []).flatMap((a) => [a?.name, a?.effect])];
          const t = parts.filter(Boolean).join('\n').toLowerCase();
          if (t) text[c.id] = t;
        }
        if (cards.length < 100) done = true;
      }
    }
  }
  const size = await write('pkm-text.json', text);
  log(`pkm text index: ${Object.keys(text).length} cards, ${kb(size)}`);
}

async function buildYgoFields() {
  const YGO_TYPES = ['Effect Monster', 'Normal Monster', 'Flip Effect Monster', 'Tuner Monster', 'Normal Tuner Monster',
    'Spirit Monster', 'Union Effect Monster', 'Gemini Monster', 'Toon Monster', 'Ritual Monster', 'Ritual Effect Monster',
    'Fusion Monster', 'Synchro Monster', 'Synchro Tuner Monster', 'Synchro Pendulum Effect Monster', 'XYZ Monster',
    'XYZ Pendulum Effect Monster', 'Link Monster', 'Pendulum Effect Monster', 'Pendulum Normal Monster',
    'Pendulum Tuner Effect Monster', 'Pendulum Effect Ritual Monster', 'Pendulum Flip Effect Monster',
    'Pendulum Effect Fusion Monster', 'Spell Card', 'Trap Card', 'Skill Card', 'Token'];
  const YGO_RACES = ['Aqua', 'Beast', 'Beast-Warrior', 'Creator-God', 'Cyberse', 'Dinosaur', 'Divine-Beast', 'Dragon',
    'Fairy', 'Fiend', 'Fish', 'Illusion', 'Insect', 'Machine', 'Plant', 'Psychic', 'Pyro', 'Reptile', 'Rock',
    'Sea Serpent', 'Spellcaster', 'Thunder', 'Warrior', 'Winged Beast', 'Wyrm', 'Zombie',
    'Normal', 'Continuous', 'Quick-Play', 'Field', 'Equip', 'Ritual', 'Counter'];
  const [arch, sets] = await Promise.all([
    getJSON('https://db.ygoprodeck.com/api/v7/archetypes.php'), getJSON('https://db.ygoprodeck.com/api/v7/cardsets.php')]);
  await write('fields/ygo.json', [
    field('type', 'Card type', 'select', { options: YGO_TYPES }),
    field('race', 'Monster type / Spell & Trap kind', 'select', { options: YGO_RACES }),
    field('attribute', 'Attribute', 'multi', { options: ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'] }),
    field('level', 'Level / Rank', 'range'),
    field('atk', 'ATK', 'range'),
    field('def', 'DEF', 'range'),
    field('linkval', 'Link rating', 'range'),
    field('text', 'Card text', 'text', { placeholder: 'e.g. special summon' }),
    field('archetype', 'Archetype', 'combo', { options: (arch || []).map((a) => a.archetype_name) }),
    field('cardset', 'Set', 'combo', { options: [...new Set((sets || []).sort((a, b) => (b.tcg_date || '').localeCompare(a.tcg_date || '')).map((s) => s.set_name))] }),
  ]);
  log('fields ygo');
}

// ---------- TCGplayer prices via TCGCSV ----------
// TCGCSV (https://tcgcsv.com) mirrors TCGplayer's catalog and prices daily, around 8pm US Eastern.
// Product rows are stored compactly: [productId, name, number, rarity, prices] with
// prices as [[printing, market, low, mid, high, directLow], ...].

const TCGCSV = 'https://tcgcsv.com/tcgplayer';
const CATEGORY = { mtg: 1, ygo: 2, pkm: 3, dgm: 63, op: 68, lor: 71, swu: 79, rb: 89, cp: 92 };
const extended = (p, key) => p.extendedData?.find((e) => e.name === key)?.value ?? null;

async function groupRows(cat, gid) {
  const [products, prices] = await Promise.all([
    getJSON(`${TCGCSV}/${cat}/${gid}/products`), getJSON(`${TCGCSV}/${cat}/${gid}/prices`)]);
  const byId = new Map();
  for (const r of prices?.results || []) {
    if (r.marketPrice == null && r.lowPrice == null && r.midPrice == null) continue;
    if (!byId.has(r.productId)) byId.set(r.productId, []);
    byId.get(r.productId).push([r.subTypeName, r.marketPrice, r.lowPrice, r.midPrice, r.highPrice, r.directLowPrice]);
  }
  return (products?.results || []).map((p) =>
    [p.productId, p.name, extended(p, 'Number'), extended(p, 'Rarity'), byId.get(p.productId) || []]);
}

async function tcgGroups(game) {
  const r = await getJSON(`${TCGCSV}/${CATEGORY[game]}/groups`);
  return (r?.results || []).map((g) => [g.groupId, g.name, g.abbreviation || '', g.publishedOn?.slice(0, 10) || '']);
}

// Smaller games: one file with every product, matched in the browser by number or set + number.
async function buildTcgWhole(game) {
  const groups = await tcgGroups(game);
  const products = [];
  let failed = 0;
  await pool(groups, 6, async (g, i) => {
    try {
      for (const row of await groupRows(CATEGORY[game], g[0])) products.push([...row, i]);
    } catch (e) { failed++; warnings++; console.warn(`  warn: ${game} group ${g[1]}: ${e.message}`); }
  });
  const size = await write(`tcg/${game}.json`, { groups: groups.map((g) => g.slice(0, 3)), products });
  log(`prices ${game}: ${products.length} products in ${groups.length} sets${failed ? ` (${failed} sets failed)` : ''}, ${kb(size)}`);
}

// Larger games: one file per set, so the browser only downloads the set it needs.
async function buildTcgSharded(game) {
  const groups = await tcgGroups(game);
  await write(`tcg/${game}/groups.json`, groups);
  const ids = {};
  let count = 0, failed = 0;
  await pool(groups, 6, async ([gid, name]) => {
    try {
      const rows = await groupRows(CATEGORY[game], gid);
      await write(`tcg/${game}/${gid}.json`, rows);
      count += rows.length;
      if (game === 'pkm') for (const r of rows) ids[r[0]] = gid;   // TCGdex gives product ids, not sets
    } catch (e) { failed++; warnings++; console.warn(`  warn: ${game} group ${name}: ${e.message}`); }
  });
  if (game === 'pkm') await write('tcg/pkm/ids.json', ids);
  log(`prices ${game}: ${count} products in ${groups.length} sets${failed ? ` (${failed} sets failed)` : ''}`);
}

// ---------- Run ----------

const started = Date.now();
await fs.mkdir(OUT, { recursive: true });
log(`Building ${ONLY.length ? ONLY.join(', ') : 'all data'} into ${path.relative(ROOT, OUT)}`);

const tasks = [];
for (const game of Object.keys(LOCAL)) if (want(game)) tasks.push(() => buildCatalog(game));
if (want('mtg')) tasks.push(buildMtgFields);
if (want('pkm')) tasks.push(buildPokemon);
if (want('ygo')) tasks.push(buildYgoFields);
for (const game of ['op', 'lor', 'rb', 'cp', 'swu', 'dgm']) if (want('prices') || want(`prices-${game}`)) tasks.push(() => buildTcgWhole(game));
for (const game of ['mtg', 'ygo', 'pkm']) if (want('prices') || want(`prices-${game}`)) tasks.push(() => buildTcgSharded(game));

// Card sources and filter data are required; run a few at a time.
await pool(tasks, 3, (t) => t());

await write('meta.json', { builtAt: new Date().toISOString() });
log(`Done in ${((Date.now() - started) / 60e3).toFixed(1)} min, ${(bytes / 1048576).toFixed(1)} MB written${warnings ? `, ${warnings} warnings` : ''}`);
