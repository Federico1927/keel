import { PRODUCT_NAME } from "@hullwise/config";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@hullwise/core";
import { TOKENS } from "@hullwise/ui/tokens";
import en from "./messages/en.json";
import es from "./messages/es.json";
import it from "./messages/it.json";

/**
 * Typed email templates (issue #51): props per template, subject and body in en/it/es from the
 * translation files in ./messages (a test keeps their keys identical), HTML and plain text,
 * one layout with the product mark, the product name from PRODUCT_NAME and a footer with the
 * legal sender and the support address. Colours are direction A tokens (@hullwise/ui/tokens), with a
 * dark-scheme override for clients that honour `prefers-color-scheme`.
 */
export const EMAIL_LOCALES = ["en", "it", "es"] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/** security: account access, ignores preferences and complaints, never sent after its link expires. transactional: asked for by the person. notification: optional, unsubscribable. */
export type EmailKind = "security" | "transactional" | "notification";

export interface EmailTemplateData {
  magic_link: { url: string; minutes: number };
  email_change_confirm: { url: string; hours: number };
  email_change_notice: { newEmail: string };
  invite: { tenantName: string; inviterName: string; role: string; url: string; days: number };
  welcome: { name: string; tenantName: string; dashboardUrl: string; profileUrl: string; /** Owners only. */ guideUrl: string | null };
  password_reset: { url: string; minutes: number };
  password_changed: { at: Date | string; timezone: string };
  email_changed: { newEmail: string };
  new_sign_in: { device: string; ip: string | null; at: Date | string; timezone: string; profileUrl: string };
  account_disabled: { tenantName: string };
  mention: { authorName: string; recordLabel: string; excerpt: string; url: string };
  supplier_po: { companyName: string; supplierName: string; poNumber: string; url: string; expectedAt: Date | string | null; timezone: string };
  digest: { tenantName: string; groups: { type: string; count: number; titles: string[] }[]; url: string };
  notification: { title: string; body: string | null; url: string | null; type: string };
  test: { provider: string; sentAt: Date | string };
  /** Delivery instruction for a parcel in exception, to the carrier's customer service (issue #28). */
  /** Link to start the Hullwise subscription (Stripe Checkout), to the customer's billing contact (issue #53). */
  billing_checkout: { tenantName: string; planName: string; lines: { kind: "plan" | "addon" | "setup"; key: string; amountMinor: number }[]; currency: string; trialDays: number; url: string; expiresAt: Date | string | null; timezone: string };
  carrier_instruction: { companyName: string; carrier: string | null; trackingNumber: string; orderName: string; resolution: "redeliver" | "new_address" | "pickup_point" | "return"; address: { name?: string | null; address1?: string | null; address2?: string | null; zip?: string | null; city?: string | null; province?: string | null; country?: string | null; phone?: string | null } | null; pickupPoint: string | null; note: string | null };
}
export type EmailTemplate = keyof EmailTemplateData;

/** Kind and default suppression category of every template. */
export const EMAIL_TEMPLATES: { [K in EmailTemplate]: { kind: EmailKind; category: string } } = {
  magic_link: { kind: "security", category: "security" },
  email_change_confirm: { kind: "security", category: "security" },
  email_change_notice: { kind: "security", category: "security" },
  invite: { kind: "transactional", category: "transactional" },
  welcome: { kind: "transactional", category: "transactional" },
  password_reset: { kind: "security", category: "security" },
  password_changed: { kind: "security", category: "security" },
  email_changed: { kind: "security", category: "security" },
  new_sign_in: { kind: "security", category: "security" },
  account_disabled: { kind: "security", category: "security" },
  test: { kind: "transactional", category: "transactional" },
  supplier_po: { kind: "transactional", category: "supplier_po" },
  carrier_instruction: { kind: "transactional", category: "transactional" },
  billing_checkout: { kind: "transactional", category: "transactional" },
  mention: { kind: "notification", category: "mention" },
  digest: { kind: "notification", category: "digest" },
  notification: { kind: "notification", category: "notification" },
};
export const EMAIL_TEMPLATE_NAMES = Object.keys(EMAIL_TEMPLATES) as EmailTemplate[];

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Strings = typeof en;
const STRINGS: Record<EmailLocale, Strings> = { en, it, es };
/** Exposed for the parity test. */
export const EMAIL_STRINGS = STRINGS;

/** Who sends: shown in every footer. Read from the environment, so a deployment sets its own legal details. */
export interface EmailSender {
  product: string;
  legalName: string;
  legalAddress: string | null;
  supportEmail: string | null;
}

export function emailSender(env: Record<string, string | undefined> = process.env): EmailSender {
  return { product: PRODUCT_NAME, legalName: env.EMAIL_LEGAL_NAME?.trim() || PRODUCT_NAME, legalAddress: env.EMAIL_LEGAL_ADDRESS?.trim() || null, supportEmail: env.EMAIL_SUPPORT_ADDRESS?.trim() || env.EMAIL_REPLY_TO?.trim() || null };
}

export function emailLocale(locale: string | null | undefined): EmailLocale {
  const l = (locale ?? "").slice(0, 2).toLowerCase();
  return (EMAIL_LOCALES as readonly string[]).includes(l) ? (l as EmailLocale) : "en";
}

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const L = TOKENS.light;
const D = TOKENS.dark;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

interface Parts {
  kind: EmailKind;
  preheader?: string;
  paragraphs: string[];
  quote?: string;
  list?: string[];
  cta?: { label: string; url: string };
  hint?: string;
  detail?: string;
}

function layout(locale: EmailLocale, subject: string, p: Parts, sender: EmailSender, unsubscribeUrl?: string): { text: string; html: string } {
  const s = STRINGS[locale].common;
  const reason = fill(p.kind === "security" ? s.security_footer : s.footer, { product: sender.product });
  const legal = [sender.legalName, sender.legalAddress].filter(Boolean).join(" · ");
  const support = sender.supportEmail ? fill(s.support, { email: sender.supportEmail }) : null;
  const text = [
    ...p.paragraphs,
    ...(p.quote ? [p.quote.split("\n").map((l) => `> ${l}`).join("\n")] : []),
    ...(p.list?.length ? [p.list.map((l) => `- ${l}`).join("\n")] : []),
    ...(p.cta ? [`${p.cta.label}: ${p.cta.url}`] : []),
    ...(p.hint ? [p.hint] : []),
    ...(p.detail ? [p.detail] : []),
    "--",
    [reason, support, legal].filter(Boolean).join("\n"),
    ...(unsubscribeUrl ? [`${s.unsubscribe}: ${unsubscribeUrl}`] : []),
  ].join("\n\n");
  const e = escapeHtml;
  const para = (t: string) => `<p class="k-fg" style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${L.fg}">${e(t)}</p>`;
  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(subject)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
@media (prefers-color-scheme:dark){
.k-bg{background:${D.bg}!important}
.k-card{background:${D.surface}!important;border-color:${D.line}!important}
.k-fg{color:${D.fg}!important}
.k-muted{color:${D.muted}!important}
.k-link{color:${D.primary}!important}
.k-btn{background:${D.primary}!important;color:${D["on-primary"]}!important}
.k-mark{background:${D.primary}!important;color:${D["on-primary"]}!important}
.k-quote{border-color:${D["line-strong"]}!important;color:${D.fg}!important}
}
</style>
</head>
<body class="k-bg" style="margin:0;padding:0;background:${L.bg};font-family:${FONT}">
${p.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${e(p.preheader)}</div>\n` : ""}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="k-bg" style="background:${L.bg}">
<tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 0 16px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="k-mark" width="28" height="28" align="center" style="width:28px;height:28px;background:${L.primary};color:${L["on-primary"]};border-radius:8px;font-size:15px;font-weight:700;line-height:28px">${e(sender.product.slice(0, 1).toUpperCase())}</td>
<td class="k-fg" style="padding-left:10px;font-size:15px;font-weight:600;color:${L.fg}">${e(sender.product)}</td>
</tr></table>
</td></tr>
<tr><td class="k-card" style="background:${L.surface};border:1px solid ${L.line};border-radius:8px;padding:24px">
${p.paragraphs.map(para).join("\n")}
${p.quote ? `<blockquote class="k-quote" style="margin:0 0 16px;padding:8px 12px;border-left:3px solid ${L["line-strong"]};color:${L.fg};white-space:pre-wrap;font-size:14px;line-height:1.5">${e(p.quote)}</blockquote>\n` : ""}${p.list?.length ? `<ul class="k-fg" style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.6;color:${L.fg}">${p.list.map((l) => `<li>${e(l)}</li>`).join("")}</ul>\n` : ""}${p.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0"><tr><td class="k-btn" style="background:${L.primary};border-radius:8px"><a class="k-btn" href="${e(p.cta.url)}" style="display:inline-block;padding:11px 18px;font-size:15px;font-weight:600;color:${L["on-primary"]};text-decoration:none;border-radius:8px">${e(p.cta.label)}</a></td></tr></table>
<p class="k-muted" style="margin:0 0 12px;font-size:12px;line-height:1.5;color:${L.muted}">${e(s.button_fallback)}<br><a class="k-link" href="${e(p.cta.url)}" style="color:${L.primary};word-break:break-all">${e(p.cta.url)}</a></p>\n` : ""}${p.hint ? `<p class="k-muted" style="margin:0;font-size:13px;line-height:1.5;color:${L.muted}">${e(p.hint)}</p>\n` : ""}${p.detail ? `<p class="k-muted" style="margin:12px 0 0;font-size:12px;color:${L.muted}">${e(p.detail)}</p>\n` : ""}</td></tr>
<tr><td class="k-muted" style="padding:16px 4px 0;font-size:12px;line-height:1.6;color:${L.muted}">
${e(reason)}${support ? `<br>${e(support)}` : ""}${legal ? `<br>${e(legal)}` : ""}${unsubscribeUrl ? `<br><a class="k-link" href="${e(unsubscribeUrl)}" style="color:${L.muted}">${e(s.unsubscribe)}</a>` : ""}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { text, html };
}

/** Renders one template in the recipient's language; numbers and dates go through `Intl`. */
export function renderEmail<K extends EmailTemplate>(template: K, rawLocale: string | null | undefined, data: EmailTemplateData[K], opts: { unsubscribeUrl?: string; sender?: EmailSender } = {}): RenderedEmail {
  const locale = emailLocale(rawLocale);
  const s = STRINGS[locale];
  const tpl = s.templates;
  const sender = opts.sender ?? emailSender();
  const product = sender.product;
  const kind = EMAIL_TEMPLATES[template].kind;
  const u = kind === "security" ? undefined : opts.unsubscribeUrl;
  const out = (subject: string, parts: Omit<Parts, "kind">): RenderedEmail => ({ subject, ...layout(locale, subject, { kind, ...parts }, sender, u) });
  switch (template) {
    case "magic_link": {
      const d = data as EmailTemplateData["magic_link"];
      const vars = { product, minutes: formatNumber(d.minutes, locale) };
      return out(fill(tpl.magic_link.subject, vars), { preheader: fill(tpl.magic_link.preheader, vars), paragraphs: [fill(tpl.magic_link.intro, vars)], cta: { label: tpl.magic_link.cta, url: d.url }, hint: tpl.magic_link.hint });
    }
    case "email_change_confirm": {
      const d = data as EmailTemplateData["email_change_confirm"];
      const vars = { product, hours: formatNumber(d.hours, locale) };
      return out(fill(tpl.email_change_confirm.subject, vars), { preheader: fill(tpl.email_change_confirm.preheader, vars), paragraphs: [fill(tpl.email_change_confirm.intro, vars)], cta: { label: tpl.email_change_confirm.cta, url: d.url }, hint: tpl.email_change_confirm.hint });
    }
    case "email_change_notice": {
      const d = data as EmailTemplateData["email_change_notice"];
      const vars = { product, email: d.newEmail };
      return out(fill(tpl.email_change_notice.subject, vars), { preheader: fill(tpl.email_change_notice.preheader, vars), paragraphs: [fill(tpl.email_change_notice.intro, vars)], hint: tpl.email_change_notice.hint });
    }
    case "invite": {
      const d = data as EmailTemplateData["invite"];
      const vars = { product, inviter: d.inviterName, tenant: d.tenantName, role: (s.roles as Record<string, string>)[d.role] ?? d.role };
      return out(fill(tpl.invite.subject, vars), { preheader: fill(tpl.invite.preheader, vars), paragraphs: [fill(tpl.invite.intro, vars)], cta: { label: tpl.invite.cta, url: d.url }, hint: fill(tpl.invite.hint, { days: formatNumber(d.days, locale) }) });
    }
    case "welcome": {
      const d = data as EmailTemplateData["welcome"];
      const vars = { product, name: d.name, tenant: d.tenantName };
      const list = [`${tpl.welcome.profile} ${d.profileUrl}`, ...(d.guideUrl ? [`${tpl.welcome.guide} ${d.guideUrl}`] : [])];
      return out(fill(tpl.welcome.subject, vars), { preheader: fill(tpl.welcome.preheader, vars), paragraphs: [fill(tpl.welcome.intro, vars)], list, cta: { label: fill(tpl.welcome.cta, vars), url: d.dashboardUrl } });
    }
    case "password_reset": {
      const d = data as EmailTemplateData["password_reset"];
      const vars = { product, minutes: formatNumber(d.minutes, locale) };
      return out(fill(tpl.password_reset.subject, vars), { preheader: fill(tpl.password_reset.preheader, vars), paragraphs: [fill(tpl.password_reset.intro, vars)], cta: { label: tpl.password_reset.cta, url: d.url }, hint: tpl.password_reset.hint });
    }
    case "password_changed": {
      const d = data as EmailTemplateData["password_changed"];
      const vars = { product, time: formatDateTime(new Date(d.at), locale, d.timezone) };
      return out(fill(tpl.password_changed.subject, vars), { preheader: fill(tpl.password_changed.preheader, vars), paragraphs: [fill(tpl.password_changed.intro, vars)], hint: tpl.password_changed.hint });
    }
    case "email_changed": {
      const d = data as EmailTemplateData["email_changed"];
      const vars = { product, email: d.newEmail };
      return out(fill(tpl.email_changed.subject, vars), { preheader: fill(tpl.email_changed.preheader, vars), paragraphs: [fill(tpl.email_changed.intro, vars)], hint: tpl.email_changed.hint });
    }
    case "new_sign_in": {
      const d = data as EmailTemplateData["new_sign_in"];
      const vars = { product, device: d.device, ip: d.ip ?? "—", time: formatDateTime(new Date(d.at), locale, d.timezone) };
      const list = [fill(tpl.new_sign_in.device, vars), ...(d.ip ? [fill(tpl.new_sign_in.ip, vars)] : []), fill(tpl.new_sign_in.time, vars)];
      return out(fill(tpl.new_sign_in.subject, vars), { preheader: fill(tpl.new_sign_in.preheader, vars), paragraphs: [fill(tpl.new_sign_in.intro, vars)], list, cta: { label: tpl.new_sign_in.cta, url: d.profileUrl }, hint: tpl.new_sign_in.hint });
    }
    case "account_disabled": {
      const d = data as EmailTemplateData["account_disabled"];
      const vars = { product, tenant: d.tenantName };
      return out(fill(tpl.account_disabled.subject, vars), { preheader: fill(tpl.account_disabled.preheader, vars), paragraphs: [fill(tpl.account_disabled.intro, vars)], hint: fill(tpl.account_disabled.hint, vars) });
    }
    case "mention": {
      const d = data as EmailTemplateData["mention"];
      const vars = { author: d.authorName, record: d.recordLabel };
      return out(fill(tpl.mention.subject, vars), { preheader: fill(tpl.mention.preheader, vars), paragraphs: [fill(tpl.mention.intro, vars)], quote: d.excerpt, cta: { label: tpl.mention.cta, url: d.url } });
    }
    case "supplier_po": {
      const d = data as EmailTemplateData["supplier_po"];
      const vars = { po: d.poNumber, company: d.companyName, supplier: d.supplierName };
      const paragraphs = [fill(tpl.supplier_po.intro, vars), ...(d.expectedAt ? [fill(tpl.supplier_po.expected, { date: formatDate(new Date(d.expectedAt), locale, d.timezone) })] : [])];
      return out(fill(tpl.supplier_po.subject, vars), { preheader: fill(tpl.supplier_po.preheader, vars), paragraphs, cta: { label: tpl.supplier_po.cta, url: d.url }, hint: tpl.supplier_po.hint });
    }
    case "digest": {
      const d = data as EmailTemplateData["digest"];
      const types = s.types as Record<string, string>;
      const list = d.groups.map((g) => `${types[g.type] ?? types.other} (${formatNumber(g.count, locale)}): ${g.titles.join(" · ")}${g.count > g.titles.length ? ` ${fill(tpl.digest.more, { n: formatNumber(g.count - g.titles.length, locale) })}` : ""}`);
      return out(fill(tpl.digest.subject, { tenant: d.tenantName }), { preheader: tpl.digest.preheader, paragraphs: [tpl.digest.intro], list, cta: { label: tpl.digest.cta, url: d.url } });
    }
    case "carrier_instruction": {
      const d = data as EmailTemplateData["carrier_instruction"];
      const vars = { tracking: d.trackingNumber, company: d.companyName, order: d.orderName, carrier: d.carrier ?? "—" };
      const a = d.address;
      const list = d.resolution === "new_address" && a ? [a.name, a.address1, a.address2, [a.zip, a.city, a.province].filter(Boolean).join(" "), a.country, a.phone].filter((x): x is string => Boolean(x && x.trim())) : d.resolution === "pickup_point" && d.pickupPoint ? [d.pickupPoint] : undefined;
      const t = tpl.carrier_instruction;
      return out(fill(t.subject, vars), { preheader: fill(t.preheader, vars), paragraphs: [fill(t.intro, vars), t[d.resolution], ...(d.note ? [fill(t.note, { note: d.note })] : [])], list, hint: t.hint });
    }
    case "billing_checkout": {
      const d = data as EmailTemplateData["billing_checkout"];
      const t = tpl.billing_checkout;
      const names = t.addons as Record<string, string>;
      const vars = { product, tenant: d.tenantName };
      const money = (m: number) => formatMoney(m, d.currency, locale);
      const list = [...d.lines.map((l) => (l.kind === "plan" ? fill(t.line_plan, { plan: d.planName, amount: money(l.amountMinor) }) : l.kind === "addon" ? fill(t.line_addon, { addon: names[l.key.replace(/^addon\./, "")] ?? l.key, amount: money(l.amountMinor) }) : fill(t.line_setup, { amount: money(l.amountMinor) }))), ...(d.trialDays > 0 ? [fill(t.line_trial, { days: formatNumber(d.trialDays, locale) })] : [])];
      return out(fill(t.subject, vars), { preheader: fill(t.preheader, vars), paragraphs: [fill(t.intro, vars), t.how], list, cta: { label: t.cta, url: d.url }, hint: d.expiresAt ? fill(t.hint, { date: formatDateTime(new Date(d.expiresAt), locale, d.timezone) }) : t.hint_no_expiry });
    }
    case "test": {
      const d = data as EmailTemplateData["test"];
      const vars = { product, provider: d.provider, time: formatDateTime(new Date(d.sentAt), locale, "UTC") };
      return out(fill(tpl.test.subject, vars), { preheader: tpl.test.preheader, paragraphs: [fill(tpl.test.intro, vars)], detail: fill(tpl.test.detail, vars) });
    }
    default: {
      const d = data as EmailTemplateData["notification"];
      // system types carry data in title/body (a count, a source): phrase them, unless another emitter sent plain text
      const sys = s.system as Record<string, string>;
      const system = d.type in sys && (d.type === "sync_delay" || d.type === "platform_failure" || /^\d+$/.test(d.title)) ? fill(sys[d.type]!, { title: d.title, body: d.body ?? "" }) : null;
      const title = system ?? d.title;
      // a failing job keeps its last error under the phrase (#32)
      const detail = d.body && (!system || d.type === "platform_failure") ? [d.body] : [];
      return out(fill(tpl.notification.subject, { title }), { paragraphs: [title, ...detail], ...(d.url ? { cta: { label: fill(tpl.notification.cta, { product }), url: d.url } } : {}) });
    }
  }
}
