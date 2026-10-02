"use client";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, Pencil, RefreshCw } from "lucide-react";
import { PRODUCT_EDIT_LIMITS, parseAmountToMinor, parseTagInput, seoPreview } from "@keel/core";
import { Alert, AlertDescription, Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea, cn } from "@keel/ui";
import { saveProductAction, syncProductAction } from "@/server/actions/product-edit";

/**
 * Product page editing (issue #19). Each card edits its own fields and sends them with the version
 * the page was opened on; the server writes to Shopify first and the page reloads from its answer.
 * "Changed in Shopify" offers a reload instead of overwriting someone else's change.
 */

interface EditCtx {
  slug: string;
  productId: string;
  version: string | null;
  canEdit: boolean;
}
const Ctx = createContext<EditCtx | null>(null);
export function ProductEditProvider({ value, children }: { value: EditCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
function useEdit() {
  const c = useContext(Ctx);
  if (!c) throw new Error("ProductEditProvider missing");
  return c;
}

type Payload = { product?: Record<string, unknown>; variants?: Record<string, unknown>[] };

function useSave(onDone: () => void) {
  const { slug, productId, version } = useEdit();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = (payload: Payload) =>
    start(async () => {
      setError(null);
      const r = await saveProductAction(slug, { productId, version, ...payload });
      if (r.ok) {
        onDone();
        router.refresh();
      } else setError(r.error === "platform_error" ? `platform_error:${r.fieldErrors?.platform ?? ""}` : r.error === "invalid_input" && r.fieldErrors?.form ? `invalid:${r.fieldErrors.form}` : r.error);
    });
  return { save, pending, error, setError };
}

/** Error line of a card: stale → reload button; platform refusal → its message. */
export function SaveError({ error }: { error: string | null }) {
  const t = useTranslations("product_mirror.errors");
  const router = useRouter();
  if (!error) return null;
  if (error === "stale")
    return (
      <Alert variant="warning" data-testid="stale-edit">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          {t("stale")}
          <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
            <RefreshCw className="h-3.5 w-3.5" /> {t("reload")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  const [code, detail] = error.split(/:(.*)/s);
  return (
    <Alert variant="destructive">
      <AlertDescription>{code === "platform_error" ? t("platform", { message: detail ?? "" }) : code === "invalid" ? t(`invalid.${detail}`) : t.has(code!) ? t(code!) : t("generic")}</AlertDescription>
    </Alert>
  );
}

/** Card with a read view and, for editors, an edit form toggled by the pencil. */
function EditableCard({ title, testId, read, form, action, className }: { title: string; testId: string; read: React.ReactNode; form: (close: () => void) => React.ReactNode; action?: React.ReactNode; className?: string }) {
  const { canEdit } = useEdit();
  const t = useTranslations("product_mirror");
  const [editing, setEditing] = useState(false);
  return (
    <Card data-testid={testId} className={className}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {action}
          {canEdit && !editing && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={t("edit")} data-testid={`${testId}-edit`}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">{editing ? form(() => setEditing(false)) : read}</CardContent>
    </Card>
  );
}

function FormButtons({ pending, onCancel }: { pending: boolean; onCancel: () => void }) {
  const t = useTranslations("product_mirror");
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>{t("cancel")}</Button>
      <Button type="submit" size="sm" disabled={pending} data-testid="save-product">{pending ? t("saving") : t("save")}</Button>
    </div>
  );
}

const counter = (v: string, max: number) => <span className={cn("text-xs tabular", v.length > max ? "text-destructive" : "text-muted-foreground")}>{v.length}/{max}</span>;

/* ---------- title and description ---------- */

export function DetailsCard({ title, descriptionHtml, safeDescription }: { title: string; descriptionHtml: string | null; safeDescription: string }) {
  const t = useTranslations("product_mirror");
  return (
    <EditableCard
      title={t("details.title")}
      testId="product-details"
      read={
        <>
          <p className="font-medium">{title}</p>
          {safeDescription ? <div className="prose-sm max-w-none space-y-2 text-sm [&_a]:text-primary [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc" data-testid="product-description" dangerouslySetInnerHTML={{ __html: safeDescription }} /> : <p className="text-muted-foreground">{t("details.no_description")}</p>}
        </>
      }
      form={(close) => <DetailsForm title={title} descriptionHtml={descriptionHtml} close={close} />}
    />
  );
}
function DetailsForm({ title, descriptionHtml, close }: { title: string; descriptionHtml: string | null; close: () => void }) {
  const t = useTranslations("product_mirror");
  const [v, setV] = useState({ title, descriptionHtml: descriptionHtml ?? "" });
  const { save, pending, error } = useSave(close);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save({ product: { title: v.title, descriptionHtml: v.descriptionHtml } }); }}>
      <div className="space-y-1">
        <Label htmlFor="pe-title">{t("details.field_title")}</Label>
        <Input id="pe-title" value={v.title} maxLength={PRODUCT_EDIT_LIMITS.title} required onChange={(e) => setV({ ...v, title: e.target.value })} data-testid="edit-title" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="pe-desc">{t("details.field_description")}</Label>
        <Textarea id="pe-desc" rows={8} className="font-mono text-xs" value={v.descriptionHtml} onChange={(e) => setV({ ...v, descriptionHtml: e.target.value })} data-testid="edit-description" />
        <p className="text-xs text-muted-foreground">{t("details.html_hint")}</p>
      </div>
      <SaveError error={error} />
      <FormButtons pending={pending} onCancel={close} />
    </form>
  );
}

/* ---------- status and channels ---------- */

export function StatusCard({ status, channels }: { status: string; channels: { id: string; name: string; published: boolean }[] }) {
  const t = useTranslations("product_mirror");
  const tp = useTranslations("products");
  return (
    <EditableCard
      title={t("status.title")}
      testId="product-status"
      read={
        <>
          <Badge variant={status === "active" ? "success" : "muted"} data-testid="product-status-value">{tp(`status.${status}`)}</Badge>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("status.channels")}</p>
            {channels.length === 0 && <p className="text-xs text-muted-foreground">{t("status.no_channels")}</p>}
            {channels.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span>{c.name}</span>
                <Badge variant={c.published ? "success" : "outline"}>{c.published ? t("status.published") : t("status.not_published")}</Badge>
              </div>
            ))}
          </div>
        </>
      }
      form={(close) => <StatusForm status={status} close={close} />}
    />
  );
}
function StatusForm({ status, close }: { status: string; close: () => void }) {
  const t = useTranslations("product_mirror");
  const tp = useTranslations("products");
  const [v, setV] = useState(status);
  const { save, pending, error } = useSave(close);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save({ product: { status: v } }); }}>
      <Select aria-label={t("status.title")} value={v} onChange={(e) => setV(e.target.value)} data-testid="edit-status">
        {["active", "draft", "archived"].map((s) => <option key={s} value={s}>{tp(`status.${s}`)}</option>)}
      </Select>
      <p className="text-xs text-muted-foreground">{t("status.channels_hint")}</p>
      <SaveError error={error} />
      <FormButtons pending={pending} onCancel={close} />
    </form>
  );
}

/* ---------- organisation ---------- */

export function OrganisationCard({ vendor, productType, categoryId, categoryName, collections, tags }: { vendor: string | null; productType: string | null; categoryId: string | null; categoryName: string | null; collections: { id: string; title: string }[]; tags: string[] }) {
  const t = useTranslations("product_mirror");
  const row = (label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value || <span className="text-muted-foreground">—</span>}</span>
    </div>
  );
  return (
    <EditableCard
      title={t("organisation.title")}
      testId="product-organisation"
      read={
        <div className="space-y-2">
          {row(t("organisation.vendor"), vendor)}
          {row(t("organisation.type"), productType)}
          {row(t("organisation.category"), categoryName)}
          {row(t("organisation.collections"), collections.map((c) => c.title).join(", "))}
          {row(t("organisation.tags"), tags.length ? <span className="flex flex-wrap gap-1" data-testid="product-tags">{tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}</span> : null)}
        </div>
      }
      form={(close) => <OrganisationForm vendor={vendor} productType={productType} categoryId={categoryId} tags={tags} close={close} />}
    />
  );
}
function OrganisationForm({ vendor, productType, categoryId, tags, close }: { vendor: string | null; productType: string | null; categoryId: string | null; tags: string[]; close: () => void }) {
  const t = useTranslations("product_mirror");
  const [v, setV] = useState({ vendor: vendor ?? "", productType: productType ?? "", categoryId: categoryId ?? "", tags: tags.join(", ") });
  const { save, pending, error } = useSave(close);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save({ product: { vendor: v.vendor, productType: v.productType, categoryId: v.categoryId || null, tags: parseTagInput(v.tags) } }); }}>
      <div className="space-y-1"><Label htmlFor="pe-vendor">{t("organisation.vendor")}</Label><Input id="pe-vendor" size="sm" value={v.vendor} maxLength={255} onChange={(e) => setV({ ...v, vendor: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor="pe-type">{t("organisation.type")}</Label><Input id="pe-type" size="sm" value={v.productType} maxLength={255} onChange={(e) => setV({ ...v, productType: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor="pe-cat">{t("organisation.category_id")}</Label><Input id="pe-cat" size="sm" className="font-mono text-xs" value={v.categoryId} placeholder="gid://shopify/TaxonomyCategory/…" onChange={(e) => setV({ ...v, categoryId: e.target.value })} /></div>
      <div className="space-y-1"><Label htmlFor="pe-tags">{t("organisation.tags")}</Label><Input id="pe-tags" size="sm" value={v.tags} onChange={(e) => setV({ ...v, tags: e.target.value })} data-testid="edit-tags" /><p className="text-xs text-muted-foreground">{t("organisation.tags_hint")}</p></div>
      <SaveError error={error} />
      <FormButtons pending={pending} onCancel={close} />
    </form>
  );
}

/* ---------- SEO ---------- */

export function SeoCard({ title, handle, seoTitle, seoDescription, descriptionHtml, storeHost }: { title: string; handle: string | null; seoTitle: string | null; seoDescription: string | null; descriptionHtml: string | null; storeHost: string | null }) {
  const t = useTranslations("product_mirror");
  const preview = seoPreview({ title, handle, seoTitle, seoDescription, descriptionHtml }, storeHost);
  return (
    <EditableCard
      title={t("seo.title")}
      testId="product-seo"
      read={
        <div className="rounded-md border p-3" data-testid="seo-preview">
          <p className="truncate text-xs text-muted-foreground">{preview.url}</p>
          <p className="text-base text-primary">{preview.title}</p>
          <p className="text-xs text-muted-foreground">{preview.description || t("seo.no_description")}</p>
        </div>
      }
      form={(close) => <SeoForm seoTitle={seoTitle} seoDescription={seoDescription} fallbackTitle={title} close={close} />}
    />
  );
}
function SeoForm({ seoTitle, seoDescription, fallbackTitle, close }: { seoTitle: string | null; seoDescription: string | null; fallbackTitle: string; close: () => void }) {
  const t = useTranslations("product_mirror");
  const [v, setV] = useState({ seoTitle: seoTitle ?? "", seoDescription: seoDescription ?? "" });
  const { save, pending, error } = useSave(close);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save({ product: { seoTitle: v.seoTitle || null, seoDescription: v.seoDescription || null } }); }}>
      <div className="space-y-1"><div className="flex justify-between"><Label htmlFor="pe-seo-t">{t("seo.field_title")}</Label>{counter(v.seoTitle, PRODUCT_EDIT_LIMITS.seoTitle)}</div><Input id="pe-seo-t" size="sm" value={v.seoTitle} placeholder={fallbackTitle} maxLength={PRODUCT_EDIT_LIMITS.seoTitle} onChange={(e) => setV({ ...v, seoTitle: e.target.value })} data-testid="edit-seo-title" /></div>
      <div className="space-y-1"><div className="flex justify-between"><Label htmlFor="pe-seo-d">{t("seo.field_description")}</Label>{counter(v.seoDescription, PRODUCT_EDIT_LIMITS.seoDescription)}</div><Textarea id="pe-seo-d" rows={3} value={v.seoDescription} maxLength={PRODUCT_EDIT_LIMITS.seoDescription} onChange={(e) => setV({ ...v, seoDescription: e.target.value })} /></div>
      <SaveError error={error} />
      <FormButtons pending={pending} onCancel={close} />
    </form>
  );
}

/* ---------- variants ---------- */

export interface EditableVariantRow {
  id: string;
  title: string;
  price: string;
  compareAt: string;
  sku: string;
  barcode: string;
  weight: string;
  inventoryPolicy: string;
}

/** Edit mode of the variants table: the fields Keel writes to Shopify, one row per variant; only changed rows are sent. */
export function VariantsEditor({ rows, close }: { rows: EditableVariantRow[]; close: () => void }) {
  const t = useTranslations("product_mirror");
  const [v, setV] = useState(rows);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { save, pending, error } = useSave(close);
  const set = (i: number, patch: Partial<EditableVariantRow>) => setV(v.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const submit = () => {
    const out: Record<string, unknown>[] = [];
    for (const [i, r] of v.entries()) {
      const o = rows[i]!;
      if (JSON.stringify(r) === JSON.stringify(o)) continue;
      const price = parseAmountToMinor(r.price);
      const compareAt = r.compareAt.trim() ? parseAmountToMinor(r.compareAt) : null;
      const weight = r.weight.trim() ? Number(r.weight) : null;
      if (price === null || (r.compareAt.trim() && compareAt === null) || (weight !== null && (!Number.isInteger(weight) || weight < 0))) return setInvalid(r.title);
      out.push({ variantId: r.id, priceMinor: price, compareAtMinor: compareAt, sku: r.sku || null, barcode: r.barcode || null, weightGrams: weight, inventoryPolicy: r.inventoryPolicy === "continue" ? "continue" : "deny" });
    }
    setInvalid(null);
    if (!out.length) return close();
    save({ variants: out });
  };
  return (
    <form className="space-y-3 p-3" onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="variants-editor">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="p-1">{t("variants.variant")}</th><th className="p-1">{t("variants.price")}</th><th className="p-1">{t("variants.compare_at")}</th><th className="p-1">{t("variants.sku")}</th><th className="p-1">{t("variants.barcode")}</th><th className="p-1">{t("variants.weight")}</th><th className="p-1">{t("variants.policy")}</th></tr>
          </thead>
          <tbody>
            {v.map((r, i) => (
              <tr key={r.id} className="border-t">
                <td className="p-1 font-medium">{r.title}</td>
                <td className="p-1"><Input size="sm" inputMode="decimal" className="w-24 text-right" value={r.price} onChange={(e) => set(i, { price: e.target.value })} aria-label={`${t("variants.price")} ${r.title}`} data-testid="edit-variant-price" /></td>
                <td className="p-1"><Input size="sm" inputMode="decimal" className="w-24 text-right" value={r.compareAt} onChange={(e) => set(i, { compareAt: e.target.value })} aria-label={`${t("variants.compare_at")} ${r.title}`} data-testid="edit-variant-compare" /></td>
                <td className="p-1"><Input size="sm" className="w-32" value={r.sku} onChange={(e) => set(i, { sku: e.target.value })} aria-label={`${t("variants.sku")} ${r.title}`} data-testid="edit-variant-sku" /></td>
                <td className="p-1"><Input size="sm" className="w-32" value={r.barcode} onChange={(e) => set(i, { barcode: e.target.value })} aria-label={`${t("variants.barcode")} ${r.title}`} /></td>
                <td className="p-1"><Input size="sm" inputMode="numeric" className="w-20 text-right" value={r.weight} onChange={(e) => set(i, { weight: e.target.value })} aria-label={`${t("variants.weight")} ${r.title}`} /></td>
                <td className="p-1"><Select size="sm" value={r.inventoryPolicy} onChange={(e) => set(i, { inventoryPolicy: e.target.value })} aria-label={`${t("variants.policy")} ${r.title}`}><option value="deny">{t("variants.policy_deny")}</option><option value="continue">{t("variants.policy_continue")}</option></Select></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invalid && <Alert variant="destructive"><AlertDescription>{t("errors.invalid_variant", { variant: invalid })}</AlertDescription></Alert>}
      <SaveError error={error} />
      <FormButtons pending={pending} onCancel={close} />
    </form>
  );
}

/** Variants card shell: the read table (server-rendered, passed in) or the editor. */
export function VariantsCard({ title, rows, children, toolbar }: { title: string; rows: EditableVariantRow[]; children: React.ReactNode; toolbar?: React.ReactNode }) {
  const { canEdit } = useEdit();
  const t = useTranslations("product_mirror");
  const [editing, setEditing] = useState(false);
  return (
    <Card data-testid="product-variants">
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">{title}</CardTitle>
        <div className="flex items-center gap-2">
          {toolbar}
          {canEdit && !editing && rows.length > 0 && <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)} data-testid="edit-variants"><Pencil className="h-3.5 w-3.5" /> {t("variants.edit")}</Button>}
        </div>
      </CardHeader>
      <CardContent className="p-0">{editing ? <VariantsEditor rows={rows} close={() => setEditing(false)} /> : children}</CardContent>
    </Card>
  );
}

/* ---------- header actions ---------- */

export function SyncProductButton() {
  const { slug, productId } = useEdit();
  const t = useTranslations("product_mirror");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending} data-testid="sync-product" onClick={() => start(async () => { const r = await syncProductAction(slug, productId); setMsg(r.ok ? t("sync.done", { changed: r.data?.changed ?? 0 }) : r.error === "platform_error" ? t("errors.platform", { message: r.fieldErrors?.platform ?? "" }) : t("errors.generic")); router.refresh(); })}>
        <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} /> {t("sync.product")}
      </Button>
      {msg && <span className="text-xs text-muted-foreground" data-testid="sync-product-result">{msg}</span>}
    </span>
  );
}

export function EditInShopifyLink({ href }: { href: string | null }) {
  const t = useTranslations("product_mirror");
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline" data-testid="edit-in-shopify">
      {t("edit_in_shopify")} <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}
