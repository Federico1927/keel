/** The dev inbox exists in development only: a production build answers 404, whatever the integration mode. */
export function isDevInboxEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === "development" || env.NODE_ENV === "test";
}
