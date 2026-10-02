import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { FilterPanel, cn } from "@hullwise/ui";
import { sortTarget, type SortOption, type SortProps } from "./table-query";

/** Id of the page's filter form: on phones the sheet's "Show results" submits it (the form's own button is for wider screens). */
export const ADMIN_FILTER_FORM = "admin-filters";

export interface AdminFilterChip { key: string; label: string; href: string }

/**
 * The console's filter form on a phone (#49, Tier 2): inline from `md` up, behind a "Filters (n)"
 * button that opens them as a bottom sheet. The pages stay server-rendered GET forms; active filters
 * show as removable link chips on phones, the sort options (the hidden header row's links) sit at the
 * top of the sheet, and "Show results" submits the form (`id={ADMIN_FILTER_FORM}`).
 */
export async function AdminFilters({ chips = [], sorts, aside, className = "mb-4", children }: { className?: string; chips?: AdminFilterChip[]; sorts?: { props: SortProps; options: SortOption[]; defaultSort?: string }; aside?: React.ReactNode; children: React.ReactNode }) {
  const tm = await getTranslations("mobile");
  const t = await getTranslations("admin.filters");
  const sortActive = sorts ? sorts.props.sort !== (sorts.defaultSort ?? sorts.options[0]?.column) : false;
  return (
    <FilterPanel
      className={className}
      label={tm("filters.label")}
      title={tm("filters.title")}
      doneLabel={tm("filters.done")}
      doneForm={ADMIN_FILTER_FORM}
      closeLabel={tm("close")}
      activeCount={chips.length + (sortActive ? 1 : 0)}
      aside={aside}
      chips={chips.length > 0 ? chips.map((c) => (
        <Link key={c.key} href={c.href} className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs pointer-coarse:min-h-9 md:hidden" data-testid={`chip-${c.key}`}>
          <span className="truncate">{c.label}</span> <X className="h-3 w-3 shrink-0" aria-hidden /><span className="sr-only">{tm("filters.remove")}</span>
        </Link>
      )) : undefined}
    >
      {sorts && (
        <div className="mb-3 md:hidden" data-testid="sort-options">
          <p className="mb-1.5 text-sm font-medium">{t("sort")}</p>
          <div className="flex flex-wrap gap-2">
            {sorts.options.map((o) => {
              const { active, href } = sortTarget(sorts.props, o);
              const Icon = sorts.props.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <Link key={o.column} href={href} aria-current={active ? "true" : undefined} className={cn("inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs pointer-coarse:min-h-9", active ? "bg-primary text-primary-foreground" : "bg-card")} data-testid={`sort-option-${o.column}`}>
                  {o.label}{active && <Icon className="h-3 w-3" aria-hidden />}
                </Link>
              );
            })}
          </div>
        </div>
      )}
      {children}
    </FilterPanel>
  );
}
