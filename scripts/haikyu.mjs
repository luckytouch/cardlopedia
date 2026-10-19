// Haikyu!! Vobaca!! BREAK (Takara Tomy) is only published in Japanese. This module turns the
// official card data into English for Cardlopedia.
//
// - Card names and rules text come from haikyu-en.json, translated by hand with the glossary
//   below so game terms stay consistent. Keys are the Japanese text (normalized by norm()).
// - Teams, years, positions, rarities and products are translated by rule here.
// - Duo cards ("this card counts as A or B") are translated by a template, so new ones need no work.
// Anything without a translation stays in Japanese and is marked untranslated; the build log
// lists those so they can be added to haikyu-en.json.
//
// Glossary: ガッツ Guts · 登場 On Entry / put into play · ドロップ drop · ロスト loses the rally ·
// ドシャット Kill Block · ワンタッチ One Touch · ツーアタック Setter Dump · フェイント Feint ·
// ブロックアウト Block Out · バックアタック Back Attack · Aパス A-Pass · ユース Youth ·
// 同時多発位置差攻撃〈所属〉 Synchronized Attack 〈Team〉 ·
// 疑似ユース Rookie Camp · セットカード Set card · センター/サイドブロッカー Center/Side Blocker.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EN = JSON.parse(fs.readFileSync(path.join(HERE, 'haikyu-en.json'), 'utf8'));

// Same text, regardless of the source's line endings and stray spaces.
export const norm = (s = '') => String(s).replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim();
const hasJapanese = (s) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);

// ---------- Teams, years and squads ----------

const TEAMS = {
  '全日本男子代表': "Japan Men's National Team", '北川第一中': 'Kitagawa Daiichi Jr. High',
  '白鳥沢中': 'Shiratorizawa Jr. High', '音駒中': 'Nekoma Jr. High', '光仙中': 'Kosen Jr. High',
  '青葉城西': 'Aoba Johsai', '早流川工業': 'Sarukawa Tech', '伊達工業': 'Date Tech', '和久谷南': 'Wakutani South',
  '新山女子': "Niiyama Girls'", '白鳥沢': 'Shiratorizawa', '稲荷崎': 'Inarizaki', '稲荷埼': 'Inarizaki',
  '条善寺': 'Johzenji', '井闥山': 'Itachiyama', '白水館': 'Hakusuikan', '烏野': 'Karasuno', '音駒': 'Nekoma',
  '梟谷': 'Fukurodani', '常波': 'Tokonami', '扇南': 'Ohgiminami', '角川': 'Kakugawa', '鴎台': 'Kamomedai',
  '椿原': 'Tsubakihara', '戸美': 'Nohebi', '森然': 'Shinzen', '生川': 'Ubugawa',
  'Asas São Paulo': 'Asas São Paulo', 'Ifviga Torino': 'Ifviga Torino',   // pro clubs, already in English
};
const SQUADS = { '疑似ユース': 'Rookie Camp', 'ユース': 'Youth', '町内会': 'Neighborhood Association' };
const YEAR = { 1: '1st-year', 2: '2nd-year', 3: '3rd-year' };
const byLength = (o) => Object.entries(o).sort((a, b) => b[0].length - a[0].length);

// "烏野·1年,音駒·2年" -> "Karasuno · 1st-year, Nekoma · 2nd-year"
export function translateAffiliation(a) {
  if (!a || a.trim() === '-') return '';
  // Also repairs a typo in the source data: "梟谷2·年" for "梟谷·2年".
  let s = a.replace(/[･・]/g, '·').replace(/([^\d·\s])(\d)·年/g, '$1·$2年');
  s = s.replace(/(\d)年/g, (_, d) => YEAR[d] || `${d}th-year`);
  for (const [jp, en] of byLength({ ...SQUADS, ...TEAMS })) s = s.split(jp).join(en);
  s = s.replace(/·/g, ' · ').replace(/\s*,\s*/g, ', ').replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').trim();
  return s;
}

// The schools and squads a card belongs to, for the Team filter.
// Each "," or "/" separated part names one school; take the longest match so that
// "音駒中" (Nekoma Jr. High) isn't also read as "音駒" (Nekoma).
export function teamsOf(a = '') {
  const found = new Set();
  for (const part of a.split(/[,/]/)) {
    const hit = byLength(TEAMS).find(([jp]) => part.includes(jp));
    if (hit) found.add(hit[1]);
  }
  return [...found];
}
// Youth (All-Japan youth camp) vs Rookie Camp (疑似ユース, "pseudo-youth"), which contains "ユース".
export function squadsOf(a = '') {
  const out = [];
  if (a.includes('疑似ユース')) out.push('Rookie Camp');
  if (a.replace(/疑似ユース/g, '').includes('ユース')) out.push('Youth');
  if (a.includes('町内会')) out.push('Neighborhood Association');
  return out;
}
export const yearsOf = (a) => [...new Set([...String(a || '').replace(/(\d)·年/g, '$1年').matchAll(/(\d)年/g)]
  .map((m) => YEAR[m[1]]).filter(Boolean))];

// ---------- Positions, rarity, products ----------

const POSITIONS = {
  MB: 'MB', S: 'S', Li: 'Li', WS: 'WS', OP: 'OP', '監督': 'Head Coach', '元監督': 'Former Head Coach',
  'コーチ': 'Coach', 'マネージャー': 'Manager', '応援団': 'Cheer Squad', '応援団長': 'Cheer Captain',
  'ボール拾い': 'Ball Boy', 'マスコット': 'Mascot',
};
export const positionsOf = (p) => [...new Set(String(p || '').split(',').map((x) => x.trim()).filter((x) => x && x !== '-')
  .map((x) => POSITIONS[x] || x))];

// Vobarity: base rarity, plus P (Parallel) or A (Alt Art) variants. A lone "P" is a promo.
const RARITY = { '極': 'Ultimate (極)', '秘': 'Secret (秘)', '頂': 'Pinnacle (頂)', S: 'S', R: 'R', N: 'N', D: 'Deck (D)', P: 'Promo (P)' };
export function rarityOf(v = '') {
  if (v === 'P') return { rarity: RARITY.P, version: 'Regular' };
  const m = v.match(/^(.+?)([PA])?$/);
  const base = RARITY[m?.[1]] || m?.[1] || v;
  return { rarity: base, version: m?.[2] === 'P' ? 'Parallel' : m?.[2] === 'A' ? 'Alt Art' : 'Regular' };
}

const PRODUCTS = {
  'HV-P01': 'Booster Pack: Battle at the Garbage Dump', 'HV-P02': 'Booster Pack: The Strongest Challenger',
  'HV-P03': 'Booster Pack: Youth & Selection Training Camp', 'HV-D01': 'Starter Deck: Karasuno High',
  'HV-D02': 'Starter Deck: Nekoma High', 'HV-D03': 'Starter Deck: Inarizaki High', HVBP: 'Donpisha Deck', 'HV-PR': 'Promo Cards',
  'HV-P04': 'Booster Pack: Talent and Sense', 'HV-D04': 'Starter Deck: Aoba Johsai High',
};
export const productOf = (type, jpName) => PRODUCTS[type] || `${type}${jpName ? ` (${jpName})` : ''}`;

// ---------- Names and rules text ----------

export function translateName(jp) {
  const key = norm(jp);
  if (EN.names[key]) return EN.names[key];
  // Duo cards not listed yet: "日向・孤爪" -> "Hinata & Kozume", using known family names.
  if (key.includes('・')) {
    const parts = key.split('・').map((p) => {
      const full = EN.names[p];
      if (full) return full.split(' ').length > 1 && !key.includes(' ') ? full.split(' ').slice(-1)[0] : full;
      const fam = Object.entries(EN.names).find(([k]) => k.split(/\s+/)[0] === p);
      return fam ? fam[1].split(' ').slice(-1)[0] : null;
    });
    if (parts.every(Boolean)) return parts.join(' & ');
  }
  return null;
}

// "When this card enters play, its card name becomes A or B instead of PAIR." (duo cards)
const DUO = /^このカードを登場させる際、このカードのカード名を「(.+?)」の代わりに「(.+?)」か「(.+?)」にする。(（[\s\S]*）)?$/;
function translateDuo(text) {
  const m = text.match(DUO);
  if (!m) return null;
  const [pair, a, b] = [m[1], m[2], m[3]].map(translateName);
  if (!pair || !a || !b) return null;
  return `When this card enters play, its card name becomes “${a}” or “${b}” instead of “${pair}”.`
    + (m[4] ? ' (The chosen name lasts until the end of that turn. This card counts as 1 character when counting the characters on your court.)' : '');
}

export function translateText(jp) {
  const key = norm(jp);
  if (!key || key === '-') return '';
  return EN.texts[key] ?? translateDuo(key) ?? null;
}

export { hasJapanese };
