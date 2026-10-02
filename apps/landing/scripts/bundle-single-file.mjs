/**
 * Builds a single self-contained HTML file of one exported landing page, for previews on hosts
 * that wrap the page in their own document or serve it under an unknown path (artifact viewers,
 * sandboxed iframes, email attachments). The Next.js runtime is dropped on purpose: its client
 * router would treat the host path as an unknown route. Styles, fonts, favicon and screenshots are
 * inlined, `srcset` is removed, and a small vanilla script re-implements the interactive parts
 * (carousel, pricing toggle, mobile menu, contact form, in-page links).
 *
 *   pnpm --filter @keel/landing build
 *   node scripts/bundle-single-file.mjs en out/index.html    preview-en.html --other-locale-url=https://…
 *   node scripts/bundle-single-file.mjs it out/it/index.html preview-it.html --other-locale-url=https://…
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  ANNUAL_MONTHS_CHARGED,
  FOUNDING_OFFER,
  PLANS,
  PRICING_CURRENCY,
} from "../src/config/pricing.ts";

const [locale, input, output, ...rest] = process.argv.slice(2);
if (!locale || !input || !output) {
  console.error(
    "usage: bundle-single-file.mjs <locale> <out/.../index.html> <output.html> [--other-locale-url=URL]",
  );
  process.exit(1);
}
const otherUrl = (rest.find((a) => a.startsWith("--other-locale-url=")) ?? "")
  .split("=")
  .slice(1)
  .join("=");
const OUT = join(process.cwd(), "out");
const MIME = {
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
const messages = JSON.parse(
  readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
);
const INTL = { en: "en-US", it: "it-IT", es: "es-ES" }[locale] ?? locale;
const price = (n) =>
  new Intl.NumberFormat(INTL, {
    style: "currency",
    currency: PRICING_CURRENCY,
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
    useGrouping: "always",
  }).format(n);
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const dataUri = (p) => {
  const file = join(OUT, p.replace(/^\.?\//, ""));
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  return `data:${MIME[extname(file)] ?? "application/octet-stream"};base64,${readFileSync(file).toString("base64")}`;
};
const readOut = (p) => readFileSync(join(OUT, p.replace(/^\.?\//, "")), "utf8");

let html = readFileSync(input, "utf8");

// Stylesheets → <style>, fonts inlined. Every script of the Next runtime is dropped.
html = html.replace(
  /<link rel="stylesheet" href="([^"]+)"[^>]*>/g,
  (_, href) =>
    `<style>${readOut(href).replace(/url\((\/_next\/static\/media\/[^)]+)\)/g, (_m, p) => `url(${dataUri(p)})`)}</style>`,
);
html = html.replace(/<link rel="preload"[^>]*>/g, "");
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
// Images: one size, inlined, no srcset/sizes.
html = html.replace(/<img ([^>]*)>/g, (_, attrs) => {
  const srcset = attrs.match(/srcSet="([^"]*)"/i)?.[1];
  let src = attrs.match(/src="([^"]*)"/)?.[1] ?? "";
  if (srcset) {
    const candidates = srcset.split(",").map((c) => c.trim().split(/\s+/));
    src = (candidates.find(([, w]) => w === "1440w") ?? candidates.at(-1))?.[0] ?? src;
  }
  // Everything is inline, so lazy loading only delays paint: load eagerly.
  const cleaned = attrs
    .replace(/\s*srcSet="[^"]*"/i, "")
    .replace(/\s*sizes="[^"]*"/i, "")
    .replace(/loading="lazy"/, 'loading="eager"')
    .replace(/src="[^"]*"/, `src="${dataUri(src)}"`);
  return `<img ${cleaned}>`;
});
html = html.replace(/href="\/favicon\.svg"/g, `href="${dataUri("/favicon.svg")}"`);
html = html.replace(/<link rel="(canonical|alternate)"[^>]*>/g, "");
html = html.replace(/content="http:\/\/localhost:3100\/[^"]*"/g, 'content=""');
// Cross-locale links → the other preview (top-level navigation). Same-page links → hashes.
const own = locale === "en" ? "/" : `/${locale}/`;
const other = locale === "en" ? "/it/" : "/";
if (otherUrl)
  html = html
    .replaceAll(`href="${other}#`, `target="_top" href="${otherUrl}#`)
    .replaceAll(`href="${other}"`, `target="_top" href="${otherUrl}"`);
html = html.replaceAll(`href="${own}#`, 'href="#').replaceAll(`href="${own}"`, 'href="#main"');

// Pricing: both billing states pre-rendered from the same config and copy as the React component.
const t = messages.pricing;
const priceBlocks = PLANS.map((plan) => {
  if (plan.monthlyPrice === null) return null;
  const block = (annual) => {
    const base = annual
      ? Math.round((plan.monthlyPrice * ANNUAL_MONTHS_CHARGED) / 12)
      : plan.monthlyPrice;
    const founding = FOUNDING_OFFER.enabled && !annual;
    const shown = founding ? Math.round(base * (1 - FOUNDING_OFFER.discountPercent / 100)) : base;
    return (
      `<p class="flex items-baseline gap-1"><span class="text-4xl font-semibold tracking-tight tabular">${price(shown)}</span><span class="text-sm text-muted-foreground">${esc(t.per_month)}</span></p>` +
      (founding
        ? `<p class="mt-1 text-xs text-muted-foreground line-through">${esc(fill(t.list_price, { price: price(base) }))}</p>`
        : "") +
      (annual
        ? `<p class="mt-1 text-xs text-muted-foreground">${esc(fill(t.billed_annually, { total: price(shown * 12) }))}</p>`
        : "")
    );
  };
  return { monthly: block(false), annual: block(true) };
});

const script = `
<script>
(function () {
  // In-page links scroll without changing the URL (a sandboxed frame has no usable URL).
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]'); if (!a) return;
    var el = document.getElementById(a.getAttribute("href").slice(1)); if (!el) return;
    e.preventDefault(); el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // Mobile menu.
  var menuBtn = document.querySelector('button[aria-controls="mobile-nav"]'), nav = document.getElementById("mobile-nav");
  if (menuBtn && nav) menuBtn.addEventListener("click", function () { var open = nav.classList.toggle("hidden"); menuBtn.setAttribute("aria-expanded", String(!open)); });
  // Pricing toggle.
  var blocks = ${JSON.stringify(priceBlocks)};
  var group = document.querySelector('#pricing [role="group"]');
  if (group) {
    var btns = group.querySelectorAll("button"), cards = document.querySelectorAll("#pricing > div > ul > li"), banner = group.parentElement.querySelector(".rounded-md.border.px-4");
    function setAnnual(annual) {
      btns.forEach(function (b, i) { var on = (i === 1) === annual; b.setAttribute("aria-pressed", String(on)); b.classList.toggle("bg-primary", on); b.classList.toggle("text-primary-foreground", on); b.classList.toggle("text-muted-foreground", !on); });
      cards.forEach(function (card, i) { var b = blocks[i]; if (!b) return; card.querySelector(".min-h-20").innerHTML = annual ? b.annual : b.monthly; });
      if (banner) { banner.classList.toggle("opacity-70", annual); }
    }
    btns[0].addEventListener("click", function () { setAnnual(false); });
    btns[1].addEventListener("click", function () { setAnnual(true); });
  }
  // Carousel.
  var region = document.querySelector('[aria-roledescription="carousel"]');
  if (region) {
    var track = region.querySelector("[data-carousel-track]"), slides = Array.prototype.slice.call(track.children), tabs = region.querySelectorAll('[role="tab"]'), dots = region.querySelectorAll('[aria-hidden="true"] > button');
    var ctl = region.querySelectorAll(".flex.items-center.gap-2 > button"), pauseBtn = ctl[0], prevBtn = ctl[1], nextBtn = ctl[2], counter = region.querySelector('[aria-live="polite"]');
    var index = 0, autoplay = true, paused = false, total = slides.length, timer = null;
    var pauseIcon = pauseBtn.innerHTML, playIcon = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-4" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
    var labels = ${JSON.stringify({ pause: messages.modules.pause, play: messages.modules.play, slide: messages.modules.slide })};
    function render() {
      tabs.forEach(function (tab, i) { var on = i === index; tab.setAttribute("aria-selected", String(on)); tab.classList.toggle("border-primary", on); tab.classList.toggle("bg-primary", on); tab.classList.toggle("text-primary-foreground", on); tab.classList.toggle("border-border", !on); tab.classList.toggle("bg-card", !on); tab.classList.toggle("text-muted-foreground", !on); });
      dots.forEach(function (d, i) { var on = i === index; d.classList.toggle("w-6", on); d.classList.toggle("bg-primary", on); d.classList.toggle("w-1.5", !on); d.classList.toggle("bg-border", !on); });
      counter.textContent = labels.slide.replace("{n}", index + 1).replace("{total}", total);
      pauseBtn.innerHTML = autoplay ? pauseIcon : playIcon; pauseBtn.setAttribute("aria-label", autoplay ? labels.pause : labels.play); pauseBtn.setAttribute("aria-pressed", String(!autoplay));
    }
    function scrollTo(i) { var s = slides[i]; track.scrollTo({ left: s.offsetLeft - track.offsetLeft, behavior: "smooth" }); }
    function go(i) { autoplay = false; schedule(); scrollTo(((i % total) + total) % total); }
    function schedule() { clearInterval(timer); timer = null; if (!autoplay || paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { render(); return; } timer = setInterval(function () { scrollTo((index + 1) % total); }, 6000); render(); }
    track.addEventListener("scroll", function () { var left = track.scrollLeft + track.offsetLeft, best = 0, bd = Infinity; slides.forEach(function (s, i) { var d = Math.abs(s.offsetLeft - left); if (d < bd) { bd = d; best = i; } }); if (best !== index) { index = best; render(); } }, { passive: true });
    tabs.forEach(function (tab, i) { tab.addEventListener("click", function () { go(i); }); });
    dots.forEach(function (d, i) { d.addEventListener("click", function () { go(i); }); });
    prevBtn.addEventListener("click", function () { go(index - 1); }); nextBtn.addEventListener("click", function () { go(index + 1); });
    pauseBtn.addEventListener("click", function () { autoplay = !autoplay; schedule(); });
    region.addEventListener("mouseenter", function () { paused = true; schedule(); }); region.addEventListener("mouseleave", function () { paused = false; schedule(); });
    schedule();
  }
  // Contact form → prefilled email.
  var form = document.querySelector("#contact form");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = function (id) { var el = form.querySelector("#" + id); return el ? el.value.trim() : ""; };
    if (!v("name") || !v("email") || !v("message")) { form.reportValidity(); return; }
    var body = [v("name"), v("email"), v("store"), v("orders"), "", v("message")].filter(function (x, i) { return x || i === 4; }).join("\\n");
    window.open("mailto:${esc(process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? "federico@automationslab.it")}" + "?subject=" + encodeURIComponent("Keel – " + v("name")) + "&body=" + encodeURIComponent(body), "_top");
  });
})();
</script>`;
html = html.replace("</body>", `${script}</body>`);

writeFileSync(output, html);
console.info(`[bundle] ${output} ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB`);
