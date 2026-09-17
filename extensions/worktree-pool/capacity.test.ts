import { describe, expect, test } from "../../tests/expect.js";

import * as capacity from "./capacity.js";

describe("pool capacity policy", () => {
  test("exports schema-neutral capacity bounds", () => {
    expect(capacity.MIN_POOL_CAPACITY).toBe(3);
    expect(capacity.MAX_POOL_CAPACITY).toBe(5);
    expect(capacity.POOL_CAPACITY_REQUIREMENT).toBe(
      "must be an integer between 3 and 5",
    );
  });

  test.each([
    [3, true],
    [5, true],
    [2, false],
    [6, false],
    [3.5, false],
    ["3", false],
  ])("classifies %p as valid=%p", (value, expected) => {
    expect(capacity.isValidPoolCapacity(value)).toBe(expected);
  });
});
