import { SCREENSHOT_ASPECT, screenshotSrcSet, type ScreenshotRole } from "@/config/screenshots";
import { PRODUCT_NAME, type LandingLocale } from "@/config/site";
import { cx } from "@/lib/cx";

/** A product screenshot inside a browser-window chrome. All captures share the 16:10 ratio. */
export function BrowserFrame({
  locale,
  name,
  role,
  alt,
  priority = false,
  sizes,
  className,
}: {
  locale: LandingLocale;
  name: string;
  role: ScreenshotRole;
  alt: string;
  priority?: boolean;
  /** `sizes` attribute for responsive selection, e.g. "(min-width: 1024px) 50vw, 100vw". */
  sizes: string;
  className?: string;
}) {
  const { src, srcSet } = screenshotSrcSet(locale, name, role);
  return (
    <figure
      className={cx(
        "overflow-hidden rounded-xl border border-border bg-card shadow-[0_24px_60px_-24px_rgba(20,30,50,0.35)]",
        className,
      )}
    >
      <div
        className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2"
        aria-hidden="true"
      >
        <span className="flex gap-1.5">
          <i className="size-2.5 rounded-full bg-border" />
          <i className="size-2.5 rounded-full bg-border" />
          <i className="size-2.5 rounded-full bg-border" />
        </span>
        <span className="mx-auto hidden h-5 min-w-40 items-center justify-center rounded-md bg-card px-3 text-[10px] text-muted-foreground sm:flex">
          {PRODUCT_NAME} · Harbor Home
        </span>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- static export: WebP sizes are pre-generated, no image optimiser at runtime */}
      <img
        src={src}
        srcSet={srcSet}
        sizes={sizes}
        width={SCREENSHOT_ASPECT.width}
        height={SCREENSHOT_ASPECT.height}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        fetchPriority={priority ? "high" : "auto"}
        className="block h-auto w-full"
      />
    </figure>
  );
}
