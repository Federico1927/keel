export * from "./types";
export * from "./crypto";
export * from "./rng";
export * from "./mock";

export const INTEGRATION_MODES = ["mock", "live"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];
export function integrationMode(): IntegrationMode {
  return process.env.KEEL_INTEGRATION_MODE === "live" ? "live" : "mock";
}
