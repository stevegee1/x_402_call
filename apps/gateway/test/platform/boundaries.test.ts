import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture rule (architecture.md §2): the kernel never imports a product, and products never
 * import money or trust internals. Only the composition root (server.ts) wires them together.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Relative imports of a file, resolved to paths relative to src/. */
function imports(file: string): { spec: string; target: string; typeOnly: boolean }[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+"(\.[^"]+)"/gm)].map((m) => ({
    spec: m[3]!,
    target: relative(SRC, resolve(dirname(file), m[3]!)),
    typeOnly: Boolean(m[2]),
  }));
}

const rel = (f: string) => relative(SRC, f);
const all = files(SRC);
const productFiles = all.filter((f) => rel(f).startsWith("products/"));
const kernelFiles = all.filter((f) => !rel(f).startsWith("products/") && rel(f) !== "server.ts");

describe("module boundaries", () => {
  it("finds the files it is checking", () => {
    expect(productFiles.length).toBeGreaterThan(4);
    expect(kernelFiles.length).toBeGreaterThan(20);
  });

  it("kernel code never imports a product", () => {
    const bad = kernelFiles.flatMap((f) => imports(f).filter((i) => i.target.startsWith("products/")).map((i) => `${rel(f)} → ${i.spec}`));
    expect(bad).toEqual([]);
  });

  it("products never import billing, settlement, ledger, credits or HTTP route internals", () => {
    const forbidden = ["payments/", "ledger/", "credits/", "routes/", "app"];
    const bad = productFiles.flatMap((f) =>
      imports(f)
        .filter((i) => forbidden.some((x) => i.target === x || i.target.startsWith(x)))
        .map((i) => `${rel(f)} → ${i.spec}`),
    );
    expect(bad).toEqual([]);
  });

  it("products only import platform, store, logger and metrics as types (no kernel runtime coupling)", () => {
    const bad = productFiles.flatMap((f) =>
      imports(f)
        .filter((i) => !i.target.startsWith("products/") && !i.typeOnly)
        .map((i) => `${rel(f)} → ${i.spec}`),
    );
    expect(bad).toEqual([]);
  });

  it("products do not import each other", () => {
    const bad = productFiles.flatMap((f) => {
      const own = rel(f).split("/")[1];
      return imports(f)
        .filter((i) => i.target.startsWith("products/") && i.target.split("/")[1] !== own)
        .map((i) => `${rel(f)} → ${i.spec}`);
    });
    expect(bad).toEqual([]);
  });
});

describe("product status is read safely", () => {
  /** Any call of a `status` member: dotted, optional, computed, wrapped across lines, or via call/apply. */
  const STATUS_CALL = /(?:\.\s*status|\[\s*["'`]status["'`]\s*\])\s*(?:\?\.\s*)?(?:\(|\.\s*(?:call|apply)\s*\()/;
  /** Members named status that are not a product's: an HTTP response's status, an iterator over NATS status. */
  const NOT_A_PRODUCT = /\b(?:c\.res|res|response|conn|this\.history|history)\s*\.\s*status\s*\(/;

  it("the pattern catches every way of calling it", () => {
    for (const hit of ["p.status()", "p?.status()", "products[0].status()", "find(x)!.status()", "(p as Product).status()", "p\n  .status()", 'p["status"]()', "p.status?.()", "p.status.call(p)"]) expect(STATUS_CALL.test(hit), hit).toBe(true);
    for (const miss of ["c.res.status", "res.status === 200", "statusOf(p)", "p.statusText"]) expect(STATUS_CALL.test(miss), miss).toBe(false);
  });

  it("kernel code reads a product's status only through statusOf (a throwing status() must not 500 a route)", () => {
    const offenders = all
      .filter((f) => !rel(f).startsWith("products/") && rel(f) !== "platform/product-watch.ts")
      .flatMap((f) => {
        const src = readFileSync(f, "utf8");
        return [...src.matchAll(new RegExp(STATUS_CALL.source, "g"))]
          .map((m) => src.slice(Math.max(0, m.index! - 40), m.index! + m[0].length))
          .filter((ctx) => !NOT_A_PRODUCT.test(ctx))
          .map((ctx) => `${rel(f)}: ...${ctx.replace(/\s+/g, " ")}`);
      });
    expect(offenders).toEqual([]);
  });
});
