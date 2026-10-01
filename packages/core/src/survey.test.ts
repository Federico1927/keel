import { describe, expect, it } from "vitest";
import { DEFAULT_SURVEY_CONFIG, surveyConfigSchema, surveyCrosstab, surveyText } from "./survey";

describe("survey", () => {
  it("ships a valid default in three languages", () => {
    expect(surveyConfigSchema.safeParse(DEFAULT_SURVEY_CONFIG).success).toBe(true);
    expect(surveyText(DEFAULT_SURVEY_CONFIG.question, "it-IT")).toBe("Come ci hai conosciuto?");
    expect(surveyText(DEFAULT_SURVEY_CONFIG.question, "de")).toBe("How did you first hear about us?");
    expect(surveyConfigSchema.safeParse({ ...DEFAULT_SURVEY_CONFIG, options: [{ key: "Bad Key", labels: { en: "x" }, channel: "x" }] }).success).toBe(false);
  });
  it("cross-tabulates answers against click channels", () => {
    const rows = surveyCrosstab([
      { answerChannel: "podcast", clickChannel: "direct" },
      { answerChannel: "podcast", clickChannel: null },
      { answerChannel: "paid_social", clickChannel: "paid_social" },
      { answerChannel: "paid_social", clickChannel: "organic_search" },
    ]);
    expect(rows).toEqual([
      { channel: "podcast", answers: 2, agree: 0, invisible: 2 },
      { channel: "paid_social", answers: 2, agree: 1, invisible: 0 },
    ]);
  });
});
