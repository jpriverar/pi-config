import { isDeepStrictEqual } from "node:util";
import type { BeadsClient } from "../beads.js";
import {
  decodeWorkCatalog,
  encodeWorkCatalog,
  type WorkCatalog,
} from "./model.js";

export interface CatalogStore {
  read(): Promise<WorkCatalog | null>;
  write(catalog: WorkCatalog): Promise<void>;
}

export function createCatalogStore(
  client: Pick<BeadsClient, "getWorkCatalog" | "setWorkCatalog">,
): CatalogStore {
  async function read(): Promise<WorkCatalog | null> {
    const result = await client.getWorkCatalog();
    if (!result.ok)
      throw new Error(
        `Work catalog unavailable in ${result.error.store}: ${result.error.message}`,
      );
    return result.value;
  }
  return {
    read,
    async write(catalog) {
      const expected = decodeWorkCatalog(encodeWorkCatalog(catalog))!;
      const result = await client.setWorkCatalog(expected);
      if (!result.ok)
        throw new Error(
          `Work catalog write at revision ${expected.revision} could not be confirmed; read back before retrying`,
        );
      const actual = await read();
      if (!isDeepStrictEqual(actual, expected)) {
        throw new Error(
          `Work catalog revision ${expected.revision} read-back did not match; inspect before retrying`,
        );
      }
    },
  };
}
