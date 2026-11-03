import type { TestProject } from "vitest/node";
import { startStack, type StackInfo } from "./stack";

declare module "vitest" {
  export interface ProvidedContext {
    stack: StackInfo;
  }
}

export default async function setup(project: TestProject) {
  const { info, stop } = await startStack();
  project.provide("stack", info);
  return stop;
}
