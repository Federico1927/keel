import { describe, expect, it } from "vitest";
import { DEFAULT_DOCS_URL, docsUrl, onboardingRunbookUrl } from "./urls";

describe("docs links", () => {
  it("point at the repository's docs on main, or at HULLWISE_DOCS_URL", () => {
    expect(docsUrl("DEPLOY.md", {})).toBe(`${DEFAULT_DOCS_URL}/DEPLOY.md`);
    expect(docsUrl("/DEPLOY.md", { HULLWISE_DOCS_URL: "https://docs.example/ops/" })).toBe("https://docs.example/ops/DEPLOY.md");
  });
  it("open the onboarding runbook in Italian for an Italian console, in English otherwise", () => {
    expect(onboardingRunbookUrl("it", {})).toBe(`${DEFAULT_DOCS_URL}/ONBOARDING.it.md`);
    expect(onboardingRunbookUrl("en", {})).toBe(`${DEFAULT_DOCS_URL}/ONBOARDING.md`);
    expect(onboardingRunbookUrl("es", {})).toBe(`${DEFAULT_DOCS_URL}/ONBOARDING.md`);
  });
});
