import type { TestProject } from "vitest/node";
import { startStack, type StackInfo } from "./stack";

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

export default async function setup(project: TestProject) {
  // Per payer: $0.11 unknown, $0.22 identified, $0.33 trusted, i.e. 3 / 6 / 9 concurrent $0.035 payments
  // in flight, so cap enforcement (R4) and ERC-8004 tiers are both observable.
  const { info, stop } = await startStack({ perPayerCapUsd: 0.11, identifiedCapUsd: 0.22, trustedCapUsd: 0.33 });
  project.provide("stack", info);
  return stop;
}
