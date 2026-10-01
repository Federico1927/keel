"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Alert, AlertDescription, Button, Card, CardContent, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from "@keel/ui";
import { createPo } from "@/server/actions/purchasing";
import { RiskBadge } from "@/components/risk-badge";

export function NewPoForm({ slug, suppliers, locations, currency, candidates }: { slug: string; suppliers: { id: string; name: string }[]; locations: { id: string; name: string; isDefault: boolean }[]; currency: string; candidates: { variantId: string; label: string; sku: string | null; available: number; incoming: number; daysOfCover: number | null; risk: string; suggested: number; cost: number }[] }) {
  const t = useTranslations("po_new");
  const tc = useTranslations("common");
  const router = useRouter();
  const [state, action, pending] = useActionState(createPo.bind(null, slug), null);
  useEffect(() => {
    if (state?.ok && state.data?.id) router.push(`/t/${slug}/purchasing/${state.data.id}`);
  }, [state, router, slug]);
  return (
    <form action={action} className="space-y-6">
      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="po-supplier">{t("supplier")}</Label>
            <Select id="po-supplier" name="supplierId" required>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-location">{t("destination")}</Label>
            <Select id="po-location" name="destinationLocationId" defaultValue={locations.find((l) => l.isDefault)?.id ?? ""}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="po-expected">{t("expected")}</Label>
            <Input id="po-expected" name="expectedAt" type="date" />
          </div>
          <div className="space-y-1.5 sm:col-span-4">
            <Label htmlFor="po-notes">{t("notes")}</Label>
            <Textarea id="po-notes" name="notes" rows={2} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("line.variant")}</TableHead>
                <TableHead className="text-right">{t("line.available")}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t("line.incoming")}</TableHead>
                <TableHead>{t("line.cover")}</TableHead>
                <TableHead className="text-right">{t("line.quantity")}</TableHead>
                <TableHead className="text-right">{t("line.unit_cost", { currency })}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow key={c.variantId}>
                  <TableCell>
                    <p className="font-medium">{c.label}</p>
                    <p className="text-xs text-muted-foreground">{c.sku}</p>
                  </TableCell>
                  <TableCell className="text-right tabular">{c.available}</TableCell>
                  <TableCell className="hidden text-right tabular text-muted-foreground md:table-cell">{c.incoming ? `+${c.incoming}` : "—"}</TableCell>
                  <TableCell><RiskBadge risk={c.risk} days={c.daysOfCover} /></TableCell>
                  <TableCell className="text-right"><Input name={`qty_${c.variantId}`} type="number" min={0} defaultValue={c.suggested} className="ml-auto h-8 w-24 text-right" aria-label={t("line.quantity")} /></TableCell>
                  <TableCell className="text-right"><Input name={`cost_${c.variantId}`} type="number" step="0.01" min={0} defaultValue={c.cost.toFixed(2)} className="ml-auto h-8 w-28 text-right" aria-label={t("line.unit_cost", { currency })} /></TableCell>
                </TableRow>
              ))}
              {candidates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground">{t("no_candidates")}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {state && !state.ok && <Alert variant="destructive"><AlertDescription>{tc(`errors.${state.error}`)}</AlertDescription></Alert>}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending || candidates.length === 0}>{t("create")}</Button>
      </div>
    </form>
  );
}
