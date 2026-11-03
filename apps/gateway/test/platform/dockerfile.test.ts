import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("Dockerfile", () => {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");

  it("copies the manifest of every deployable workspace package before installing", () => {
    // packages/* and apps/* ship in the image; e2e is test-only and excluded by .dockerignore.
    const dirs = ["packages", "apps"].flatMap((g) => readdirSync(join(ROOT, g)).map((d) => `${g}/${d}`)).filter((d) => existsSync(join(ROOT, d, "package.json")));
    const missing = dirs.filter((d) => !dockerfile.includes(`COPY ${d}/package.json ${d}/`));
    expect(missing).toEqual([]);
  });

  it("pins the base image by digest", () => {
    expect(dockerfile).toMatch(/^FROM node:\d+\.\d+\.\d+-alpine[\d.]*@sha256:[0-9a-f]{64}$/m);
  });
});
