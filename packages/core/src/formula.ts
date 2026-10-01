/**
 * Custom metrics: a formula over named base metrics, e.g. `(net_revenue - ad_spend) / orders`.
 * Tiny recursive-descent parser (numbers, identifiers, + - * /, parentheses, unary minus) that
 * never evaluates JavaScript; unknown identifiers and division by zero yield null.
 */
export type FormulaNode = { t: "num"; v: number } | { t: "id"; name: string } | { t: "neg"; e: FormulaNode } | { t: "bin"; op: "+" | "-" | "*" | "/"; l: FormulaNode; r: FormulaNode };

export class FormulaError extends Error {}

export function parseFormula(src: string): FormulaNode {
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const expr = (): FormulaNode => {
    let left = term();
    for (;;) {
      skip();
      const c = peek();
      if (c !== "+" && c !== "-") return left;
      i++;
      left = { t: "bin", op: c, l: left, r: term() };
    }
  };
  const term = (): FormulaNode => {
    let left = factor();
    for (;;) {
      skip();
      const c = peek();
      if (c !== "*" && c !== "/") return left;
      i++;
      left = { t: "bin", op: c, l: left, r: factor() };
    }
  };
  const factor = (): FormulaNode => {
    skip();
    const c = peek();
    if (c === "-") {
      i++;
      return { t: "neg", e: factor() };
    }
    if (c === "(") {
      i++;
      const e = expr();
      skip();
      if (peek() !== ")") throw new FormulaError(`expected ) at ${i}`);
      i++;
      return e;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return { t: "num", v: Number(num[0]) };
    }
    const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
    if (id) {
      i += id[0].length;
      return { t: "id", name: id[0].toLowerCase() };
    }
    throw new FormulaError(`unexpected ${c ?? "end"} at ${i}`);
  };
  const tree = expr();
  skip();
  if (i < src.length) throw new FormulaError(`unexpected ${src[i]} at ${i}`);
  return tree;
}

export function formulaIdentifiers(node: FormulaNode, out = new Set<string>()): Set<string> {
  if (node.t === "id") out.add(node.name);
  else if (node.t === "neg") formulaIdentifiers(node.e, out);
  else if (node.t === "bin") {
    formulaIdentifiers(node.l, out);
    formulaIdentifiers(node.r, out);
  }
  return out;
}

export function evaluateFormula(node: FormulaNode, values: Readonly<Record<string, number | null>>): number | null {
  switch (node.t) {
    case "num":
      return node.v;
    case "id": {
      const v = values[node.name];
      return v === undefined || v === null || !Number.isFinite(v) ? null : v;
    }
    case "neg": {
      const v = evaluateFormula(node.e, values);
      return v === null ? null : -v;
    }
    case "bin": {
      const l = evaluateFormula(node.l, values);
      const r = evaluateFormula(node.r, values);
      if (l === null || r === null) return null;
      if (node.op === "+") return l + r;
      if (node.op === "-") return l - r;
      if (node.op === "*") return l * r;
      return r === 0 ? null : l / r;
    }
  }
}

/** Validates against the allowed base metrics; returns the parsed tree or the first error. */
export function compileFormula(src: string, allowed: readonly string[]): { ok: true; node: FormulaNode } | { ok: false; error: string } {
  try {
    const node = parseFormula(src);
    const unknown = [...formulaIdentifiers(node)].filter((n) => !allowed.includes(n));
    return unknown.length ? { ok: false, error: `unknown metric: ${unknown.join(", ")}` } : { ok: true, node };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
