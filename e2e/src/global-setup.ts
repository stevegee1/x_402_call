import type { TestProject } from "vitest/node";
import { startStack, type StackInfo } from "./stack";

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

export default async function setup(project: TestProject) {
  // $0.10 per payer: three $0.033 payments may be in flight, so cap enforcement is observable (R4).
  const { info, stop } = await startStack({ perPayerCapUsd: 0.1 });
  project.provide("stack", info);
  return stop;
}
