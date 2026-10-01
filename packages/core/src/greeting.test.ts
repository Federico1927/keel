import { describe, expect, it } from "vitest";
import { displayName, greetingKey, hourIn, initials, isTimeZone } from "./greeting";

describe("greetingKey", () => {
  it("uses the given time zone, not the machine's", () => {
    // 06:30 UTC = 08:30 in Rome (CEST) = 02:30 in New York (EDT)
    const d = new Date("2026-07-01T06:30:00Z");
    expect(greetingKey(d, "Europe/Rome")).toBe("morning");
    expect(greetingKey(d, "America/New_York")).toBe("evening");
    expect(greetingKey(new Date("2026-07-02T00:00:00Z"), "America/New_York")).toBe("evening"); // 20:00 EDT
  });
  it("switches exactly at 05:00, 12:00 and 18:00", () => {
    const at = (iso: string) => greetingKey(new Date(iso), "UTC");
    expect(at("2026-03-10T04:59:59Z")).toBe("evening");
    expect(at("2026-03-10T05:00:00Z")).toBe("morning");
    expect(at("2026-03-10T11:59:59Z")).toBe("morning");
    expect(at("2026-03-10T12:00:00Z")).toBe("afternoon");
    expect(at("2026-03-10T17:59:59Z")).toBe("afternoon");
    expect(at("2026-03-10T18:00:00Z")).toBe("evening");
    expect(at("2026-03-10T23:59:59Z")).toBe("evening");
  });
  it("follows daylight saving time changes", () => {
    // Rome: 04:30 UTC is 05:30 CET in winter (morning) but 06:30 CEST after 29 March 2026
    expect(greetingKey(new Date("2026-03-28T04:30:00Z"), "Europe/Rome")).toBe("morning");
    expect(hourIn(new Date("2026-03-28T03:30:00Z"), "Europe/Rome")).toBe(4);
    expect(greetingKey(new Date("2026-03-28T03:30:00Z"), "Europe/Rome")).toBe("evening");
    expect(greetingKey(new Date("2026-03-29T03:30:00Z"), "Europe/Rome")).toBe("morning"); // 05:30 CEST
    // New York, 1 November 2026: 16:30 UTC is 12:30 EDT the day before, 11:30 EST on the day
    expect(greetingKey(new Date("2026-10-31T16:30:00Z"), "America/New_York")).toBe("afternoon");
    expect(greetingKey(new Date("2026-11-01T16:30:00Z"), "America/New_York")).toBe("morning");
  });
  it("handles zones with offsets that are not whole hours and unknown zones", () => {
    expect(greetingKey(new Date("2026-05-10T06:15:00Z"), "Asia/Kolkata")).toBe("morning"); // 11:45
    expect(greetingKey(new Date("2026-05-10T06:45:00Z"), "Asia/Kolkata")).toBe("afternoon"); // 12:15
    expect(greetingKey(new Date("2026-05-10T10:00:00Z"), "Not/AZone")).toBe("morning");
    expect(isTimeZone("Europe/Rome")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("displayName", () => {
  it("prefers the preferred name, then the full name, then the email local part", () => {
    expect(displayName({ preferredName: "Giulia", name: "Giulia Ferri", email: "owner@northwind.demo" })).toBe("Giulia");
    expect(displayName({ preferredName: "  ", name: "Giulia Ferri", email: "owner@northwind.demo" })).toBe("Giulia Ferri");
    expect(displayName({ name: null, email: "mario.rossi@example.com" })).toBe("mario.rossi");
    expect(displayName(null)).toBe("—");
  });
  it("never returns the full email", () => {
    for (const u of [{ email: "a@b.co" }, { name: "", email: "x.y@z.it" }]) expect(displayName(u)).not.toContain("@");
  });
  it("builds initials", () => {
    expect(initials({ name: "Giulia Ferri" })).toBe("GF");
    expect(initials({ name: "Anna Maria de Luca" })).toBe("AL");
    expect(initials({ email: "ops@x.it" })).toBe("OP");
  });
});
