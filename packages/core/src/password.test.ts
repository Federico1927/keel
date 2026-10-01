import { describe, expect, it } from "vitest";
import { checkPassword } from "./password";

describe("checkPassword", () => {
  it("accepts a long varied password", () => {
    expect(checkPassword("Tramonto-sul-Po-77", { email: "giulia@x.it", name: "Giulia Ferri" })).toEqual({ ok: true, issues: [] });
    expect(checkPassword("correct horse battery staple")).toEqual({ ok: true, issues: [] });
  });
  it("rejects short, common, personal and uniform passwords", () => {
    expect(checkPassword("Ab1!").issues).toContain("too_short");
    expect(checkPassword("password123").issues).toContain("too_common");
    expect(checkPassword("aaaaaaaaaaaa").issues).toContain("too_common");
    expect(checkPassword("Ferri-2026-ok", { name: "Giulia Ferri" }).issues).toContain("personal");
    expect(checkPassword("Mario.rossi.99", { email: "mario.rossi@x.it" }).issues).toEqual(["personal"]);
    expect(checkPassword("Mario.rossi.99", { email: "giulia@x.it" }).issues).toEqual([]);
    expect(checkPassword("abcdefghijk").issues).toContain("low_variety");
  });
});
