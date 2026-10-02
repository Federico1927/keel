export * from "./types";
export * from "./crypto";
export * from "./rng";
export * from "./mock";
export * from "./http";
export * from "./shopify";
export * from "./meta";
export * from "./google";
export * from "./tiktok";

export const INTEGRATION_MODES = ["mock", "live"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
export function integrationMode(): IntegrationMode {
  return process.env.HULLWISE_INTEGRATION_MODE === "live" ? "live" : "mock";
}
export * from "./notify";
export * from "./email";
export * from "./audience";
export * from "./conversions";
export * from "./llm";
export * from "./billing";
export * from "./subscriptions";
export * from "./address";
export * from "./spoki";
export * from "./ga4";
export * from "./accounting";
