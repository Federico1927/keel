import { cx } from "@/lib/cx";

const BUTTON =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50";
const VARIANTS = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-strong",
  outline: "border border-border bg-card text-foreground hover:bg-muted",
  ghost: "text-foreground hover:bg-muted",
  inverted: "bg-card text-ink hover:bg-secondary",
} as const;
const SIZES = { md: "h-10 px-4", lg: "h-12 px-6 text-base" } as const;

export function buttonClass(
  variant: keyof typeof VARIANTS = "primary",
  size: keyof typeof SIZES = "md",
  className?: string,
) {
  return cx(BUTTON, VARIANTS[variant], SIZES[size], className);
}

export function ButtonLink({
  href,
  variant,
  size,
  className,
  external,
  children,
}: {
  href: string;
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  className?: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  const cls = buttonClass(variant, size, className);
  if (external || href.startsWith("http") || href.startsWith("mailto:")) {
    return (
      <a
        href={href}
        className={cls}
        {...(href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <a href={href} className={cls}>
      {children}
    </a>
  );
}

export function Section({
  id,
  eyebrow,
  title,
  lead,
  tone = "default",
  children,
  className,
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: string;
  tone?: "default" | "muted";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={cx(
        "scroll-mt-20 py-16 sm:py-24",
        tone === "muted" && "bg-secondary/60",
        className,
      )}
    >
      <div className="container-x">
        <div className="max-w-3xl">
          {eyebrow && (
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              {eyebrow}
            </p>
          )}
          <h2 className="text-3xl leading-tight sm:text-4xl">{title}</h2>
          {lead && <p className="mt-4 text-lg leading-relaxed text-muted-foreground">{lead}</p>}
        </div>
        <div className="mt-10 sm:mt-14">{children}</div>
      </div>
    </section>
  );
}
