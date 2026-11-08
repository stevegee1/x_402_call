import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CURRENT, hashPassword, passwordProblem, verifyPassword } from "../../src/customers/passwords";

describe("password hashing", () => {
  it("verifies the right password and rejects any other", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(new RegExp(`^scrypt\\$${CURRENT.logN}\\$${CURRENT.r}\\$${CURRENT.p}\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{43}$`));
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("correct horse batterY", h)).toBe(false);
    expect(await verifyPassword("", h)).toBe(false);
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same password here"), hashPassword("same password here")]);
    expect(a).not.toBe(b);
  });

  it("treats Unicode-equivalent spellings as the same password (NFKC)", async () => {
    const h = await hashPassword("café au lait please");
    expect(await verifyPassword("café au lait please", h)).toBe(true);
  });

  it("never verifies a malformed or out-of-range stored hash", async () => {
    const h = await hashPassword("a perfectly fine password");
    for (const bad of ["", "plain", h.replace("scrypt$", "bcrypt$"), h.replace(/\$14\$/, "$30$"), h.replace(/\$[^$]+$/, "$AAAA"), h.slice(0, -1)]) {
      expect(await verifyPassword("a perfectly fine password", bad)).toBe(false);
    }
  });

  it("still verifies hashes made with older parameters, so a parameter bump can't lock users out", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("rotate me later please", salt, 32, { N: 2 ** 12, r: 8, p: 1 });
    const old = ["scrypt", "12", "8", "1", salt.toString("base64url"), key.toString("base64url")].join("$");
    expect(await verifyPassword("rotate me later please", old)).toBe(true);
    expect(await verifyPassword("rotate me later pleas", old)).toBe(false);
  });

  it("asks for length only: 12 to 128 characters, counted as characters not bytes", () => {
    expect(passwordProblem("short")).toMatch(/at least 12/);
    expect(passwordProblem("x".repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem("twelve chars")).toBeNull();
    expect(passwordProblem("ééééééééééé")).toMatch(/at least 12/); // 11 characters, 22 bytes
    expect(passwordProblem(undefined)).toMatch(/Enter a password/);
    expect(passwordProblem(12345678901234)).toMatch(/Enter a password/);
  });
});
