import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { INTEGRATION_SETUP, setupCopyValues, type IntegrationSetupGuide } from "@hullwise/config";
import en from "../../messages/en.json";
import itMessages from "../../messages/it.json";
import es from "../../messages/es.json";

/** Every value a verification line may use (the facts of `verifySetup`), so each message is formatted for real. */
const FACTS = { accounts: 2, names: "Main, Outlet", campaigns: 3, active: 1, pixel: "none", account: "Shop", advertisers: 1, model: "Model", valid: "yes", suggestions: 2, templates: 4, approved: 3, contracts: 5, more: "no", property: "Shop GA4", rows: 10, queued: "no", detail: "vendor words" };

/** The keys a card and the guide page read from a setup definition's namespace. */
function keysOf(guide: IntegrationSetupGuide): string[] {
  const keys = [guide.titleKey, "copy", "full_guide", "intro"];
  for (const s of guide.steps) keys.push(s.messageKey, ...(s.titleKey ? [s.titleKey] : []));
  for (const e of Object.values(guide.errors)) keys.push(e.messageKey, e.fixKey);
  for (const f of guide.fields ?? []) keys.push(f.labelKey);
  keys.push(...Object.values(guide.copyLabels ?? {}), ...(guide.noteKeys ?? []));
  if (guide.verifiedKey) keys.push(guide.verifiedKey);
  if (guide.advancedKey) keys.push(guide.advancedKey);
  keys.push(guide.strategy === "oauth_code" ? (guide.oauthLabelKey ?? "connect") : "connect");
  return keys;
}

/** #90: the setup definitions and the translation files agree, and every message formats in the three languages. */
describe("integration setup messages", () => {
  for (const [lang, messages] of [["en", en], ["it", itMessages], ["es", es]] as const) {
    it(`${lang}: every key of every setup guide exists and formats`, () => {
      for (const guide of Object.values(INTEGRATION_SETUP)) {
        const t = createTranslator({ locale: lang, messages: messages as Record<string, unknown>, namespace: guide.namespace as never, onError: (e) => { throw new Error(`${lang} ${guide.provider}: ${e.message}`); } });
        const values = { ...FACTS, ...Object.fromEntries(setupCopyValues(guide).map((k) => [k, "x"])), email: "reader@example.com", serviceAccountEmail: "reader@example.com" };
        for (const key of keysOf(guide)) {
          const text = (t as unknown as (k: string, v: Record<string, unknown>) => string)(key, values);
          expect(text, `${lang} ${guide.namespace}.${key}`).toBeTruthy();
          expect(text, `${lang} ${guide.namespace}.${key}`).not.toMatch(/[{}]/);
        }
      }
    });
  }

  it("the common setup texts exist", () => {
    for (const m of [en, itMessages, es]) {
      const t = createTranslator({ locale: "en", messages: m as Record<string, unknown>, namespace: "integration_setup.common" as never, onError: (e) => { throw e; } }) as unknown as (k: string, v?: Record<string, unknown>) => string;
      for (const k of ["mock_notice", "mock_triggers", "mock_deny", "connected", "setup_title", "connecting"]) expect(t(k)).toBeTruthy();
      expect(t("setup_title_of", { name: "Recharge" })).toContain("Recharge");
      expect(t("owner_prerequisite", { product: "P" })).toContain("P");
    }
  });
});
