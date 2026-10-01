export * from "./types";
export * from "./crypto";
export * from "./rng";
export * from "./mock";
export * from "./http";
export * from "./shopify";
export * from "./meta";
export * from "./google";

export const INTEGRATION_MODES = ["mock", "live"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
export function integrationMode(): IntegrationMode {
  return process.env.KEEL_INTEGRATION_MODE === "live" ? "live" : "mock";
}
export * from "./notify";
export * from "./audience";
export * from "./conversions";
