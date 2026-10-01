import { formatDate, formatNumber } from "@keel/core";

/**
 * Transactional email templates (subject + plain text + simple HTML) in en/it/es. Emails are
 * rendered outside the Next.js request (jobs, auth callbacks), so their strings live here rather
 * than in the app's message files; `email-templates.test.ts` keeps the three languages in sync.
 */
export const EMAIL_LOCALES = ["en", "it", "es"] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export interface EmailTemplateData {
  invite: { tenantName: string; inviterName: string; role: string; url: string };
  magic_link: { url: string; minutes: number };
  mention: { authorName: string; recordLabel: string; excerpt: string; url: string };
  supplier_po: { companyName: string; supplierName: string; poNumber: string; url: string; expectedAt: Date | null; timezone: string };
  digest: { tenantName: string; groups: { type: string; count: number; titles: string[] }[]; url: string };
  notification: { title: string; body: string | null; url: string | null; type: string };
}
export type EmailTemplate = keyof EmailTemplateData;

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Strings = {
  common: { open: string; footer: string; unsubscribe: string; ignore: string };
  invite: { subject: string; intro: string; cta: string; hint: string };
  magic_link: { subject: string; intro: string; cta: string; hint: string };
  mention: { subject: string; intro: string; cta: string };
  supplier_po: { subject: string; intro: string; expected: string; cta: string; hint: string };
  digest: { subject: string; intro: string; more: string; cta: string };
  notification: { subject: string; cta: string };
  /** Subject/lead of system notifications whose title is data (a count, a source). */
  system: { stock_critical_no_po: string; late_to_ship: string; sync_delay: string; export_ready: string };
  roles: Record<string, string>;
  types: Record<string, string>;
};

const STRINGS: Record<EmailLocale, Strings> = {
  en: {
    common: { open: "Open in Keel", footer: "You receive this email because you use Keel.", unsubscribe: "Unsubscribe from these emails", ignore: "If you did not expect this email you can ignore it." },
    invite: { subject: "{inviter} invited you to {tenant} on Keel", intro: "{inviter} added you to {tenant} as {role}.", cta: "Sign in", hint: "Sign in with this email address: we will send you a link, no password needed." },
    magic_link: { subject: "Your sign-in link", intro: "Use this link to sign in. It expires in {minutes} minutes and works once.", cta: "Sign in", hint: "If you did not ask to sign in, ignore this email." },
    mention: { subject: "{author} mentioned you on {record}", intro: "{author} mentioned you in a note on {record}:", cta: "Open the note" },
    supplier_po: { subject: "Purchase order {po} from {company}", intro: "Hello {supplier}, {company} sent you purchase order {po}. Please confirm it or tell us about any problem from the page below.", expected: "Expected delivery: {date}", cta: "View and confirm the order", hint: "The link is personal to this order." },
    digest: { subject: "Your daily summary for {tenant}", intro: "Unread in the last 24 hours:", more: "and {n} more", cta: "Open notifications" },
    notification: { subject: "{title}", cta: "Open in Keel" },
    system: { stock_critical_no_po: "{title} selling variants at critical stock with nothing on order", late_to_ship: "{title} orders still to ship after {body}", sync_delay: "The {title} sync is late ({body})", export_ready: "Your CSV export is ready: {title} rows ({body})" },
    roles: { owner: "owner", admin: "admin", operations: "operations", customer_care: "customer care", marketing: "marketing", viewer: "viewer" },
    types: { mention: "Mentions", task_assigned: "Tasks assigned to you", task_due: "Tasks due", support_reply: "Support replies", alert: "Alerts", sync_delay: "Sync delays", stock_critical_no_po: "Critical stock", late_to_ship: "Late to ship", stock_low: "Low stock", stock_available: "Stock available again", return_portal: "Returns from the portal", po_supplier_confirmed: "Supplier confirmations", po_supplier_problem: "Supplier problems", integration_health: "Integrations", cod_assigned: "COD assignments", other: "Other" },
  },
  it: {
    common: { open: "Apri in Keel", footer: "Ricevi questa email perché usi Keel.", unsubscribe: "Non ricevere più queste email", ignore: "Se non aspettavi questa email puoi ignorarla." },
    invite: { subject: "{inviter} ti ha invitato in {tenant} su Keel", intro: "{inviter} ti ha aggiunto a {tenant} con il ruolo {role}.", cta: "Accedi", hint: "Accedi con questo indirizzo email: ti mandiamo un link, senza password." },
    magic_link: { subject: "Il tuo link di accesso", intro: "Usa questo link per accedere. Scade tra {minutes} minuti e funziona una volta sola.", cta: "Accedi", hint: "Se non hai chiesto di accedere, ignora questa email." },
    mention: { subject: "{author} ti ha menzionato su {record}", intro: "{author} ti ha menzionato in una nota su {record}:", cta: "Apri la nota" },
    supplier_po: { subject: "Ordine d'acquisto {po} da {company}", intro: "Buongiorno {supplier}, {company} ti ha inviato l'ordine d'acquisto {po}. Confermalo o segnalaci un problema dalla pagina qui sotto.", expected: "Consegna prevista: {date}", cta: "Vedi e conferma l'ordine", hint: "Il link è personale per questo ordine." },
    digest: { subject: "Il tuo riepilogo giornaliero di {tenant}", intro: "Da leggere nelle ultime 24 ore:", more: "e altri {n}", cta: "Apri le notifiche" },
    notification: { subject: "{title}", cta: "Apri in Keel" },
    system: { stock_critical_no_po: "{title} varianti in vendita con stock critico e nessun ordine d'acquisto", late_to_ship: "{title} ordini ancora da spedire dopo {body}", sync_delay: "La sincronizzazione di {title} è in ritardo ({body})", export_ready: "Il tuo export CSV è pronto: {title} righe ({body})" },
    roles: { owner: "titolare", admin: "amministratore", operations: "operazioni", customer_care: "assistenza clienti", marketing: "marketing", viewer: "sola lettura" },
    types: { mention: "Menzioni", task_assigned: "Attività assegnate a te", task_due: "Attività in scadenza", support_reply: "Risposte del supporto", alert: "Avvisi", sync_delay: "Ritardi di sincronizzazione", stock_critical_no_po: "Stock critico", late_to_ship: "Spedizioni in ritardo", stock_low: "Stock basso", stock_available: "Stock di nuovo disponibile", return_portal: "Resi dal portale", po_supplier_confirmed: "Conferme dei fornitori", po_supplier_problem: "Problemi dei fornitori", integration_health: "Integrazioni", cod_assigned: "Assegnazioni contrassegno", other: "Altro" },
  },
  es: {
    common: { open: "Abrir en Keel", footer: "Recibes este correo porque usas Keel.", unsubscribe: "Dejar de recibir estos correos", ignore: "Si no esperabas este correo puedes ignorarlo." },
    invite: { subject: "{inviter} te invitó a {tenant} en Keel", intro: "{inviter} te añadió a {tenant} con el rol {role}.", cta: "Iniciar sesión", hint: "Inicia sesión con esta dirección de correo: te enviamos un enlace, sin contraseña." },
    magic_link: { subject: "Tu enlace de acceso", intro: "Usa este enlace para iniciar sesión. Caduca en {minutes} minutos y funciona una sola vez.", cta: "Iniciar sesión", hint: "Si no pediste acceder, ignora este correo." },
    mention: { subject: "{author} te mencionó en {record}", intro: "{author} te mencionó en una nota de {record}:", cta: "Abrir la nota" },
    supplier_po: { subject: "Orden de compra {po} de {company}", intro: "Hola {supplier}, {company} te envió la orden de compra {po}. Confírmala o avísanos de cualquier problema desde la página de abajo.", expected: "Entrega prevista: {date}", cta: "Ver y confirmar la orden", hint: "El enlace es personal para esta orden." },
    digest: { subject: "Tu resumen diario de {tenant}", intro: "Sin leer en las últimas 24 horas:", more: "y {n} más", cta: "Abrir notificaciones" },
    notification: { subject: "{title}", cta: "Abrir en Keel" },
    system: { stock_critical_no_po: "{title} variantes en venta con stock crítico y ninguna orden de compra", late_to_ship: "{title} pedidos aún sin enviar después de {body}", sync_delay: "La sincronización de {title} va con retraso ({body})", export_ready: "Tu exportación CSV está lista: {title} filas ({body})" },
    roles: { owner: "propietario", admin: "administrador", operations: "operaciones", customer_care: "atención al cliente", marketing: "marketing", viewer: "solo lectura" },
    types: { mention: "Menciones", task_assigned: "Tareas asignadas a ti", task_due: "Tareas que vencen", support_reply: "Respuestas de soporte", alert: "Alertas", sync_delay: "Retrasos de sincronización", stock_critical_no_po: "Stock crítico", late_to_ship: "Envíos retrasados", stock_low: "Stock bajo", stock_available: "Stock disponible de nuevo", return_portal: "Devoluciones del portal", po_supplier_confirmed: "Confirmaciones de proveedores", po_supplier_problem: "Problemas de proveedores", integration_health: "Integraciones", cod_assigned: "Asignaciones contra reembolso", other: "Otros" },
  },
};

/** Exposed for the parity test. */
export const EMAIL_STRINGS = STRINGS;

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

function layout(locale: EmailLocale, parts: { paragraphs: string[]; quote?: string; list?: string[]; cta?: { label: string; url: string }; hint?: string }, unsubscribeUrl?: string): { text: string; html: string } {
  const s = STRINGS[locale].common;
  const text = [
    ...parts.paragraphs,
    ...(parts.quote ? [parts.quote.split("\n").map((l) => `> ${l}`).join("\n")] : []),
    ...(parts.list?.length ? [parts.list.map((l) => `- ${l}`).join("\n")] : []),
    ...(parts.cta ? [`${parts.cta.label}: ${parts.cta.url}`] : []),
    ...(parts.hint ? [parts.hint] : []),
    "--",
    s.footer,
    ...(unsubscribeUrl ? [`${s.unsubscribe}: ${unsubscribeUrl}`] : []),
  ].join("\n\n");
  const html = `<!doctype html><html lang="${locale}"><body style="margin:0;background:#f6f5f2;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328">
<div style="max-width:560px;margin:0 auto;padding:24px">
<p style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:#6b6f76;margin:0 0 16px">Keel</p>
<div style="background:#ffffff;border:1px solid #e4e2dd;border-radius:8px;padding:24px">
${parts.paragraphs.map((p) => `<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(p)}</p>`).join("\n")}
${parts.quote ? `<blockquote style="margin:0 0 16px;padding:8px 12px;border-left:3px solid #c9c6bf;color:#3d4148;white-space:pre-wrap">${escapeHtml(parts.quote)}</blockquote>` : ""}
${parts.list?.length ? `<ul style="margin:0 0 16px;padding-left:20px;line-height:1.6">${parts.list.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
${parts.cta ? `<p style="margin:16px 0"><a href="${escapeHtml(parts.cta.url)}" style="display:inline-block;background:#1f2328;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px">${escapeHtml(parts.cta.label)}</a></p>` : ""}
${parts.hint ? `<p style="margin:0;color:#6b6f76;font-size:13px">${escapeHtml(parts.hint)}</p>` : ""}
</div>
<p style="font-size:12px;color:#6b6f76;margin:16px 0 0">${escapeHtml(s.footer)}${unsubscribeUrl ? ` <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b6f76">${escapeHtml(s.unsubscribe)}</a>` : ""}</p>
</div></body></html>`;
  return { text, html };
}

/** Renders one template in the recipient's language; numbers and dates go through `Intl`. */
export function renderEmail<K extends EmailTemplate>(template: K, rawLocale: string | null | undefined, data: EmailTemplateData[K], opts: { unsubscribeUrl?: string } = {}): RenderedEmail {
  const locale = emailLocale(rawLocale);
  const s = STRINGS[locale];
  const u = opts.unsubscribeUrl;
  switch (template) {
    case "invite": {
      const d = data as EmailTemplateData["invite"];
      const vars = { inviter: d.inviterName, tenant: d.tenantName, role: s.roles[d.role] ?? d.role };
      return { subject: fill(s.invite.subject, vars), ...layout(locale, { paragraphs: [fill(s.invite.intro, vars)], cta: { label: s.invite.cta, url: d.url }, hint: s.invite.hint }) };
    }
    case "magic_link": {
      const d = data as EmailTemplateData["magic_link"];
      return { subject: s.magic_link.subject, ...layout(locale, { paragraphs: [fill(s.magic_link.intro, { minutes: formatNumber(d.minutes, locale) })], cta: { label: s.magic_link.cta, url: d.url }, hint: s.magic_link.hint }) };
    }
    case "mention": {
      const d = data as EmailTemplateData["mention"];
      const vars = { author: d.authorName, record: d.recordLabel };
      return { subject: fill(s.mention.subject, vars), ...layout(locale, { paragraphs: [fill(s.mention.intro, vars)], quote: d.excerpt, cta: { label: s.mention.cta, url: d.url } }, u) };
    }
    case "supplier_po": {
      const d = data as EmailTemplateData["supplier_po"];
      const vars = { po: d.poNumber, company: d.companyName, supplier: d.supplierName };
      const paragraphs = [fill(s.supplier_po.intro, vars), ...(d.expectedAt ? [fill(s.supplier_po.expected, { date: formatDate(d.expectedAt, locale, d.timezone) })] : [])];
      return { subject: fill(s.supplier_po.subject, vars), ...layout(locale, { paragraphs, cta: { label: s.supplier_po.cta, url: d.url }, hint: s.supplier_po.hint }, u) };
    }
    case "digest": {
      const d = data as EmailTemplateData["digest"];
      const list = d.groups.map((g) => `${s.types[g.type] ?? s.types.other} (${formatNumber(g.count, locale)}): ${g.titles.join(" · ")}${g.count > g.titles.length ? ` ${fill(s.digest.more, { n: formatNumber(g.count - g.titles.length, locale) })}` : ""}`);
      return { subject: fill(s.digest.subject, { tenant: d.tenantName }), ...layout(locale, { paragraphs: [s.digest.intro], list, cta: { label: s.digest.cta, url: d.url } }, u) };
    }
    default: {
      const d = data as EmailTemplateData["notification"];
      // system types carry data in title/body (a count, a source): phrase them, unless another emitter sent plain text
      const system = d.type in s.system && (d.type === "sync_delay" || /^\d+$/.test(d.title)) ? fill(s.system[d.type as keyof Strings["system"]], { title: d.title, body: d.body ?? "" }) : null;
      const title = system ?? d.title;
      return { subject: fill(s.notification.subject, { title }), ...layout(locale, { paragraphs: [title, ...(!system && d.body ? [d.body] : [])], ...(d.url ? { cta: { label: s.notification.cta, url: d.url } } : {}) }, u) };
    }
  }
}
