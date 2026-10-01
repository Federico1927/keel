import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, schema, withTenant } from "@keel/db";
import { testPools } from "@keel/db/test-utils";
import { seedDomain, seedPlatform, type SeedContext } from "@keel/db/seed";
import { DEFAULT_SURVEY_CONFIG, parseTenantSettings } from "@keel/core";
import { attributionReport, getSurveySettings, publicSurveyView, saveSurveySettings, submitSurveyAnswer, SurveyError, surveyResults, surveySignature, type ServiceContext } from "../src";

const pools = testPools();
let ctx: SeedContext;
let tenantId = "";
beforeAll(async () => {
  ctx = await seedPlatform(pools.admin);
  await seedDomain(pools.admin, ctx, { scale: 0.03 });
  tenantId = ctx.tenantIds.northwind;
});
afterAll(() => pools.close());
const run = <T>(fn: (s: ServiceContext) => Promise<T>) => withTenant(tenantId, (tx) => fn({ tenantId, tx, actor: { type: "system", userId: null } }), pools.app);

describe("post-purchase survey", () => {
  it("signs links like Liquid's hmac_sha256, refuses forged or disabled links, and keeps the first answer", async () => {
    const s = await run((x) => getSurveySettings(x));
    expect(surveySignature(s.secret, "5001")).toBe(createHmac("sha256", s.secret).update("5001").digest("hex"));
    const [order] = await run((x) => x.tx.select({ id: schema.orders.id, externalId: schema.orders.externalId }).from(schema.orders).where(and(eq(schema.orders.tenantId, tenantId), eq(schema.orders.status, "delivered"))).limit(1));
    await run((x) => x.tx.delete(schema.surveyResponses).where(eq(schema.surveyResponses.orderId, order!.id)));
    const sig = surveySignature(s.secret, order!.externalId!);
    await run((x) => saveSurveySettings(x, { enabled: false, config: DEFAULT_SURVEY_CONFIG }));
    await expect(run((x) => publicSurveyView(x, order!.externalId!, sig, "it"))).rejects.toMatchObject({ code: "disabled" });
    await run((x) => saveSurveySettings(x, { enabled: true, config: DEFAULT_SURVEY_CONFIG }));
    await expect(run((x) => publicSurveyView(x, order!.externalId!, "0".repeat(64), "it"))).rejects.toMatchObject({ code: "invalid_link" });
    const view = await run((x) => publicSurveyView(x, order!.externalId!, sig, "it"));
    expect(view.question).toBe("Come ci hai conosciuto?");
    expect(view.answered).toBe(false);
    await expect(run((x) => submitSurveyAnswer(x, { orderExternalId: order!.externalId!, signature: sig, answerKey: "nope", locale: "it" }))).rejects.toBeInstanceOf(SurveyError);
    expect((await run((x) => submitSurveyAnswer(x, { orderExternalId: order!.externalId!, signature: sig, answerKey: "podcast", locale: "it" }))).recorded).toBe(true);
    expect((await run((x) => submitSurveyAnswer(x, { orderExternalId: order!.externalId!, signature: sig, answerKey: "search", locale: "it" }))).recorded).toBe(false);
    expect((await run((x) => publicSurveyView(x, order!.externalId!, sig, "en"))).answered).toBe(true);
  });

  it("validates the configuration", async () => {
    await expect(run((x) => saveSurveySettings(x, { enabled: true, config: { ...DEFAULT_SURVEY_CONFIG, options: [DEFAULT_SURVEY_CONFIG.options[0], DEFAULT_SURVEY_CONFIG.options[0]] } }))).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("reports answers against click channels and feeds the survey-blend attribution", async () => {
    const period = { from: new Date(Date.now() - 400 * 864e5), to: new Date(Date.now() + 864e5) };
    const r = await run((x) => surveyResults(x, period, "en"));
    expect(r.responses).toBeGreaterThan(0);
    expect(r.answers.reduce((s, a) => s + a.responses, 0)).toBe(r.responses);
    expect(r.crosstab.find((c) => c.channel === "podcast")).toBeTruthy();
    const tenant = { id: tenantId, country: "IT", currency: "EUR", timezone: "Europe/Rome", settings: parseTenantSettings({}) };
    const blended = await run((x) => attributionReport(x, tenant, period, "survey_blend", "channel"));
    expect(blended.some((row) => row.key === "podcast")).toBe(true);
    const plain = await run((x) => attributionReport(x, tenant, period, "time_decay", "channel"));
    expect(plain.some((row) => row.key === "podcast")).toBe(false);
  });
});
