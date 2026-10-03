import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import CLIENT_NAMESPACES from "./client-namespaces.json";

/**
 * Client messages per route (#49 performance). The whole catalogue is ~0.5 MB per language: sent with
 * every page it was most of the HTML and of the work a phone does before the first paint. Each page and
 * layout now sends only the top-level namespaces its client components use, as listed in
 * client-namespaces.json, which a unit test (src/test/client-namespaces.test.ts) derives from the
 * import graph and keeps current. Server components translate on the server and need none of it.
 */
export type IntlRoute = keyof typeof CLIENT_NAMESPACES;

export async function IntlScope({ route, children }: { route: IntlRoute; children: ReactNode }) {
  const all = (await getMessages()) as Record<string, unknown>;
  const messages = Object.fromEntries((CLIENT_NAMESPACES[route] as readonly string[]).filter((ns) => ns in all).map((ns) => [ns, all[ns]]));
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}

/** A page rendered inside its own message scope: `export default withIntl(Page, "app/…/page.tsx")`. */
export function withIntl<P extends object>(Page: (props: P) => Promise<ReactNode | void> | ReactNode, route: IntlRoute) {
  // a page that only redirects returns nothing
  const Inner = Page as (props: P) => Promise<ReactNode>;
  async function IntlPage(props: P) {
    return <IntlScope route={route}><Inner {...props} /></IntlScope>;
  }
  IntlPage.displayName = `withIntl(${Page.name || "Page"})`;
  return IntlPage;
}
