import type { TestProject } from "vitest/node";
import { startStack, type StackInfo } from "./stack";

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

export default async function setup(project: TestProject) {
  // Per payer: $0.10 unknown, $0.20 identified, $0.30 trusted, i.e. 3 / 6 / 9 concurrent $0.033 payments
  // in flight, so cap enforcement (R4) and ERC-8004 tiers are both observable.
  const { info, stop } = await startStack({ perPayerCapUsd: 0.1, identifiedCapUsd: 0.2, trustedCapUsd: 0.3 });
  project.provide("stack", info);
  return stop;
}
