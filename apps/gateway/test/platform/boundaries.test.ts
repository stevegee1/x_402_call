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
  it("kernel code reads a product's status only through statusOf (a throwing status() must not 500 a route)", () => {
    const offenders = all
      .filter((f) => !rel(f).startsWith("products/") && rel(f) !== "platform/product-watch.ts")
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\b[\w.]+\.status\(\)/g)].map((m) => `${rel(f)}: ${m[0]}`))
      .filter((hit) => !/\b(c\.res|res|conn|history)\.status\(\)/.test(hit));
    expect(offenders).toEqual([]);
  });
});

