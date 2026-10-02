import { GeistSans } from "@keel/ui/font-sans";
import { SYSTEM_THEME_SCRIPT } from "@keel/ui/tokens";
import { PRODUCT_NAME } from "@/config/site";
import "./globals.css";

/** Static hosts serve this as 404.html; copy stays minimal and English (no locale in the URL). */
export default function NotFound() {
  return (
    <html lang="en" className={GeistSans.variable} data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SYSTEM_THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">404</p>
          <h1 className="mt-2 text-3xl font-semibold">Page not found</h1>
          <a href="/" className="mt-6 inline-block text-primary underline-offset-4 hover:underline">
            {PRODUCT_NAME}
          </a>
        </div>
      </body>
    </html>
  );
}
