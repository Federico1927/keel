import { describe, expect, it } from "vitest";
import { isDevInboxEnabled } from "./dev-inbox";

describe("dev inbox", () => {
  it("exists in development only, never in a production build, whatever the integration mode", () => {
    expect(isDevInboxEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isDevInboxEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isDevInboxEnabled({ NODE_ENV: "production", HULLWISE_INTEGRATION_MODE: "mock" })).toBe(false);
    expect(isDevInboxEnabled({})).toBe(false);
  });
});
