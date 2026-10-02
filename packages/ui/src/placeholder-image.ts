/**
 * Deterministic placeholder product photos (issue #19) for the demo catalog: an SVG drawn from the
 * product handle and the option value it shows (colour, finish…). Served by the app, never by an
 * external CDN. Colours here are image content, not UI: they do not follow the theme tokens.
 */

const SWATCHES: Record<string, string> = {
  black: "#24262b", "matte black": "#2b2b2d", navy: "#1f2a44", sand: "#d8c3a5", olive: "#6b6b3a", ivory: "#f1ece0", burgundy: "#6d1f2f", grey: "#8a8d91", gray: "#8a8d91", rust: "#a4492b",
  natural: "#d9c9a8", "linen white": "#ece8de", sage: "#9caf88", terracotta: "#c0643f", oak: "#b58b5a", walnut: "#6b4a32", ash: "#cfc5b4", steel: "#8e969c", brass: "#b5a160",
  white: "#f4f4f2", red: "#b23a3a", blue: "#2f5d9e", green: "#3f7a4f", pink: "#e3a1b0", yellow: "#e2c044", brown: "#7a5236", beige: "#d9c7a7", cream: "#f2e8d0", orange: "#d9772f", purple: "#6c4a8a", gold: "#c9a43a", silver: "#b9bcc0",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return `#${hex2(f(0))}${hex2(f(8))}${hex2(f(4))}`;
}
function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return `#${hex2(r1 + (r2 - r1) * t)}${hex2(g1 + (g2 - g1) * t)}${hex2(b1 + (b2 - b1) * t)}`;
}
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const titleCase = (s: string) => s.replace(/-/g, " ").replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase());

/** The swatch colour of an option value: a known colour word, else a stable hue from the text. */
export function swatchColor(label: string): string {
  const key = label.trim().toLowerCase().replace(/-/g, " ");
  return SWATCHES[key] ?? hslToHex(hash(key) % 360, 0.38, 0.55);
}

const SHAPES = [
  // garment
  "M420 380 L520 330 Q600 390 680 330 L780 380 L900 520 L820 590 L780 560 L780 1080 Q600 1110 420 1080 L420 560 L380 590 L300 520 Z",
  // vessel
  "M520 360 L680 360 L680 450 Q860 560 840 820 Q820 1080 600 1100 Q380 1080 360 820 Q340 560 520 450 Z",
  // object on a stand
  "M380 420 Q380 380 420 380 L780 380 Q820 380 820 420 L820 860 Q820 900 780 900 L640 900 L660 1080 L540 1080 L560 900 L420 900 Q380 900 380 860 Z",
  // soft goods
  "M360 520 Q600 400 840 520 Q900 760 840 1000 Q600 1120 360 1000 Q300 760 360 520 Z",
];

export interface PlaceholderInput {
  /** Product handle: decides the silhouette and the title line. */
  handle: string;
  /** Option value shown (colour, finish…) or "detail" for the close-up. */
  label: string;
  /** Position in the gallery (1-based), part of the seed. */
  position: number;
}

/** A 4:5 product photo placeholder as an SVG document. */
export function placeholderProductSvg({ handle, label, position }: PlaceholderInput): string {
  const detail = label === "detail";
  const base = swatchColor(detail ? handle : label);
  const dark = luminance(base) < 0.5;
  const bgTop = mix(base, "#ffffff", dark ? 0.82 : 0.6);
  const bgBottom = mix(base, "#ffffff", dark ? 0.68 : 0.4);
  const ink = mix(base, "#000000", 0.55);
  const shape = SHAPES[hash(handle) % SHAPES.length]!;
  const title = escapeXml(titleCase(handle).slice(0, 34));
  const caption = escapeXml(detail ? "Detail" : titleCase(label).slice(0, 28));
  const tilt = (hash(`${handle}:${position}`) % 9) - 4;
  const body = detail
    ? `<g transform="rotate(${tilt} 600 700)"><rect x="180" y="280" width="840" height="840" rx="36" fill="${base}"/>${Array.from({ length: 14 }, (_, i) => `<rect x="${180 + i * 60}" y="280" width="18" height="840" fill="${mix(base, dark ? "#ffffff" : "#000000", 0.12)}"/>`).join("")}<circle cx="600" cy="700" r="120" fill="none" stroke="${mix(base, "#ffffff", 0.5)}" stroke-width="10" stroke-dasharray="18 14"/></g>`
    : `<ellipse cx="600" cy="1130" rx="300" ry="34" fill="${ink}" opacity="0.18"/><g transform="rotate(${tilt} 600 740)"><path d="${shape}" fill="${base}" stroke="${mix(base, "#000000", 0.25)}" stroke-width="6"/><path d="${shape}" fill="url(#sheen)"/></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1500" width="1200" height="1500" role="img" aria-label="${title} – ${caption}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBottom}"/></linearGradient><linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.12"/></linearGradient></defs>
<rect width="1200" height="1500" fill="url(#bg)"/>
${body}
<text x="600" y="1300" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="64" font-weight="600" fill="${ink}">${caption}</text>
<text x="600" y="1380" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="40" fill="${ink}" opacity="0.7">${title}</text>
</svg>`;
}

/** Parses `/demo-media/<handle>/<n>-<label>.svg`; null when the path is not one. */
export function parsePlaceholderPath(segments: readonly string[]): PlaceholderInput | null {
  if (segments.length !== 2) return null;
  const [handle, file] = segments as [string, string];
  const m = /^(\d{1,3})-([a-z0-9-]{1,80})\.svg$/.exec(file);
  if (!/^[a-z0-9-]{1,120}$/.test(handle) || !m) return null;
  return { handle, position: Number(m[1]), label: m[2]! };
}
