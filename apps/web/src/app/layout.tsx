import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { PRODUCT_NAME } from "@hullwise/config";
import { GeistMono, GeistSans } from "@hullwise/ui/fonts";
import { SYSTEM_THEME_SCRIPT, THEME_COOKIE, TOKENS, isThemePreference, type Density, type ThemePreference } from "@hullwise/ui/tokens";
import { getCurrentUser } from "@/server/session";
import { ThemeSync } from "@/components/theme-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "Operations platform for e-commerce teams",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: TOKENS.light.bg },
    { media: "(prefers-color-scheme: dark)", color: TOKENS.dark.bg },
  ],
};

/**
 * Theme and density come from the signed-in user's profile and are rendered on <html> by the
 * server, so the first paint is already right. Signed out, the cookie mirror of the last saved
 * choice is used. Only "system" needs the browser: a tiny inline script resolves it before paint.
 */
async function appearance(): Promise<{ theme: ThemePreference; density: Density }> {
  try {
    const user = await getCurrentUser();
    if (user) return { theme: user.theme, density: user.density };
  } catch {
    // no database (static build steps): fall back to the cookie
  }
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  return { theme: isThemePreference(saved) ? saved : "system", density: "comfortable" };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  const { theme, density } = await appearance();
  const classes = [GeistSans.variable, GeistMono.variable, theme === "dark" ? "dark" : ""].filter(Boolean).join(" ");
  return (
    <html lang={locale} className={classes} data-theme={theme} data-density={density} suppressHydrationWarning>
      <head>{theme === "system" && <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />}</head>
      <body className="min-h-screen antialiased">
        <ThemeSync theme={theme} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
