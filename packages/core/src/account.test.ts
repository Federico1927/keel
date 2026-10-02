import { describe, expect, it } from "vitest";
import { describeUserAgent, isNewDevice, safeNextPath } from "./account";

const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const WIN_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0";

describe("describeUserAgent", () => {
  it("names browser and OS family", () => {
    expect(describeUserAgent(MAC_CHROME)?.label).toBe("Chrome · macOS");
    expect(describeUserAgent(IPHONE)?.label).toBe("Safari · iOS");
    expect(describeUserAgent(WIN_EDGE)?.label).toBe("Edge · Windows");
    expect(describeUserAgent("curl/8")?.label).toBe("Browser");
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe("isNewDevice", () => {
  it("is false on the first sign-in and for a known browser, true for an unseen one", () => {
    expect(isNewDevice(MAC_CHROME, [])).toBe(false);
    expect(isNewDevice(MAC_CHROME, [IPHONE, MAC_CHROME.replace("129", "130")])).toBe(false);
    expect(isNewDevice(WIN_EDGE, [IPHONE, MAC_CHROME])).toBe(true);
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths and refuses everything else", () => {
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
    expect(safeNextPath("/t/x?y=1")).toBe("/t/x?y=1");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "", null, 3]) expect(safeNextPath(bad)).toBe("/");
  });
});
