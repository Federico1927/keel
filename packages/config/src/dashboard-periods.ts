/** Dashboard periods, in a module of their own so the home's period links load no schema code (zod). */
export const DASHBOARD_PERIODS = ["today", "7d", "30d", "90d", "mtd", "last_month", "ytd"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = "30d";
