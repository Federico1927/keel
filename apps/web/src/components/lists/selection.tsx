"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Checkbox } from "@keel/ui";

interface SelectionState {
  ids: string[];
  selected: ReadonlySet<string>;
  toggle(id: string, on: boolean): void;
  setAll(on: boolean): void;
  clear(): void;
}

const SelectionContext = createContext<SelectionState | null>(null);

/**
 * Row selection of one list page (the rows currently shown). Wraps the table and the bulk bar; the
 * selection resets when the rows change (new filters or page).
 */
export function ListSelection({ ids, children }: { ids: string[]; children: React.ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const key = ids.join(",");
  useEffect(() => setSelected(new Set()), [key]);
  const toggle = useCallback((id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  }), []);
  const setAll = useCallback((on: boolean) => setSelected(on ? new Set(ids) : new Set()), [ids]);
  const clear = useCallback(() => setSelected(new Set()), []);
  const value = useMemo(() => ({ ids, selected, toggle, setAll, clear }), [ids, selected, toggle, setAll, clear]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionState {
  const s = useContext(SelectionContext);
  if (!s) throw new Error("useSelection outside ListSelection");
  return s;
}

export function SelectAllCheckbox() {
  const t = useTranslations("lists");
  const { ids, selected, setAll } = useSelection();
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  const some = !all && ids.some((id) => selected.has(id));
  return <Checkbox aria-label={t("select_all")} checked={all ? true : some ? "indeterminate" : false} onCheckedChange={(v) => setAll(v === true)} data-testid="select-all" />;
}

export function RowCheckbox({ id, label }: { id: string; label: string }) {
  const t = useTranslations("lists");
  const { selected, toggle } = useSelection();
  return <Checkbox aria-label={t("select_row", { label })} checked={selected.has(id)} onCheckedChange={(v) => toggle(id, v === true)} data-testid="select-row" />;
}
