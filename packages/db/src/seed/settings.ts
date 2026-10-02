import { and, eq, inArray, sql } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";
import { DEFAULT_SURVEY_CONFIG } from "@hullwise/core";
import * as schema from "../schema";
import { enableDemoMcp } from "./mcp";
import { ensureDemoProductCatalog } from "./media";
import { DEMO_SPOKI_SETTINGS, demoSpokiIntegration } from "./spoki";
import { demoAccountingIntegration, demoAccountingSettings } from "./accounting";
import { MOCK_CHART_OF_ACCOUNTS, MOCK_SPOKI_TEMPLATES } from "@hullwise/integrations";

/**
 * Configuration rows of the demo tenants (portal, return policy, tracking, survey, COD tags, the AI
 * key's mock connection, return costs). The full seed writes them with the demo data; the settings
 * step (`pnpm db:seed:settings`, run by `db:deploy` on every deploy) creates only the ones that are
 * missing, so a feature that adds a settings row shows up on a hosted demo without a reseed, and a
 * row someone edited is never overwritten.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type DemoKey = "northwind" | "harbor";
export const DEMO_SLUGS: Record<DemoKey, string> = { northwind: "northwind-apparel", harbor: "harbor-home" };

export const REASON_LABELS: Record<string, Record<string, string>> = {
  wrong_size: { en: "Wrong size or fit", it: "Taglia sbagliata", es: "Talla incorrecta" },
  changed_mind: { en: "Changed my mind", it: "Ho cambiato idea", es: "He cambiado de opinión" },
  defective: { en: "Defective", it: "Difettoso", es: "Defectuoso" },
  damaged: { en: "Damaged in transit", it: "Danneggiato nel trasporto", es: "Dañado en el transporte" },
  not_as_described: { en: "Not as described", it: "Non conforme alla descrizione", es: "No coincide con la descripción" },
  wrong_item: { en: "Wrong item received", it: "Articolo sbagliato", es: "Artículo equivocado" },
  other: { en: "Other", it: "Altro", es: "Otro" },
};
export const REASON_PLATFORM: Record<string, string> = { wrong_size: "SIZE_TOO_SMALL", changed_mind: "UNWANTED", defective: "DEFECTIVE", damaged: "DEFECTIVE", not_as_described: "NOT_AS_DESCRIBED", wrong_item: "WRONG_ITEM" };

export function demoPortalConfig(key: DemoKey) {
  const it = key === "northwind";
  return {
  enabled: true,
  // no primaryColor/logoUrl: the portal follows the tenant branding (Settings → Branding)
  title: it ? { it: "Reso o cambio", en: "Return or exchange", es: "Devolución o cambio" } : { en: "Start a return", es: "Iniciar una devolución", it: "Avvia un reso" },
  intro: it ? { it: "Hai 30 giorni dalla consegna. Ti servono il numero d'ordine e l'email usata per l'acquisto.", en: "You have 30 days from delivery. You need the order number and the email used for the purchase." } : { en: "You have 30 days from delivery to send items back. Have your order number and email at hand." },
  instructions: it ? { it: "Spedisci a: Northwind Apparel, Magazzino resi, Via dell'Industria 12, 40100 Bologna.\nImballa gli articoli nella confezione originale con il numero di reso all'esterno.", en: "Ship to: Northwind Apparel, Returns, Via dell'Industria 12, 40100 Bologna, Italy.\nPack the items in the original box with the return number on the outside." } : { en: "Ship to: Harbor Home Returns, 400 Dock St, Newark NJ 07105.\nUse a sturdy box and write the return number on the label." },
  successMessage: it ? { it: "Ti scriveremo appena il pacco arriva in magazzino.", en: "We will write to you as soon as the parcel reaches our warehouse." } : { en: "We will email you when your return arrives and is checked." },
  confirmText: it ? { it: "Confermo che gli articoli sono integri e con le etichette.", en: "I confirm the items are unworn and with their tags." } : {},
  resolutions: it ? ["refund", "exchange", "voucher"] : ["refund", "voucher"],
  bankDetailsFor: it ? ["cod", "bank_transfer"] : ["bank_transfer"],
  lookupBy: it ? "email_or_phone" : "email",
  tracking: it ? { mode: "optional", carriers: ["Poste Italiane", "DHL", "UPS"] } : { mode: "optional", carriers: ["UPS", "USPS", "FedEx"] },
  photos: { mode: "optional", max: 3 },
  supportEmail: it ? "assistenza@northwind.example" : "help@harborhome.example",
  trackingPage: true,
  returnLabel: it ? { enabled: true, destination: "Northwind Apparel - Resi\nVia dell'Industria 12\n40100 Bologna BO\nItalia" } : { enabled: false, destination: "Harbor Home Returns\n400 Dock St\nNewark NJ 07105" },
  fields: it
    ? [{ key: "worn", type: "checkbox", label: { it: "Ho provato il capo solo in casa", en: "I only tried the item on at home" }, required: false, options: [], optionLabels: {} }]
    : [{ key: "packaging", type: "select", label: { en: "Original packaging", es: "Embalaje original" }, required: true, options: ["yes", "partial", "no"], optionLabels: { yes: { en: "Yes, complete" }, partial: { en: "Partly" }, no: { en: "No" } } }],
};
}

export function demoReturnPolicy(key: DemoKey, types: string[]) {
  const it = key === "northwind";
  return {
  windows: it
    ? [{ countries: ["DE", "AT", "FR", "ES"], productTypes: [], tags: [], days: 30 }, { countries: [], productTypes: [], tags: ["new"], days: 21 }]
    : [{ countries: [], productTypes: types.slice(0, 1), tags: [], days: 60 }, { countries: ["CA"], productTypes: [], tags: [], days: 45 }],
  exclusions: { productTypes: it ? [] : types.slice(-1), skuPrefixes: it ? ["GIFT-"] : [], titleContains: it ? ["gift card", "buono regalo"] : ["gift card"], tags: [] },
  finalSaleDiscountBps: it ? 5000 : 6000,
  creditBonusBps: it ? 1000 : 500,
  exchanges: { enabled: true, refundDifference: true },
  instantExchange: { enabled: false, days: 21 },
  customerLimit: it ? { count: 4, days: 90 } : null,
  risk: { days: 365, watchRateBps: 3000, highRateBps: 5000, minReturns: 3, quickReturnDays: 3, highValueMinor: it ? 40000 : 80000 },
  automations: [
    { id: "flag-risky", name: it ? "Segnala clienti a rischio" : "Flag risky customers", active: true, trigger: "created", action: "flag", fault: null, note: it ? "Controlla lo storico prima di approvare" : "Check the history before approving", conditions: { maxAmountMinor: null, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: [], productTypes: [], maxRisk: null, minRisk: "watch", firstReturnOnly: false } },
    { id: "keep-cheap", name: it ? "Tieni gli articoli economici danneggiati" : "Keep cheap damaged items", active: true, trigger: "created", action: "returnless", fault: null, note: null, conditions: { maxAmountMinor: it ? 1500 : 2500, minAmountMinor: null, reasonCodes: ["damaged", "defective"], resolutions: [], sources: [], productTypes: [], maxRisk: "watch", minRisk: null, firstReturnOnly: false } },
    { id: "approve-first", name: it ? "Approva il primo reso dal portale" : "Approve first portal returns", active: true, trigger: "created", action: "approve", fault: null, note: null, conditions: { maxAmountMinor: it ? 15000 : 30000, minAmountMinor: null, reasonCodes: [], resolutions: [], sources: ["portal"], productTypes: [], maxRisk: "none", minRisk: null, firstReturnOnly: true } },
  ],
};
}

/** Return status emails to customers (issue #7): off by default for a real store, every event on in the demo. */
export const DEMO_CUSTOMER_EMAILS = { returnCustomerEmails: { approved: true, received: true, refunded: true, voucher_issued: true, exchange_shipped: true } };

/** What a return costs the store (label and handling), for the P/L; merged into the tenant settings. */
export const DEMO_RETURN_COSTS: Record<DemoKey, Record<string, number>> = {
  northwind: { returnLabelCostMinor: 650, returnHandlingCostMinor: 250, returnShippingCostMinor: 590 },
  harbor: { returnLabelCostMinor: 900, returnHandlingCostMinor: 300 },
};

export const DEMO_COD_SETTINGS = { queueCutoffDays: 60, tags: {
  queue: ["Da confermare", "Da chiamare", "Richiesta modifica"],
  confirmed: ["Confermato", "Già pagato*"],
  cancelled: ["Annullato*", "Da annullare"],
  clearQueueTagsOnClose: true,
  write: {
    entered: { add: ["Da confermare"], remove: [] },
    confirmed: { add: ["Confermato"], remove: [] },
    no_answer: { add: [], remove: [] },
    call_back: { add: ["Da chiamare"], remove: ["Da confermare"] },
    modified: { add: ["Richiesta modifica"], remove: [] },
    cancelled: { add: ["Annullato"], remove: ["Confermato"] },
    unreachable: { add: ["Non raggiungibile"], remove: [] },
    replaced: { add: ["Annullato per variazione"], remove: ["Confermato"] },
  },
},
  messageTemplates: [
    { key: "conferma", name: "Conferma ordine", body: "Ciao {{first_name}}, sono {{operator_name}} di {{shop_name}}. Confermi l'ordine {{order_name}} ({{items}}) da {{total}} in contrassegno, consegna a {{address}}? Rispondi SÌ per confermare." },
    { key: "non_risponde", name: "Non risponde", body: "Ciao {{first_name}}, abbiamo provato a chiamarti per l'ordine {{order_name}} da {{total}}. Quando possiamo richiamarti?" },
    { key: "consegna_programmata", name: "Consegna programmata", body: "Ciao {{first_name}}, come concordato confermeremo l'ordine {{order_name}} il {{scheduled_date}}. Grazie da {{shop_name}}!" },
  ],
  feeLineMatch: ["COD-FEE", "Contrassegno*"],
  messagingReplies: { confirm: ["sì", "si", "confermo", "ok"], cancel: ["no", "annulla", "annullare"] },
};

export function demoSurveySettings(key: DemoKey, tenantId: string) {
  return { tenantId, enabled: true, config: DEFAULT_SURVEY_CONFIG, secret: `demo-${key}-survey-secret-0001` };
}

export function demoPixelSettings(key: DemoKey, tenantId: string) {
  return { tenantId, publicKey: key === "northwind" ? "px_northwindDemoKey01" : "px_harborDemoKey0001", lookbackDays: 30 };
}

export function demoConversionSettings(tenantId: string) {
  return [
    { tenantId, provider: "meta", enabled: true, destinationId: "1234567890123456", requireConsent: true, lookbackDays: 7 },
    { tenantId, provider: "google", enabled: true, destinationId: "987654321", requireConsent: true, lookbackDays: 30 },
  ];
}

/** The assistant runs on the store's own Anthropic key; on the demo the key is a mock connection. */
export function demoAnthropicIntegration(tenantId: string, now: Date) {
  return { tenantId, provider: "anthropic", status: "connected", mode: "mock", externalAccountId: "claude-opus-5-5", externalAccountName: "Claude (mock)", credentialsEncrypted: null, config: {}, lastSuccessAt: new Date(now.getTime() - 2 * 3600e3) };
}

/** Address validation in the demo: the simulated provider, connected (issue #7). */
export function demoAddressIntegration(tenantId: string, now: Date) {
  return { tenantId, provider: "address", status: "connected", mode: "mock", externalAccountId: "address-mock", externalAccountName: "Simulated address provider", credentialsEncrypted: null, config: {}, lastSuccessAt: new Date(now.getTime() - 2 * 3600e3) };
}

export interface SettingsReport {
  tenant: string;
  created: string[];
}

/**
 * Fills in the demo tenants' missing configuration rows. Idempotent: inserts only what is missing,
 * merges only missing keys into the tenant settings, fills reason labels only where empty.
 * Tenants that do not exist (a production without the demo) are skipped.
 */
export async function ensureDemoSettings(db: Db, now = new Date()): Promise<SettingsReport[]> {
  const tenants = await db.select({ id: schema.tenants.id, slug: schema.tenants.slug }).from(schema.tenants).where(inArray(schema.tenants.slug, Object.values(DEMO_SLUGS)));
  const addons = await db.select({ tenantId: schema.tenantAddons.tenantId, key: schema.tenantAddons.moduleKey }).from(schema.tenantAddons).where(eq(schema.tenantAddons.isActive, true));
  const out: SettingsReport[] = [];
  for (const key of Object.keys(DEMO_SLUGS) as DemoKey[]) {
    const tenant = tenants.find((t) => t.slug === DEMO_SLUGS[key]);
    if (!tenant) continue;
    const tenantId = tenant.id;
    const created: string[] = [];
    const missing = async (table: string, extra = sql`true`) => {
      const r = await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where tenant_id = ${tenantId} and ${extra}`);
      return Number(r.rows[0]?.n ?? 0) === 0;
    };
    if (await missing("tenant_branding")) {
      await db.insert(schema.tenantBranding).values({ tenantId, brandColor: key === "harbor" ? "#3d5a40" : null }).onConflictDoNothing();
      created.push("tenant_branding");
    }
    if (await missing("return_portal_settings")) {
      await db.insert(schema.returnPortalSettings).values({ tenantId, config: demoPortalConfig(key) }).onConflictDoNothing();
      created.push("return_portal_settings");
    }
    if (await missing("return_policies")) {
      const types = (await db.selectDistinct({ v: schema.products.productType }).from(schema.products).where(eq(schema.products.tenantId, tenantId))).map((x) => x.v).filter((x): x is string => Boolean(x)).sort();
      await db.insert(schema.returnPolicies).values({ tenantId, policy: demoReturnPolicy(key, types) }).onConflictDoNothing();
      created.push("return_policies");
    }
    for (const [code, labels] of Object.entries(REASON_LABELS)) {
      const r = await db.update(schema.returnReasons).set({ labels, platformReason: REASON_PLATFORM[code] ?? null }).where(and(eq(schema.returnReasons.tenantId, tenantId), eq(schema.returnReasons.code, code), sql`${schema.returnReasons.labels} = '{}'::jsonb`)).returning({ id: schema.returnReasons.id });
      if (r.length) created.push(`return_reason_labels:${code}`);
    }
    const costs = await db.execute<{ id: string }>(sql`update tenants set settings = ${JSON.stringify(DEMO_RETURN_COSTS[key])}::jsonb || coalesce(settings, '{}'::jsonb) where id = ${tenantId} and not (coalesce(settings, '{}'::jsonb) ?& ${sql.param(Object.keys(DEMO_RETURN_COSTS[key]))}::text[]) returning id`);
    if (costs.rows.length) created.push("tenant_settings:return_costs");
    const emails = await db.execute<{ id: string }>(sql`update tenants set settings = ${JSON.stringify(DEMO_CUSTOMER_EMAILS)}::jsonb || coalesce(settings, '{}'::jsonb) where id = ${tenantId} and not (coalesce(settings, '{}'::jsonb) ? 'returnCustomerEmails') returning id`);
    if (emails.rows.length) created.push("tenant_settings:customer_emails");
    if (key === "northwind" && (await enableDemoMcp(db, tenantId))) created.push("tenant_settings:mcp");
    if (await missing("pixel_settings")) {
      await db.insert(schema.pixelSettings).values(demoPixelSettings(key, tenantId)).onConflictDoNothing();
      created.push("pixel_settings");
    }
    for (const row of demoConversionSettings(tenantId)) {
      if (await missing("conversion_settings", sql`provider = ${row.provider}`)) {
        await db.insert(schema.conversionSettings).values(row).onConflictDoNothing();
        created.push(`conversion_settings:${row.provider}`);
      }
    }
    if (await missing("survey_settings")) {
      await db.insert(schema.surveySettings).values(demoSurveySettings(key, tenantId)).onConflictDoNothing();
      created.push("survey_settings");
    }
    if (addons.some((a) => a.tenantId === tenantId && a.key === "addon.whatsapp_spoki") && (await missing("spoki_settings"))) {
      await db.insert(schema.spokiSettings).values({ tenantId, config: DEMO_SPOKI_SETTINGS, templates: MOCK_SPOKI_TEMPLATES, templatesSyncedAt: now, notifiedUntil: now }).onConflictDoNothing();
      created.push("spoki_settings");
      if (await missing("integrations", sql`provider = 'spoki'`)) {
        await db.insert(schema.integrations).values(demoSpokiIntegration(tenantId, now)).onConflictDoNothing();
        created.push("integrations:spoki");
      }
    }
    if (addons.some((a) => a.tenantId === tenantId && a.key === "addon.accounting") && (await missing("accounting_settings"))) {
      await db.insert(schema.accountingSettings).values({ tenantId, config: demoAccountingSettings(null), accounts: [...MOCK_CHART_OF_ACCOUNTS], accountsSyncedAt: now }).onConflictDoNothing();
      created.push("accounting_settings");
      if (await missing("integrations", sql`provider = 'accounting'`)) {
        await db.insert(schema.integrations).values(demoAccountingIntegration(tenantId, now)).onConflictDoNothing();
        created.push("integrations:accounting");
      }
    }
    if (addons.some((a) => a.tenantId === tenantId && a.key === "addon.cod") && (await missing("cod_settings"))) {
      await db.insert(schema.codSettings).values({ tenantId, config: DEMO_COD_SETTINGS }).onConflictDoNothing();
      created.push("cod_settings");
    }
    // demo gallery and Shopify field mirror (issue #19): only products without media / empty fields
    const catalog = await ensureDemoProductCatalog(db, tenantId, key, now);
    if (catalog.media) created.push(`product_media:${catalog.media}`);
    if (catalog.products) created.push(`product_mirror:${catalog.products}`);
    if (await missing("integrations", sql`provider = 'anthropic'`)) {
      await db.insert(schema.integrations).values(demoAnthropicIntegration(tenantId, now)).onConflictDoNothing();
      created.push("integrations:anthropic");
    }
    if (await missing("integrations", sql`provider = 'address'`)) {
      await db.insert(schema.integrations).values(demoAddressIntegration(tenantId, now)).onConflictDoNothing();
      created.push("integrations:address");
    }
    out.push({ tenant: DEMO_SLUGS[key], created });
  }
  return out;
}
