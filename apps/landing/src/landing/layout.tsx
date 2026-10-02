import { GeistSans } from "@hullwise/ui/font-sans";
import { SYSTEM_THEME_SCRIPT } from "@hullwise/ui/tokens";
import type { LandingLocale } from "@/config/site";
import "../app/globals.css";

/**
 * Root layout per locale route group: one `<html lang>` per language. Geist Sans (no mono: nothing
 * on the page uses it, and it would be preloaded) and the theme come from
 * packages/ui like in the app; the theme follows the OS (`data-theme="system"`, resolved before the
 * first paint by the product's own inline script, light without JavaScript).
 */
export function LandingLayout({
  locale,
  children,
}: {
  locale: LandingLocale;
  children: React.ReactNode;
}) {
  return (
    <html lang={locale} className={GeistSans.variable} data-theme="system" suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-head-element -- root layout of the locale route groups (App Router), not a page */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
