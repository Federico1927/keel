import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps src/i18n/client-namespaces.json in step with the code (#49 performance): for every page and
 * layout, the top-level message namespaces used by the client components it renders, found by
 * following imports from the route file (anything imported by a "use client" file runs on the client
 * too). Pages send exactly those namespaces through `withIntl`; a layout sends its own plus the ones of
 * the not-found/error/loading files it wraps.
 *
 * A client file that picks its namespace at run time (`useTranslations(guide.namespace)`, `t(item.labelKey)`
 * on a root translator) declares what it may use with a comment: `// i18n-client-namespaces: nav, mobile`
 * (added to what the literal keys show).
 *
 * After changing translations used by client components, regenerate the manifest:
 *   UPDATE_CLIENT_NAMESPACES=1 pnpm --filter @hullwise/web test -- client-namespaces
 */
const SRC = path.resolve(__dirname, "..");
const APP = path.join(SRC, "app");
const MANIFEST = path.join(SRC, "i18n/client-namespaces.json");
const SPECIAL = ["not-found.tsx", "error.tsx", "loading.tsx", "template.tsx", "default.tsx"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

const files = new Map(walk(SRC).map((f) => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) if (files.has(c)) return c;
  return null;
}

const IMPORT = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const deps = new Map([...files].map(([f, src]) => [f, [...src.matchAll(IMPORT)].map((m) => resolveImport(f, (m[1] ?? m[2])!)).filter((x): x is string => Boolean(x))]));
const isClient = (f: string) => /^\s*["']use client["']/.test(files.get(f)!);

/** Namespaces a client file reads, or the problems that make them unknowable without a directive. */
export function namespacesOf(src: string): { namespaces: Set<string>; unknown: string[] } {
  const namespaces = new Set<string>();
  const unknown: string[] = [];
  const directive = src.match(/i18n-client-namespaces:[ \t]*([a-z0-9_, \t]+)/);
  if (directive) for (const n of directive[1]!.split(/[\s,]+/).filter(Boolean)) namespaces.add(n);
  const assigned = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*useTranslations\(\s*([^)]*)\)/g)].map((m) => ({ id: m[1]!, arg: m[2]!.trim() }));
  // a name bound both to a root and to a namespaced translator (in different components) can't be read by name
  const shadowed = new Set(assigned.filter((a) => a.arg !== "").map((a) => a.id));
  for (const { id, arg } of assigned) {
    const literal = arg.match(/^["'`]([a-zA-Z0-9_]+)(?:\.[^"'`]*)?["'`]$/);
    if (literal) namespaces.add(literal[1]!);
    else if (arg === "") {
      // root translator: the first key segment is the namespace; dynamic keys need the directive
      if (shadowed.has(id)) {
        if (!directive) unknown.push(`${id}: root and namespaced translators share the name`);
        continue;
      }
      for (const call of src.matchAll(new RegExp(`\\b${id}(?:\\.(?:rich|raw|has|markup))?\\(\\s*([^,)]*)`, "g"))) {
        const key = call[1]!.trim().match(/^["'`]([a-zA-Z0-9_]+)\./);
        if (key) namespaces.add(key[1]!);
        else if (!directive) unknown.push(`${id}(${call[1]!.trim()})`);
      }
    } else if (!directive) unknown.push(`useTranslations(${arg})`);
  }
  for (const m of src.matchAll(/useTranslations\(\s*([^)]*)\)/g)) {
    // a translator used without a variable (rare) with a literal namespace
    const literal = m[1]!.trim().match(/^["'`]([a-zA-Z0-9_]+)/);
    if (literal) namespaces.add(literal[1]!);
  }
  return { namespaces, unknown };
}

/** Client namespaces reachable from a route file. */
function closure(entry: string): { namespaces: Set<string>; unknown: string[] } {
  const seen = new Set<string>();
  const out = new Set<string>();
  const unknown: string[] = [];
  const stack: [string, boolean][] = [[entry, false]];
  while (stack.length) {
    const [f, parentClient] = stack.pop()!;
    const client = parentClient || isClient(f);
    const key = `${f}|${client}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (client) {
      const r = namespacesOf(files.get(f)!);
      for (const n of r.namespaces) out.add(n);
      unknown.push(...r.unknown.map((u) => `${rel(f)}: ${u}`));
    }
    for (const d of deps.get(f) ?? []) stack.push([d, client]);
  }
  return { namespaces: out, unknown };
}

const routes = [...files.keys()].filter((f) => f.startsWith(APP) && /\/(page|layout)\.tsx$/.test(f));
const layouts = routes.filter((f) => f.endsWith("/layout.tsx"));
/** The layout that wraps a special file: the nearest one in its directory or above. */
const layoutOf = (f: string) => layouts.filter((l) => f.startsWith(path.dirname(l) + path.sep)).sort((a, b) => b.length - a.length)[0]!;

function compute() {
  const manifest: Record<string, string[]> = {};
  const unknown: string[] = [];
  for (const r of routes) {
    const c = closure(r);
    manifest[rel(r)] = [...c.namespaces];
    unknown.push(...c.unknown);
  }
  for (const f of [...files.keys()].filter((x) => x.startsWith(APP) && SPECIAL.includes(path.basename(x)))) {
    const c = closure(f);
    const key = rel(layoutOf(f));
    manifest[key] = [...new Set([...manifest[key]!, ...c.namespaces])];
    unknown.push(...c.unknown);
  }
  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, [...manifest[k]!].sort()]));
  return { manifest: sorted, unknown: [...new Set(unknown)] };
}

describe("client message namespaces (#49 performance)", () => {
  const { manifest, unknown } = compute();

  it("every runtime-chosen namespace is declared with an i18n-client-namespaces comment", () => {
    expect(unknown).toEqual([]);
  });

  it("client-namespaces.json matches the code (UPDATE_CLIENT_NAMESPACES=1 regenerates it)", () => {
    if (process.env.UPDATE_CLIENT_NAMESPACES) writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(JSON.parse(readFileSync(MANIFEST, "utf8"))).toEqual(manifest);
  });

  it("every namespace in the manifest exists in the English catalogue", () => {
    const en = JSON.parse(readFileSync(path.join(SRC, "../messages/en.json"), "utf8")) as Record<string, unknown>;
    const missing = [...new Set(Object.values(manifest).flat())].filter((n) => !(n in en));
    expect(missing).toEqual([]);
  });

  it("every page renders in its own scope and every layout provides its own", () => {
    const offenders: string[] = [];
    for (const r of routes) {
      const src = files.get(r)!;
      const key = rel(r);
      if (r.endsWith("/page.tsx") && !src.includes(`withIntl(`) ) offenders.push(`${key}: export default withIntl(Page, "${key}")`);
      else if (r.endsWith("/page.tsx") && !src.includes(`"${key}")`)) offenders.push(`${key}: withIntl names another route`);
      if (r.endsWith("/layout.tsx") && !src.includes(`route="${key}"`)) offenders.push(`${key}: <IntlScope route="${key}">`);
    }
    expect(offenders).toEqual([]);
  });

  it("the analysis reads literal, root and declared namespaces", () => {
    expect([...namespacesOf(`const t = useTranslations("orders.filters"); const r = useTranslations(); r("common.save"); r(\`roles.\${x}\`)`).namespaces].sort()).toEqual(["common", "orders", "roles"]);
    expect(namespacesOf(`const t = useTranslations(ns);`).unknown).toHaveLength(1);
    expect(namespacesOf(`// i18n-client-namespaces: nav, mobile\nconst t = useTranslations(); t(item.labelKey); t("roles.x")`)).toEqual({ namespaces: new Set(["nav", "mobile", "roles"]), unknown: [] });
    expect(namespacesOf(`const t = useTranslations(); t(m.key); function B() { const t = useTranslations("integrations"); t("card.x") }`).unknown).toHaveLength(1);
  });
});
