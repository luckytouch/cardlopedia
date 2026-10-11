// Cardlopedia search engine. Runs entirely in the browser, so the site can be static.
//
//   Engine.query(game, q, filters, page)  -> { total, hasMore, cards }
//   Engine.fields(game)                   -> advanced-search filter definitions
//   Engine.card(game, id)                 -> full card details (Pokémon only; others are complete)
//   Engine.price(game, ref)               -> TCGplayer prices for a card, or { none: true }
//
// Magic, Pokémon and Yu-Gi-Oh! are searched live through their public APIs, which allow
// browser requests. The other six games, filter options, the Pokémon text index and all
// TCGplayer prices come from data/ files that scripts/build-data.mjs regenerates daily.
const Engine = (() => {
  const PAGE = 60;
  const DATA = 'data/';

  // ---------- Fetching ----------

  async function getJSON(url, source) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error(`Couldn’t reach ${source}. Check your connection and try again.`);
    }
    if (res.status === 404 || res.status === 400) return null;   // the card APIs use these for "no results"
    if (res.status === 429) throw new Error(`${source} is busy right now. Wait a few seconds and try again.`);
    if (!res.ok) throw new Error(`${source} didn’t respond (error ${res.status}). Try again in a moment.`);
    return res.json();
  }

  // Keep each result for the life of the page; drop failures so they can be retried.
  const memo = new Map();
  function once(key, fn) {
    if (!memo.has(key)) {
      memo.set(key, fn().catch((e) => { memo.delete(key); throw e; }));
      if (memo.size > 400) memo.delete(memo.keys().next().value);   // keep memory bounded
    }
    return memo.get(key);
  }
  const api = (url, source) => once(url, () => getJSON(url, source));
  const data = (file) => once(DATA + file, async () => {
    const r = await getJSON(DATA + file, 'Cardlopedia data');
    if (r === null) throw new Error('This part of the site’s data is missing. It should return after the next daily update.');
    return r;
  });

  // ---------- Shared helpers ----------

  const enc = encodeURIComponent;
  const clean = (o) => o.filter(([, v]) => v !== null && v !== undefined && v !== '');
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(+v) ? null : +v);
  const asList = (v) => [].concat(v ?? []).filter((x) => x !== null && x !== undefined && x !== '');
  const slice = (all, page) => ({ total: all.length, cards: all.slice((page - 1) * PAGE, page * PAGE), hasMore: page * PAGE < all.length });
  const rank = (name = '', needle) => {
    const n = name.toLowerCase();
    return n === needle ? 0 : n.startsWith(needle) ? 1 : n.includes(needle) ? 2 : 3;
  };
  // "Dominaria United (DMU)" -> "DMU"; plain text passes through.
  const codeOf = (v) => (v.match(/\(([^()]+)\)\s*$/) || [, v])[1].trim();

  // Card-text searches match cards containing every word, in any order, like Scryfall.
  // Quotes keep an exact phrase: `"draw a card" blocker` -> ['draw a card', 'blocker'].
  // Brackets and quote marks are ignored on both sides, since sources write the same thing
  // differently: <Slash>, (Slash), "Slash" and Slash all match each other.
  const SYMBOLS = /[<>()[\]{}"“”‘’«»‹›〈〉《》「」『』【】〔〕]/g;
  const plain = (s) => String(s).toLowerCase().replace(SYMBOLS, ' ').replace(/\s+/g, ' ').trim();
  const terms = (s) => [...String(s).toLowerCase().matchAll(/"([^"]+)"|“([^”]+)”|(\S+)/g)].flatMap((m) => {
    const phrase = m[1] || m[2];
    return phrase ? [plain(phrase)] : plain(m[3]).split(' ');   // "<slash>/x" -> words
  }).filter(Boolean);
  const hasAll = (text, ts) => { const t = plain(text); return ts.every((w) => t.includes(w)); };

  // Keep only well-formed values for this game's fields; ranges become numbers.
  function normalizeFilters(f, fields) {
    const out = {};
    for (const fl of fields) {
      const v = f?.[fl.key];
      if ((fl.kind === 'multi' || fl.kind === 'exclude' || fl.kind === 'within') && Array.isArray(v) && v.length) out[fl.key] = v.map(String);
      else if (fl.kind === 'range' && Array.isArray(v)) {
        const r = [num(v[0]), num(v[1])];
        if (r[0] !== null || r[1] !== null) out[fl.key] = r;
      } else if (typeof v === 'string' && v.trim()) out[fl.key] = v.trim();
    }
    return out;
  }

  // ---------- Games filtered in the browser (catalog files) ----------

  // One Piece text says "DON!!" everywhere; typing plain "don" should find it (so "don x1"
  // finds "[DON!! x1]") without matching "Donquixote" or "don't".
  const NORMS = { opDon: (s) => s.replace(/\bdon(?![\w'’])!*\s*/g, 'don!! ') };

  function catalog(game) {
    return once(`catalog:${game}`, async () => {
      const cat = await data(`catalog/${game}.json`);
      if (game === 'cp') await Promise.race([refreshCyberpunkImages(cat.cards), new Promise((r) => setTimeout(r, 5000))]);
      return cat;
    });
  }

  // Cyberpunk image links are signed by NetDeck and stay valid for only about five minutes,
  // so fetch current ones when the catalog loads, and again (at most once a minute) whenever
  // an image fails to load. See freshImage() below.
  let cpRefresh = null;
  function refreshCyberpunkImages(entries) {
    if (cpRefresh && Date.now() - cpRefresh.at < 60e3) return cpRefresh.promise;
    const promise = (async () => {
      try {
        const url = (o) => `https://api.netdeck.gg/api/cards/cyberpunk?language=en&limit=100&offset=${o}`;
        const first = await getJSON(url(0), 'NetDeck');
        const pages = [first];
        for (let o = 100; o < (first?.total || 0); o += 100) pages.push(await getJSON(url(o), 'NetDeck'));
        const images = new Map(pages.flatMap((p) => p?.items || []).map((c) => [c.printing_id || c.id, c.image_url]));
        for (const { c } of entries) if (images.get(c.id)) c.image = c.large = images.get(c.id);
      } catch { /* keep the links we have */ }
    })();
    cpRefresh = { at: Date.now(), promise };
    return promise;
  }

  function matchesLocal(entry, fields, f) {
    for (const fl of fields) {
      const want = f[fl.key];
      if (want === undefined) continue;
      const got = asList(entry.f[fl.key]);
      switch (fl.kind) {
        case 'multi':
          if (!got.some((g) => want.includes(String(g)))) return false;
          break;
        case 'exclude':   // hide cards that have any chosen value (e.g. rotated One Piece blocks)
          if (got.some((g) => want.includes(String(g)))) return false;
          break;
        case 'within': {  // every value on the card must be chosen (e.g. One Piece Leader colors)
          if (!got.length || !got.every((g) => want.includes(String(g)))) return false;
          const type = asList(entry.f[fl.typeKey]).map(String);
          if (fl.onlyTypes && !type.some((t) => fl.onlyTypes.includes(t))) return false;
          break;
        }
        case 'select': {
          const t = want.toLowerCase();
          if (!got.some((g) => String(g).toLowerCase() === t)) return false;
          break;
        }
        case 'combo': {
          const t = want.toLowerCase();
          if (!got.some((g) => String(g).toLowerCase().includes(t))) return false;
          break;
        }
        case 'text': {
          // Normalize both sides first (e.g. One Piece "don" -> "DON!!"), then require every word.
          const norm = NORMS[fl.norm] || ((x) => x);
          const text = norm(got.join('\n').toLowerCase());
          if (!hasAll(text, terms(norm(want.toLowerCase())))) return false;
          break;
        }
        case 'range': {
          const [lo, hi] = want;
          if (!got.some((n) => n !== null && (lo === null || n >= lo) && (hi === null || n <= hi))) return false;
          break;
        }
      }
    }
    return true;
  }

  // With a card-text search, show cards whose text has the words in the typed order, close
  // together (a few words apart at most), before cards that only contain them somewhere.
  function textCloseness(cat, f) {
    const fl = cat.fields.find((x) => x.key === 'text');
    if (!fl || !f.text) return null;
    const norm = NORMS[fl.norm] || ((x) => x);
    const ts = terms(norm(f.text.toLowerCase()));
    if (ts.length < 2) return null;
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const near = new RegExp(ts.map(esc).join('(?:\\S*\\s+){0,4}?\\S*?'), 's');
    return (e) => (near.test(plain(norm(asList(e.f.text).join('\n').toLowerCase()))) ? 0 : 1);
  }

  async function queryLocal(game, q, f, page) {
    const cat = await catalog(game);
    const needle = q.toLowerCase();
    let hits = cat.cards.filter((e) => matchesLocal(e, cat.fields, f));
    const close = textCloseness(cat, f);
    if (close) hits = hits.map((e) => [close(e), e]).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
    if (needle) hits = hits.filter((e) => e.s.includes(needle)).sort((a, b) => rank(a.c.name, needle) - rank(b.c.name, needle));
    return slice(hits.map((e) => e.c), page);
  }

  // ---------- Magic: filters become Scryfall syntax ----------

  function mtgCard(c) {
    const face = c.card_faces?.[0] || {};
    const imgs = c.image_uris || face.image_uris || {};
    const text = c.card_faces
      ? c.card_faces.map((x) => `${x.name} ${x.mana_cost || ''}\n${x.type_line}\n${x.oracle_text || ''}`).join('\n\n')
      : c.oracle_text;
    return {
      id: c.id, name: c.name, image: imgs.normal, large: imgs.large || imgs.normal,
      type: c.type_line, text, set: c.set_name, number: c.collector_number,
      rarity: c.rarity && c.rarity[0].toUpperCase() + c.rarity.slice(1), artist: c.artist,
      stats: clean([['Mana', c.mana_cost ?? face.mana_cost], ['P/T', c.power != null ? `${c.power}/${c.toughness}` : null],
        ['Loyalty', c.loyalty],
        ['Color identity', c.color_identity ? (c.color_identity.length ? c.color_identity.join('') : 'Colorless') : null],
        ['Commander', c.legalities?.commander ? (c.legalities.commander === 'legal' ? 'Legal' : c.legalities.commander === 'banned' ? 'Banned' : 'Not legal') : null]]),
      link: c.scryfall_uri,
      tcg: { pid: c.tcgplayer_id, etched: c.tcgplayer_etched_id, set: c.set, num: c.collector_number, name: c.name },
    };
  }

  function toScryfall(q, f) {
    const parts = q ? [q] : [];
    const quote = (s) => `"${s.replace(/"/g, '')}"`;
    const range = (key, op) => {
      const [lo, hi] = f[key] || [];
      if (lo != null) parts.push(`${op}>=${lo}`);
      if (hi != null) parts.push(`${op}<=${hi}`);
    };
    if (f.colors) parts.push(`(${f.colors.map((c) => `c:${c}`).join(' or ')})`);
    if (f.commander) {
      // Color identity within the chosen colors, and legal in Commander. Colorless is always
      // within any identity, so it only matters when it's the only choice.
      const colors = f.commander.filter((c) => 'wubrg'.includes(c));
      parts.push(colors.length ? `id<=${colors.join('')}` : 'id:c', 'f:commander');
    }
    if (f.type) f.type.split(/\s+/).forEach((w) => parts.push(`t:${quote(w)}`));
    if (f.text) terms(f.text).forEach((t) => parts.push(`o:${quote(t)}`));
    range('mv', 'mv'); range('pow', 'pow'); range('tou', 'tou'); range('usd', 'usd');
    if (f.rarity) parts.push(`r:${f.rarity}`);
    if (f.format) parts.push(`f:${f.format}`);
    if (f.set) parts.push(`e:${codeOf(f.set)}`);
    if (f.artist) parts.push(`a:${quote(f.artist)}`);
    return parts.join(' ');
  }

  async function queryMtg(q, f, page) {
    const sq = q || Object.keys(f).length ? toScryfall(q, f) : 'game:paper order:released direction:desc';
    const r = await api(`https://api.scryfall.com/cards/search?q=${enc(sq)}&page=${page}`, 'Scryfall');
    if (!r || r.object === 'error') return { total: 0, cards: [], hasMore: false };
    return { total: r.total_cards, hasMore: r.has_more, cards: r.data.map(mtgCard) };
  }

  // ---------- Pokémon: filters become TCGdex query parameters ----------

  const pkmBrief = (c) => ({
    id: c.id, name: c.name, image: c.image + '/low.webp', large: c.image + '/high.webp',
    set: c.id.slice(0, c.id.lastIndexOf('-')), number: c.localId, lazy: true, tcg: { id: c.id },
  });

  const pkmSets = () => once('pkm-sets', async () => {
    const s = await data('pkm-sets.json');
    return { order: new Map(s.order.map((id, i) => [id, i])), pocket: new Set(s.pocket) };
  });

  async function queryPkm(q, f, page) {
    const p = new URLSearchParams();
    if (q) p.append('name', q);
    for (const key of ['category', 'stage', 'trainerType', 'rarity', 'regulationMark']) if (f[key]) p.append(key, `eq:${f[key]}`);
    if (f.types) p.append('types', f.types.join('|'));
    for (const key of ['hp', 'retreat']) {
      const [lo, hi] = f[key] || [];
      if (lo != null) p.append(key, `gte:${lo}`);
      if (hi != null) p.append(key, `lte:${hi}`);
    }
    if (f.set) p.append('set.id', `eq:${codeOf(f.set)}`);
    if (f.illustrator) p.append('illustrator', f.illustrator);
    const qs = p.toString();
    const needle = f.text ? terms(f.text) : null;
    const [r, sets, text] = await Promise.all([
      api(`https://api.tcgdex.net/v2/en/cards${qs ? '?' + qs : ''}`, 'TCGdex'), pkmSets(),
      needle ? data('pkm-text.json') : null]);
    const setOf = (c) => c.id.slice(0, c.id.lastIndexOf('-'));
    const pos = (c) => sets.order.get(setOf(c)) ?? -1;
    const all = (Array.isArray(r) ? r : [])
      .filter((c) => c.image && !sets.pocket.has(setOf(c)))                 // TCG Pocket is a mobile-only game
      .filter((c) => !needle || hasAll(text[c.id] || '', needle))
      .sort((a, b) => pos(b) - pos(a) || (parseInt(a.localId) || 1e9) - (parseInt(b.localId) || 1e9));
    return slice(all.map(pkmBrief), page);
  }

  async function pkmCard(id) {
    const c = await api(`https://api.tcgdex.net/v2/en/cards/${enc(id)}`, 'TCGdex');
    if (!c) return null;
    const text = [
      c.abilities?.map((a) => `${a.type}: ${a.name}\n${a.effect}`).join('\n\n'),
      c.attacks?.map((a) => `${(a.cost || []).join(' ')} — ${a.name}${a.damage ? ' · ' + a.damage : ''}${a.effect ? '\n' + a.effect : ''}`).join('\n\n'),
      c.effect, c.description,
    ].filter(Boolean).join('\n\n');
    return {
      id: c.id, name: c.name, image: c.image + '/low.webp', large: c.image + '/high.webp',
      type: [c.category, c.stage, c.trainerType, c.energyType].filter(Boolean).join(' — '),
      set: c.set?.name, number: c.localId, rarity: c.rarity, artist: c.illustrator, text,
      stats: clean([['HP', c.hp], ['Type', c.types?.join(', ')], ['Retreat', c.retreat],
        ['Weakness', c.weaknesses?.map((w) => `${w.type} ${w.value || ''}`).join(', ')], ['Regulation', c.regulationMark]]),
      tcg: { id: c.id },
      link: `https://www.tcgdex.net/database/${c.set?.serie?.id || ''}/${c.set?.id}/${c.localId}`,
    };
  }

  // ---------- Yu-Gi-Oh!: filters become YGOPRODeck parameters ----------

  const ygoCard = (c) => ({
    id: String(c.id), name: c.name,
    image: c.card_images?.[0]?.image_url_small, large: c.card_images?.[0]?.image_url,
    type: (c.humanReadableCardType || c.type) + (c.race ? ` — ${c.race}` : ''), text: c.desc,
    set: c.card_sets?.[0]?.set_name, rarity: c.card_sets?.[0]?.set_rarity,
    stats: clean([['ATK', c.atk], ['DEF', c.def], ['Level', c.level], ['Link', c.linkval],
      ['Attribute', c.attribute], ['Archetype', c.archetype]]),
    link: c.ygoprodeck_url,
    tcg: { code: c.card_sets?.[0]?.set_code, set: c.card_sets?.[0]?.set_name, name: c.name },
  });

  async function queryYgo(q, f, page) {
    const base = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
    if (!q && !Object.keys(f).length) {
      const r = await api(`${base}?sort=new&num=${PAGE}&offset=${(page - 1) * PAGE}`, 'YGOPRODeck');
      const total = r?.meta?.total_rows ?? 0;
      return { total, hasMore: page * PAGE < total, cards: (r?.data || []).map(ygoCard) };
    }
    const p = new URLSearchParams();
    if (q) p.set('fname', q);
    for (const key of ['type', 'race', 'archetype', 'cardset']) if (f[key]) p.set(key, f[key]);
    // The API matches one phrase; send the longest word and check the rest below.
    const words = f.text ? terms(f.text) : [];
    if (words.length) p.set('desc', [...words].sort((a, b) => b.length - a.length)[0]);
    if (f.attribute) p.set('attribute', f.attribute.join(','));
    // The API takes one bound per stat; send one and apply both below.
    for (const key of ['level', 'atk', 'def', 'linkval']) {
      const [lo, hi] = f[key] || [];
      if (lo != null) p.set(key, `gte${lo}`);
      else if (hi != null) p.set(key, `lte${hi}`);
    }
    if (!q) p.set('sort', 'new');
    const r = await api(`${base}?${p}`, 'YGOPRODeck');
    const inRange = (c, key) => {
      const [lo, hi] = f[key] || [null, null];
      const v = num(c[key]);
      return (lo === null && hi === null) || (v !== null && (lo === null || v >= lo) && (hi === null || v <= hi));
    };
    const all = (r?.data || []).filter((c) => ['level', 'atk', 'def', 'linkval'].every((k) => inRange(c, k))
      && hasAll((c.desc || '').toLowerCase(), words));
    return slice(all.map(ygoCard), page);
  }

  // ---------- TCGplayer prices (TCGCSV data, built daily) ----------

  const normSet = (s = '') => s.toLowerCase().replace(/[—–-]/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  // "BT6-054 R" -> "BT6-054"; One Piece variant suffixes "P-059_p1", "P-041_r1" -> base number
  const normNum = (s = '') => String(s).trim().split(/\s+/)[0].replace(/_[a-z]\d+$/i, '').toUpperCase();
  // "059/252" -> "59", "005a" -> "5a", "4/204" -> "4"
  const collector = (s = '') => String(s).split('/')[0].trim().toLowerCase().replace(/^0+(?=\w)/, '');
  const normName = (s = '') => s.toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]/g, '');
  const productUrl = (id) => `https://www.tcgplayer.com/product/${id}`;

  // [pid, name, number, rarity, prices] -> product object
  const product = ([productId, name, number, rarity, prices], group = []) => ({
    productId, name, number, rarity, set: group[1], abbr: group[2],
    prices: prices.map(([type, market, low, mid, high, direct]) => ({ type, market, low, mid, high, direct })),
  });

  // Prefer an exact name match, then a loose one, then the plainest printing.
  function best(candidates, name) {
    if (!candidates?.length) return null;
    const exact = (name || '').toLowerCase(), loose = normName(name);
    const score = (p) => (p.name.toLowerCase() === exact ? 4 : 0) + (normName(p.name) === loose ? 2 : 0)
      + (/\(/.test(p.name) ? 0 : 1) + (p.prices.length ? 0.5 : 0);
    return [...candidates].sort((a, b) => score(b) - score(a))[0];
  }
  const answer = (p) => (p ? { name: p.name, set: p.set, rarity: p.rarity, url: productUrl(p.productId), prices: p.prices } : null);

  // Smaller games: one file with every product, indexed three ways.
  const whole = (game) => once(`tcg:${game}`, async () => {
    const { groups, products } = await data(`tcg/${game}.json`);
    const byId = new Map(), byNumber = new Map(), bySetNumber = new Map();
    const add = (map, key, p) => { if (!map.has(key)) map.set(key, []); map.get(key).push(p); };
    for (const row of products) {
      const p = product(row, groups[row[5]]);
      byId.set(p.productId, p);
      if (!p.number) continue;
      add(byNumber, normNum(p.number), p);
      // Sets are found by name or by abbreviation (Star Wars uses codes like SOR).
      for (const key of new Set([normSet(p.set), normSet(p.abbr)])) if (key) add(bySetNumber, `${key}|${collector(p.number)}`, p);
    }
    return { byId, byNumber, bySetNumber };
  });

  // Larger games: one file per set.
  const groupsOf = (game) => data(`tcg/${game}/groups.json`);
  async function shard(game, gid) {
    const [rows, groups] = await Promise.all([data(`tcg/${game}/${gid}.json`).catch(() => []), groupsOf(game)]);
    const group = groups.find((g) => g[0] === gid);
    return rows.map((r) => product(r, group));
  }

  const lookups = {
    async mtg(ref) {
      const gid = (await data('tcg/mtg/sets.json'))[ref.set];
      if (!gid) return null;
      const products = await shard('mtg', gid);
      if (!ref.pid) {  // Scryfall hasn't linked this printing yet: use the collector number
        return answer(best(products.filter((p) => p.number && collector(p.number) === collector(ref.num)), ref.name));
      }
      const main = products.find((p) => p.productId === ref.pid);
      const etched = ref.etched && products.find((p) => p.productId === ref.etched);
      if (!main && !etched) return null;
      const prices = [...(main?.prices || []), ...(etched?.prices || []).map((r) => ({ ...r, type: 'Etched Foil' }))];
      return { name: ref.name, url: productUrl(ref.pid), prices };
    },
    async pkm(ref) {
      const card = await api(`https://api.tcgdex.net/v2/en/cards/${enc(ref.id)}`, 'TCGdex');
      if (!card) return null;
      const ids = [...new Set((card.variants_detailed || []).map((v) => v.thirdParty?.tcgplayer).filter(Boolean))];
      const idToGroup = await data('tcg/pkm/ids.json');
      const id = ids.find((i) => idToGroup[i]);
      if (id) return answer((await shard('pkm', idToGroup[id])).find((p) => p.productId === id));
      // Brand-new sets often lack TCGplayer ids on TCGdex: find the set's group, named like
      // "SV03: Obsidian Flames" or "SM - Ultra Prism", and match the card number.
      const wanted = normSet(card.set?.name);
      const bare = (name) => normSet(name.replace(/^[A-Z]+\d*\s*(?::|\s-)\s*/, ''));
      const group = wanted && (await groupsOf('pkm')).find((g) => normSet(g[1]) === wanted || bare(g[1]) === wanted);
      if (!group) return null;
      const products = await shard('pkm', group[0]);
      return answer(best(products.filter((p) => p.number && collector(p.number) === collector(card.localId)), card.name));
    },
    async ygo(ref) {
      if (!ref.code) return null;
      const prefix = ref.code.split('-')[0].toUpperCase();
      const wanted = normSet(ref.set);
      const candidates = (await groupsOf('ygo')).filter((g) =>
        (g[2] && g[2].split('-')[0].toUpperCase() === prefix) || normSet(g[1]) === wanted).slice(0, 6);
      const lists = await Promise.all(candidates.map((g) => shard('ygo', g[0])));
      const code = ref.code.toUpperCase();
      return answer(best(lists.flat().filter((p) => p.number && normNum(p.number) === code), ref.name));
    },
    async rb(ref) {
      const t = await whole('rb');
      return answer(t.byId.get(Number(ref.pid)) || best(t.bySetNumber.get(`${normSet(ref.set)}|${collector(ref.num)}`), ref.name));
    },
    async op(ref) { return answer(best((await whole('op')).byNumber.get(normNum(ref.num)), ref.name)); },
    async dgm(ref) { return answer(best((await whole('dgm')).byNumber.get(normNum(ref.num)), ref.name)); },
  };
  for (const game of ['lor', 'cp', 'swu']) {
    lookups[game] = async (ref) => answer(best((await whole(game)).bySetNumber.get(`${normSet(ref.set)}|${collector(ref.num)}`), ref.name));
  }

  // ---------- Public interface ----------

  const REMOTE = { mtg: queryMtg, pkm: queryPkm, ygo: queryYgo };
  const LOCAL = ['op', 'lor', 'dgm', 'rb', 'cp', 'swu', 'hv'];
  const NO_PRICES = ['hv'];   // TCGplayer doesn't sell Haikyu!! Vobaca BREAK

  async function fields(game) {
    if (REMOTE[game]) return data(`fields/${game}.json`);
    if (LOCAL.includes(game)) return (await catalog(game)).fields;
    throw new Error('Unknown game');
  }

  return {
    fields,
    async query(game, q = '', f = {}, page = 1) {
      const clean = normalizeFilters(f, await fields(game));
      q = String(q).trim().slice(0, 200);
      return REMOTE[game] ? REMOTE[game](q, clean, page) : queryLocal(game, q, clean, page);
    },
    card(game, id) { return game === 'pkm' ? pkmCard(id) : Promise.resolve(null); },
    // A current image link for a card whose image failed to load (Cyberpunk's links expire).
    async freshImage(game, id) {
      if (game !== 'cp') return null;
      const cat = await catalog('cp');
      await refreshCyberpunkImages(cat.cards);
      return cat.cards.find((e) => e.c.id === id)?.c.image || null;
    },
    async price(game, ref) {
      if (NO_PRICES.includes(game)) return { unsupported: true };
      if (!lookups[game] || !ref) return { none: true };
      return (await lookups[game](ref)) || { none: true };
    },
  };
})();
