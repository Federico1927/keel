/**
 * Word-level ads analysis (issue #40): the platforms report nothing below the asset or the search
 * term, so Hullwise splits ad copy, search terms and keywords into 1–3 word phrases and sums the
 * metrics of every item that contains a phrase. Pure: no I/O, the services feed it rows.
 */

/** Stop words per language; phrases never start or end with one and a phrase made only of them is dropped. */
export const STOP_WORDS: Record<string, readonly string[]> = {
  en: ["a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "by", "from", "up", "about", "into", "over", "after", "is", "are", "was", "were", "be", "been", "it", "its", "this", "that", "these", "those", "you", "your", "yours", "we", "our", "us", "they", "their", "i", "me", "my", "he", "she", "his", "her", "as", "so", "if", "than", "then", "too", "very", "can", "will", "just", "all", "any", "more", "most", "no", "not", "only", "own", "same", "such", "now", "do", "does", "did", "has", "have", "had", "what", "which", "who", "how", "when", "where", "why", "here", "there", "s", "t"],
  it: ["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "a", "da", "in", "con", "su", "per", "tra", "fra", "e", "ed", "o", "od", "ma", "se", "che", "chi", "cui", "non", "del", "dello", "della", "dei", "degli", "delle", "al", "allo", "alla", "ai", "agli", "alle", "dal", "dallo", "dalla", "dai", "dagli", "dalle", "nel", "nello", "nella", "nei", "negli", "nelle", "sul", "sullo", "sulla", "sui", "sugli", "sulle", "col", "coi", "è", "sono", "sei", "siamo", "siete", "ho", "hai", "ha", "abbiamo", "avete", "hanno", "mi", "ti", "ci", "vi", "si", "ne", "tuo", "tua", "tuoi", "tue", "mio", "mia", "suo", "sua", "nostro", "nostra", "vostro", "vostra", "questo", "questa", "questi", "queste", "quello", "quella", "più", "piu", "anche", "come", "dove", "quando", "l", "d", "all", "dall", "nell", "sull"],
  es: ["el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "a", "al", "en", "con", "por", "para", "sin", "sobre", "entre", "y", "e", "o", "u", "pero", "si", "que", "quien", "no", "es", "son", "ser", "está", "esta", "están", "estan", "lo", "le", "les", "se", "su", "sus", "tu", "tus", "mi", "mis", "nuestro", "nuestra", "este", "esta", "estos", "estas", "ese", "esa", "más", "mas", "muy", "también", "tambien", "como", "donde", "cuando", "ya", "hay"],
};

const extraStopWords = new Map<string, Set<string>>();

/** Adds stop words for a language (a tenant language not shipped here, or brand words to ignore). */
export function registerStopWords(lang: string, words: readonly string[]): void {
  const set = extraStopWords.get(lang) ?? new Set<string>();
  for (const w of words) set.add(normalizeToken(w));
  extraStopWords.set(lang, set);
}

/** Stop words of the given languages (English is always included: ad copy mixes it in). */
export function stopWordsFor(langs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const l of new Set(["en", ...langs.map((x) => x.slice(0, 2).toLowerCase())])) {
    for (const w of STOP_WORDS[l] ?? []) out.add(normalizeToken(w));
    for (const w of extraStopWords.get(l) ?? []) out.add(w);
  }
  return out;
}

function normalizeToken(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Lower-cased, accent-folded word tokens; punctuation splits, numbers are kept ("50%" → "50"). */
export function tokenize(text: string): string[] {
  return normalizeToken(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Distinct phrases of 1..maxN words of one text; none starts or ends with a stop word. */
export function phrasesOf(text: string, stop: Set<string>, maxN = 3): string[] {
  const tokens = tokenize(text);
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (stop.has(tokens[i]!)) continue;
    for (let n = 1; n <= maxN && i + n <= tokens.length; n++) {
      const last = tokens[i + n - 1]!;
      if (stop.has(last)) continue;
      out.add(tokens.slice(i, i + n).join(" "));
    }
  }
  return [...out];
}

export interface NgramItem {
  /** Copy (headline + body), search term or keyword text. */
  text: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  /** Conversions the platform reports. */
  conversions: number;
  /** Hullwise's own numbers: orders that count as a sale, their net revenue and margin. */
  orders: number;
  netRevenueMinor: number;
  marginMinor: number;
}

export interface NgramRow {
  phrase: string;
  n: number;
  /** Items (ads, search terms, keywords) containing the phrase. */
  items: number;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  orders: number;
  netRevenueMinor: number;
  marginMinor: number;
  /** Margin of Hullwise's orders minus spend: the same definition as campaign profit. */
  profitMinor: number;
  /** Hullwise net revenue / spend (spend-weighted by construction). */
  roas: number | null;
  ctr: number | null;
  /** Conversions per click (conversion-weighted by construction). */
  conversionRate: number | null;
}

export interface NgramOptions {
  langs: readonly string[];
  maxN?: number;
  /** A phrase must appear in at least this many items… */
  minItems?: number;
  /** …and reach this spend or these impressions, so rare words do not produce noise. */
  minSpendMinor?: number;
  minImpressions?: number;
}

/**
 * Each item contributes its full metrics to every distinct phrase it contains, so a phrase's spend
 * is the spend of the items using it and its ROAS and conversion rate are weighted by spend and
 * clicks. Sums over phrases double-count by design (a two-word phrase and its words overlap).
 */
export function ngramStats(items: readonly NgramItem[], opts: NgramOptions): NgramRow[] {
  const stop = stopWordsFor(opts.langs);
  const maxN = Math.min(3, Math.max(1, opts.maxN ?? 3));
  const acc = new Map<string, NgramRow>();
  for (const it of items) {
    for (const phrase of phrasesOf(it.text, stop, maxN)) {
      let r = acc.get(phrase);
      if (!r) {
        r = { phrase, n: phrase.split(" ").length, items: 0, spendMinor: 0, impressions: 0, clicks: 0, conversions: 0, orders: 0, netRevenueMinor: 0, marginMinor: 0, profitMinor: 0, roas: null, ctr: null, conversionRate: null };
        acc.set(phrase, r);
      }
      r.items++;
      r.spendMinor += it.spendMinor;
      r.impressions += it.impressions;
      r.clicks += it.clicks;
      r.conversions += it.conversions;
      r.orders += it.orders;
      r.netRevenueMinor += it.netRevenueMinor;
      r.marginMinor += it.marginMinor;
    }
  }
  const minItems = opts.minItems ?? 2;
  const minSpend = opts.minSpendMinor ?? 0;
  const minImpr = opts.minImpressions ?? 0;
  const rows: NgramRow[] = [];
  for (const r of acc.values()) {
    if (r.items < minItems) continue;
    if (r.spendMinor < minSpend && r.impressions < minImpr) continue;
    r.profitMinor = r.marginMinor - r.spendMinor;
    r.roas = r.spendMinor > 0 ? r.netRevenueMinor / r.spendMinor : null;
    r.ctr = r.impressions > 0 ? r.clicks / r.impressions : null;
    r.conversionRate = r.clicks > 0 ? r.conversions / r.clicks : null;
    rows.push(r);
  }
  return rows.sort((a, b) => b.profitMinor - a.profitMinor || b.spendMinor - a.spendMinor || a.phrase.localeCompare(b.phrase));
}

export type NgramSort = "profit" | "roas" | "spend";

/** Winners (best first) and losers (worst first) by profit or ROAS; ROAS ignores phrases without spend. */
export function rankNgrams(rows: readonly NgramRow[], sort: NgramSort, limit = 20): { winners: NgramRow[]; losers: NgramRow[] } {
  const key = (r: NgramRow) => (sort === "roas" ? (r.roas ?? -1) : sort === "spend" ? r.spendMinor : r.profitMinor);
  const pool = sort === "roas" ? rows.filter((r) => r.spendMinor > 0) : [...rows];
  const sorted = [...pool].sort((a, b) => key(b) - key(a) || b.spendMinor - a.spendMinor || a.phrase.localeCompare(b.phrase));
  const winners = sorted.filter((r) => (sort === "spend" ? true : r.profitMinor > 0)).slice(0, limit);
  const losers = [...sorted].reverse().filter((r) => r.profitMinor < 0).slice(0, limit);
  return { winners, losers };
}
