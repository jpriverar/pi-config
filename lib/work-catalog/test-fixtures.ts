import { target } from "../work-management/test-fixtures.js";
import type { WorkCatalog } from "./model.js";

export const A = "11111111-1111-4111-8111-111111111111";
export const B = "22222222-2222-4222-8222-222222222222";
export const P = "33333333-3333-4333-8333-333333333333";
export const Q = "44444444-4444-4444-8444-444444444444";
export const NEW = "55555555-5555-4555-8555-555555555555";
export function catalogFixture(): WorkCatalog {
  return {
    version: 1,
    revision: 0,
    state: "active",
    areas: {
      [A]: {
        id: A,
        name: "Product",
        description: "Product development and operations.",
        archived: false,
        publication: { mode: "datadog", target: structuredClone(target) },
      },
      [B]: {
        id: B,
        name: "Tooling",
        description: "Personal development tools.",
        archived: false,
        publication: { mode: "local" },
      },
    },
    projects: {
      [P]: {
        id: P,
        name: "API",
        description: "API consistency.",
        areaId: A,
        archived: false,
        workstreamKey: "api",
        aliases: [],
      },
      [Q]: {
        id: Q,
        name: "Maintenance",
        description: "Small product fixes.",
        areaId: A,
        archived: false,
        workstreamKey: "maintenance",
        aliases: [],
      },
    },
  };
}
