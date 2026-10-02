"use client";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Boxes, Package, Search, ShoppingBag, Truck, User } from "lucide-react";
import { Button, Dialog, DialogContent, DialogTitle, Input, cn } from "@keel/ui";
import type { GlobalSearchResult } from "@keel/services";
import { globalSearchAction } from "@/server/actions/lists";

type Hit = { key: string; href: string; group: "orders" | "customers" | "products" | "purchase_orders"; title: string; detail: string };

/**
 * ⌘K / Ctrl+K global search (orders, customers, products/SKU, purchase orders). Self-contained:
 * the topbar renders `<CommandSearch slug={…} />`. One server action per query, debounced.
 */
export function CommandSearch({ slug }: { slug: string }) {
  const t = useTranslations("lists.search");
  const ts = useTranslations("order_status");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [active, setActive] = useState(0);
  const [pending, start] = useTransition();
  const seq = useRef(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return;
    const id = ++seq.current;
    const timer = setTimeout(() => start(async () => {
      const r = await globalSearchAction(slug, q);
      if (id === seq.current && r.ok) {
        setResult(r.data ?? null);
        setActive(0);
      }
    }), 200);
    return () => clearTimeout(timer);
  }, [q, slug]);

  const hits = useMemo<Hit[]>(() => {
    if (!result || q.trim().length < 2) return [];
    const base = `/t/${slug}`;
    return [
      ...result.orders.map((o) => ({ key: `o${o.id}`, href: `${base}/orders/${o.id}`, group: "orders" as const, title: o.name, detail: [o.customerName, o.email, ts.has(o.status) ? ts(o.status) : o.status].filter(Boolean).join(" · ") })),
      ...result.customers.map((c) => ({ key: `c${c.id}`, href: `${base}/customers/${c.id}`, group: "customers" as const, title: c.name, detail: [c.email, c.phone, t("orders_count", { count: c.ordersCount })].filter(Boolean).join(" · ") })),
      ...result.products.map((p) => ({ key: `p${p.id}`, href: `${base}/products/${p.id}`, group: "products" as const, title: p.title, detail: [p.sku, p.status].filter(Boolean).join(" · ") })),
      ...result.purchaseOrders.map((p) => ({ key: `po${p.id}`, href: `${base}/purchasing/${p.id}`, group: "purchase_orders" as const, title: p.number, detail: `${p.supplier} · ${p.status}` })),
    ];
  }, [result, q, slug, t, ts]);

  const go = useCallback((h: Hit | undefined) => {
    if (!h) return;
    setOpen(false);
    setQ("");
    setResult(null);
    router.push(h.href);
  }, [router]);

  const icon = { orders: ShoppingBag, customers: User, products: Package, purchase_orders: Truck } as const;
  let lastGroup = "";
  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setOpen(true)} aria-label={t("open_label")} data-testid="command-search-trigger">
        <Search className="h-4 w-4" />
        <span className="hidden md:inline">{t("placeholder_short")}</span>
        <kbd className="hidden rounded border bg-muted px-1.5 text-[10px] font-medium md:inline">⌘K</kbd>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[12vh] max-w-xl translate-y-0 gap-0 p-0 sm:top-[15vh]">
          <DialogTitle className="sr-only">{t("open")}</DialogTitle>
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
                if (e.key === "Enter") { e.preventDefault(); go(hits[active]); }
              }}
              placeholder={t("placeholder")}
              className="h-12 border-0 shadow-none focus-visible:ring-0"
              aria-label={t("placeholder")}
              data-testid="command-search-input"
            />
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-1" role="listbox" aria-busy={pending}>
            {q.trim().length < 2 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t("hint")}</p>
            ) : hits.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{pending || !result ? t("searching") : t("no_results")}</p>
            ) : (
              hits.map((h, i) => {
                const header = h.group !== lastGroup ? t(`groups.${h.group}`) : null;
                lastGroup = h.group;
                const Icon = icon[h.group] ?? Boxes;
                return (
                  <div key={h.key}>
                    {header && <p className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{header}</p>}
                    <button type="button" role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(h)} className={cn("flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm", i === active ? "bg-muted" : "hover:bg-muted/60")} data-testid="command-search-hit">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{h.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{h.detail}</span>
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
