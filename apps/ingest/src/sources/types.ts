import type { AisEvent } from "@mx/shared";

export interface Source {
  name: string;
  start(emit: (e: AisEvent) => void): void;
  stop(): Promise<void>;
  stats(): Record<string, number>;
}
