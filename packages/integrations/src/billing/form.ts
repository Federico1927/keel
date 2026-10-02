/** Stripe's form encoding: nested objects and arrays in bracket notation (`items[0][price]=…`). */
export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };

export function encodeForm(obj: Record<string, FormValue>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: FormValue) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else out.append(prefix, String(v));
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return out.toString();
}

/** The reverse, for the test double: `a[b][0]=x` → { a: { b: { "0": "x" } } } (arrays stay index-keyed objects). */
export function parseForm(body: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const parts = key.replace(/\]/g, "").split("[");
    let node = root;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) node[p] = value;
      else node = (node[p] ??= {}) as Record<string, unknown>;
    });
  }
  return root;
}

/** Index-keyed object (from `parseForm`) back to an array, in index order. */
export function formList<T = Record<string, unknown>>(v: unknown): T[] {
  if (!v || typeof v !== "object") return [];
  return Object.entries(v as Record<string, T>).sort((a, b) => Number(a[0]) - Number(b[0])).map(([, x]) => x);
}
