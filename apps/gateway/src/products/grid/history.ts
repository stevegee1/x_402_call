import { EnvHistory } from "@mx/env";
import type { Country } from "./source";

/**
 * Grid's point-in-time reads: the version store's generic reader, narrowed to Grid's countries.
 * The reader lives in @mx/env so every product on the version store shares one implementation.
 */
export class GridHistory extends EnvHistory<Country> {}
export { GATEWAY_ENV_POOL, STORE_READ_DEADLINE_MS, StoreReadTimeout, type HistoryStore, type ReadPath } from "@mx/env";
