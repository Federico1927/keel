import type { LandingLocale } from "@/config/site";
import "../app/globals.css";

/** Root layout per locale route group: one `<html lang>` per language. */
export function LandingLayout({
  locale,
  children,
}: {
  locale: LandingLocale;
  children: React.ReactNode;
}) {
  return (
    <html lang={locale}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
