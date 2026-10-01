import Link from "next/link";
import { PRODUCT_NAME } from "@/config/site";
import "./globals.css";

/** Static hosts serve this as 404.html; copy stays minimal and English (no locale in the URL). */
export default function NotFound() {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center p-6">
        <div className="text-center">
          <p className="text-sm uppercase tracking-widest text-muted-foreground">404</p>
          <h1 className="mt-2 text-3xl">Page not found</h1>
          <Link
            href="/"
            className="mt-6 inline-block text-primary underline-offset-4 hover:underline"
          >
            {PRODUCT_NAME}
          </Link>
        </div>
      </body>
    </html>
  );
}
