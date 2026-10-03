import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
const OUT = "/home/user/keel/docs/brand/linkedin";
const F = "node_modules/geist/dist/fonts/geist-sans/";
const font = (w, f) => `@font-face{font-family:Geist;font-weight:${w};src:url(data:font/woff2;base64,${readFileSync(F + f).toString("base64")})}`;
const FONTS = font(400, "Geist-Regular.woff2") + font(500, "Geist-Medium.woff2") + font(600, "Geist-SemiBold.woff2") + font(700, "Geist-Bold.woff2");
const C = { blue: "#2b59ff", ink: "#0b0d12", muted: "#5b6170", bg: "#f7f8fa", line: "#e4e7ec", green: "#107244" };
const mark = (stroke, w = 2.25) => `<svg viewBox="0 0 32 32" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" style="width:100%;height:100%;display:block"><path d="M5.5 15.5h21l-2.7 5.2a3 3 0 0 1-2.66 1.6H10.86a3 3 0 0 1-2.66-1.6z"/><path d="M15 5.5v10"/><path d="M15 6.5l7 7.5h-7z"/><path d="M6 26.3c2.5 0 2.5-1.5 5-1.5s2.5 1.5 5 1.5 2.5-1.5 5-1.5 2.5 1.5 5 1.5"/></svg>`;
const waves = (op) => `<svg viewBox="0 0 1200 200" preserveAspectRatio="none" style="position:absolute;left:0;right:0;bottom:0;width:100%;height:38%;opacity:${op}"><path d="M0 120 Q75 90 150 120 T300 120 T450 120 T600 120 T750 120 T900 120 T1050 120 T1200 120 V200 H0Z" fill="#fff" opacity=".07"/><path d="M0 150 Q75 125 150 150 T300 150 T450 150 T600 150 T750 150 T900 150 T1050 150 T1200 150 V200 H0Z" fill="#fff" opacity=".07"/></svg>`;
const page = (w, h, body, bg = "transparent") => `<!doctype html><html><head><style>${FONTS}*{margin:0;box-sizing:border-box}html,body{width:${w}px;height:${h}px;background:${bg};font-family:Geist,sans-serif;overflow:hidden;-webkit-font-smoothing:antialiased}</style></head><body>${body}</body></html>`;

const T = {
  en: { eyebrow: "Operations platform for Shopify stores", title: "Run the whole store on one set of numbers.", chips: ["Orders & shipments", "Inventory & purchasing", "Returns", "CRM", "Real P/L per campaign"], post: "Campaign profit, net of cancellations and returns.", postSub: "Orders, stock, returns and Meta & Google ads on one data model.", cta: "Book a demo" },
  it: { eyebrow: "Piattaforma operativa per e-commerce Shopify", title: "Gestisci tutto il negozio su un solo insieme di numeri.", chips: ["Ordini e spedizioni", "Magazzino e acquisti", "Resi", "CRM", "P/L reale per campagna"], post: "Il profitto delle campagne, al netto di annullamenti e resi.", postSub: "Ordini, stock, resi e ads Meta e Google su un solo modello dati.", cta: "Prenota una demo" },
};
const chip = (t, s) => `<span style="display:inline-flex;align-items:center;gap:${s * .5}px;padding:${s * .55}px ${s * 1.1}px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.28);color:#fff;font-size:${s * 1.25}px;font-weight:500;white-space:nowrap"><i style="width:${s * .55}px;height:${s * .55}px;border-radius:9px;background:#7ee2b0;display:block"></i>${t}</span>`;
const blueBg = `background:radial-gradient(120% 140% at 85% 0%,#4a74ff 0%,${C.blue} 45%,#1d3fd1 100%)`;
const wordmark = (size, color, markColor) => `<div style="display:flex;align-items:center;gap:${size * .4}px;color:${color};font-size:${size}px;font-weight:600;letter-spacing:-.02em"><div style="width:${size * 1.25}px;height:${size * 1.25}px">${mark(markColor, 2.4)}</div>Hullwise</div>`;

const jobs = [];
// Logos
for (const s of [400, 1200]) {
  jobs.push([`logo-${s}.png`, s, s, `<div style="width:${s}px;height:${s}px;background:${C.blue};display:flex;align-items:center;justify-content:center"><div style="width:${s * .62}px;height:${s * .62}px">${mark("#fff", 2.2)}</div></div>`]);
}
jobs.push([`logo-white-400.png`, 400, 400, `<div style="width:400px;height:400px;background:#fff;display:flex;align-items:center;justify-content:center"><div style="width:250px;height:250px">${mark(C.blue, 2.2)}</div></div>`]);
jobs.push([`mark-transparent-1024.png`, 1024, 1024, `<div style="width:1024px;height:1024px;padding:96px">${mark(C.blue, 2.2)}</div>`, true]);
jobs.push([`wordmark-transparent.png`, 1600, 400, `<div style="width:1600px;height:400px;display:flex;align-items:center;justify-content:center">${wordmark(180, C.ink, C.blue)}</div>`, true]);
jobs.push([`wordmark-white-transparent.png`, 1600, 400, `<div style="width:1600px;height:400px;display:flex;align-items:center;justify-content:center">${wordmark(180, "#fff", "#fff")}</div>`, true]);

for (const [l, t] of Object.entries(T)) {
  // Company page cover: 4200x700 (LinkedIn displays ~1128x191). Logo overlaps bottom-left -> content right of ~22%.
  jobs.push([`company-cover-${l}.png`, 4200, 700, `<div style="position:relative;width:4200px;height:700px;${blueBg};overflow:hidden">${waves(1)}
    <div style="position:absolute;left:1150px;right:300px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:40px;padding-bottom:60px">
      <div style="color:rgba(255,255,255,.8);font-size:54px;font-weight:500;letter-spacing:.01em">${t.eyebrow}</div>
      <div style="color:#fff;font-size:116px;font-weight:700;letter-spacing:-.03em;line-height:1.02;text-wrap:balance">${t.title}</div>
      <div style="display:flex;gap:28px;flex-wrap:nowrap">${t.chips.map((c) => chip(c, 36)).join("")}</div>
    </div>
    <div style="position:absolute;right:120px;top:90px;opacity:.9">${wordmark(64, "#fff", "#fff")}</div></div>`]);
  // Personal profile banner 1584x396: photo overlaps bottom-left ~ 0-420px.
  jobs.push([`profile-banner-${l}.png`, 1584, 396, `<div style="position:relative;width:1584px;height:396px;${blueBg};overflow:hidden">${waves(1)}
    <div style="position:absolute;left:470px;right:70px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:18px">
      ${wordmark(34, "#fff", "#fff")}
      <div style="color:#fff;font-size:50px;font-weight:700;letter-spacing:-.03em;line-height:1.05;text-wrap:balance">${t.title}</div>
      <div style="color:rgba(255,255,255,.85);font-size:22px;font-weight:500">${t.eyebrow}</div>
    </div></div>`]);
  // Feed post images
  for (const [name, w, h, ts, ss, pad] of [["post-landscape", 1200, 627, 66, 26, 72], ["post-square", 1080, 1080, 84, 30, 88]]) {
    jobs.push([`${name}-${l}.png`, w, h, `<div style="position:relative;width:${w}px;height:${h}px;background:#fff;border-top:14px solid ${C.blue};display:flex;flex-direction:column;justify-content:space-between;padding:${pad}px">
      ${wordmark(ss * 1.4, C.ink, C.blue)}
      <div style="display:flex;flex-direction:column;gap:${ss}px">
        <div style="font-size:${ts}px;font-weight:700;letter-spacing:-.03em;line-height:1.05;color:${C.ink};text-wrap:balance">${t.post}</div>
        <div style="font-size:${ss * 1.1}px;color:${C.muted};line-height:1.35;max-width:92%">${t.postSub}</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;gap:${ss * .6}px;flex-wrap:wrap;max-width:75%">${t.chips.slice(0, w > 1100 ? 3 : 2).map((c) => `<span style="padding:${ss * .35}px ${ss * .8}px;border-radius:999px;background:#f1f3f6;color:${C.ink};font-size:${ss * .8}px;font-weight:500">${c}</span>`).join("")}</div>
        <span style="padding:${ss * .5}px ${ss}px;border-radius:10px;background:${C.blue};color:#fff;font-size:${ss * .85}px;font-weight:600;white-space:nowrap">${t.cta} →</span>
      </div></div>`]);
  }
}

const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }).catch(async () => chromium.launch());
for (const [file, w, h, body, transparent] of jobs) {
  const p = await b.newPage({ viewport: { width: w, height: h } });
  await p.setContent(page(w, h, body));
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${OUT}/${file}`, omitBackground: !!transparent });
  await p.close();
  console.log(file);
}
await b.close();
