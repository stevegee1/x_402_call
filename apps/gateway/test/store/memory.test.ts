import { MemoryStore } from "../../src/store/memory";
import { describeStoreContract } from "./contract";

describeStoreContract("MemoryStore", async () => {
  const store = new MemoryStore();
  return { store, dispose: () => store.close() };
});
