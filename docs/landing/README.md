# Hullwise landing page (`apps/landing`)

Static marketing site for the product, built with Next.js (static export) and Tailwind in the same
monorepo as the app. English at `/`, Italian at `/it/`, Spanish at `/es/`, same i18n approach as the
product (next-intl, one JSON file per language, a test that fails when a key is missing in one language).

It uses the product's direction A theme: `@import "@hullwise/ui/theme.css"` in `src/app/globals.css`
(tokens, Tailwind mapping, dark variant, base layer) and Geist from `@hullwise/ui/font-sans`. Only two
marketing tokens are declared locally; `src/landing/theme.test.ts` fails if a shared one is redefined.
The theme follows the OS setting (the app's `SYSTEM_THEME_SCRIPT`).

The screenshots in this folder are the landing itself, captured by `pnpm --filter @hullwise/landing screenshots`:

| File                        | What                             |
| --------------------------- | -------------------------------- |
| `<locale>-desktop.png`      | Full page at 1440px, light theme |
| `<locale>-mobile.png`       | Full page at 390px (2x), light   |
| `<locale>-desktop-dark.png` | Full page at 1440px, dark theme  |

## Run it locally

```bash
pnpm install
pnpm --filter @hullwise/landing dev        # http://localhost:3100 with hot reload
```

Production build and preview of the exported site:

```bash
pnpm --filter @hullwise/landing build      # writes apps/landing/out
pnpm --filter @hullwise/landing start      # serves out/ on http://localhost:3100
```

Quality gate (also run by `pnpm lint && pnpm typecheck && pnpm test && pnpm build` at the root):

```bash
pnpm --filter @hullwise/landing lint typecheck test
```

### Environment variables

Copy `apps/landing/.env.example` to `apps/landing/.env.local` (or set them on Vercel). All are
public (`NEXT_PUBLIC_*`) because the site is static and the browser needs them.

| Variable                          | Purpose                                                                                      | Default                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_SITE_URL`            | Canonical URL for hreflang, Open Graph and the sitemap. **Set it in production.**            | `http://localhost:3100`                  |
| `NEXT_PUBLIC_DEMO_URL`            | External booking link for every "Book a demo" button (Calendly, Cal.com, HubSpot…).          | empty → `mailto:`                        |
| `NEXT_PUBLIC_CONTACT_EMAIL`       | Address used by the `mailto:` fallbacks.                                                     | `federico@automationslab.it`             |
| `NEXT_PUBLIC_CONTACT_WEBHOOK_URL` | Endpoint that receives the contact form as a JSON `POST`. Must accept cross-origin requests. | empty → the form opens a prefilled email |
| `NEXT_PUBLIC_APP_URL`             | URL of the Hullwise app, for "Sign in" and the links to the integration guides.                  | `http://localhost:3000`                  |
| `NEXT_PUBLIC_STUDIO_URL`          | Automations Lab site, linked (with UTM tags) from the add-ons section and the footer for custom builds. | `https://automationslab.it`              |

Contact form payload: `{ name, email, store, orders, message, locale, source: "landing", submittedAt }`.
A hidden honeypot field and a minimum fill time (3 s) drop bot submissions client-side; the webhook
should still rate-limit. A privacy notice (`contact.privacy`) is shown under the button in every language.

## Change prices, plans and the founding offer

Everything numeric lives in **one file**: `apps/landing/src/config/pricing.ts`.

- `PLANS`: monthly price, included orders, setup fee (`setupFeeFrom: true` renders "from"), feature
  identifiers, `recommended` flag, `inheritsFrom` (renders "Everything in X, plus:").
- `OVERAGE`: price per block of extra orders.
- `ANNUAL_MONTHS_CHARGED`: 10 means two months free on annual billing.
- `ADDONS`: monthly price (must equal `monthlyPriceMinor` of the add-on module in `@hullwise/config`) or
  on quote. An add-on is listed only once it is built.
- `FOUNDING_OFFER`: `enabled`, `discountPercent`, `months`, `seats`. Set `enabled: false` to remove
  every mention of the offer. The discount applies to monthly billing; the annual toggle shows list
  prices with the two free months.
- `STACK_COMPARISON`: the "what a specialised stack costs" figures and the revenue band.

The words (plan names, taglines, feature labels, FAQ answers) live in `apps/landing/messages/en.json`
and `it.json` under `pricing.*`, `addons.*` and `faq.*`. Feature identifiers in `pricing.ts` map to
`pricing.features.<id>`; adding a feature means one line in the config and one key per language
(the test `messages.test.ts` fails if a language is missing it).

Unit tests for the pricing helpers and the mirror of `@hullwise/config` (plans, overage, audit retention,
add-on prices): `apps/landing/src/config/pricing.test.ts`.

## Claims must match the product

`src/config/claims.ts` maps every feature the page names (module slides, "also included" cards, plan
lines, add-ons, FAQ answers, how-it-works steps, comparison lines) to module keys of `@hullwise/config`,
or marks it as a service or a commercial term. The components read their item lists from it.
`claims.test.ts` fails when a key does not exist or is not implemented, when a plan lists a module the
plan does not include (`isModuleInPlan`), when a built add-on is missing, or when a "Coming soon"
feature (`COMING_SOON`, with its issue) is claimed anywhere else. To ship a feature that was coming
soon: remove it from `COMING_SOON`, add its claim and copy.

## Change the copy or add a language

- Copy: `apps/landing/messages/<locale>.json`. No visible string is hardcoded in components.
- New language: add `messages/<locale>.json`, add the code to `LANDING_LOCALES` in
  `src/config/site.ts`, register it in `src/i18n/messages.ts` and `src/i18n/messages.test.ts`, add
  the `Intl` locale in `src/lib/format.ts` and the Open Graph locale in `src/landing/metadata.ts`,
  and create a route group `src/app/(<locale>)/<locale>/` with the three one-line files you find in
  `src/app/(it)/it/` (layout, page, opengraph-image). Hreflang, sitemap and the language switch pick it up.

## Modules carousel

The modules section is a horizontal carousel (`src/components/modules-carousel.tsx`): scroll-snap
track, tab strip with the module names, previous/next buttons and auto-advance every 6 seconds that
stops on the first interaction. Order and screenshots per module: `MODULE_SLIDES` in
`src/config/claims.ts`. Interval: `AUTOPLAY_MS` in the carousel component.

## Product screenshots

The landing shows real screens of the demo tenant **Harbor Home** (no add-ons, so nothing
payment-specific appears in the navigation), in the light theme, in en/it/es. Only demo data is
shown. The assistant screen opens Harbor's seeded conversation in English; for Italian and Spanish
the capture asks the same question in that language (delete those threads before capturing again,
or they show up in the conversation list), and it hides the "simulated connection" notice, which
only exists in the mock demo.

To regenerate after a product change:

```bash
# 1. Product running with the demo seed (see the root README), production build on :3000
pnpm --filter @hullwise/web build && pnpm --filter @hullwise/web start

# 2. Capture the screens (PNG, 2x, viewport only) into apps/landing/screenshots-src (git-ignored)
#    APP_BASE_URL=http://localhost:<port> if the app is not on :3000
pnpm --filter @hullwise/landing capture:product

# 3. Convert to the WebP sizes the page uses (apps/landing/public/screenshots/<locale>/)
pnpm --filter @hullwise/landing images
```

Which screens and which sizes: `apps/landing/src/config/screenshots.ts` (names match
`scripts/capture-product.mjs`). Alt texts: `modules.items.*.alt` and `hero.screenshot_alt` in the
message files.

## Deploy on Vercel

1. Import the repository and set **Root Directory** to `apps/landing` (keep "Include source files
   outside of the Root Directory" enabled: the landing imports `@hullwise/config` from the workspace).
2. Framework preset: **Next.js**. Vercel detects the pnpm workspace from the root lockfile; the
   default build command (`next build`) produces the static export in `out/`.
3. Environment variables: at least `NEXT_PUBLIC_SITE_URL` (the production domain) and, when ready,
   `NEXT_PUBLIC_DEMO_URL`, `NEXT_PUBLIC_CONTACT_WEBHOOK_URL`, `NEXT_PUBLIC_APP_URL`.
4. `apps/landing/vercel.json` sets the `image/png` content type on the generated Open Graph images
   and long cache headers on the screenshots.

Any other static host works too: upload the contents of `apps/landing/out` after `pnpm --filter @hullwise/landing build`.
The server in `scripts/serve.mjs` mirrors the expected routing (`/it/` → `it/index.html`, `404.html`),
compresses text with brotli or gzip and caches the hashed `/_next/static` files for a year. Lighthouse
mobile on that server: performance 97–99, accessibility 100, best practices 100, SEO 100.

## Single-file preview

`scripts/bundle-single-file.mjs` turns one exported page into a self-contained HTML file (styles,
fonts, favicon and screenshots inlined; the Next runtime replaced by a small vanilla script for the
carousel, pricing toggle, mobile menu, contact form and in-page links). Use it to share a preview by
email or on a host that wraps pages in its own document and cannot serve sibling files:

```bash
pnpm --filter @hullwise/landing build
cd apps/landing
node scripts/bundle-single-file.mjs en out/index.html    preview-en.html --other-locale-url=<url of the Italian preview>
node scripts/bundle-single-file.mjs it out/it/index.html preview-it.html --other-locale-url=<url of the English preview>
```

The real deployment does not need this: on Vercel or any static host the `out/` folder is served as is.

## Placeholders left on purpose

No testimonials, customer logos, customer counts or result metrics are rendered: a commented
placeholder sits in `src/components/final-cta.tsx` for when real, approved ones exist. The page
claims no certification.
