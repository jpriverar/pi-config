import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  beforeEach,
  describe,
  it,
  test as nodeTest,
} from "node:test";
import { inspect, isDeepStrictEqual } from "node:util";

export { after, afterEach, before, beforeEach, describe, it };
export { after as afterAll, before as beforeAll };

type TestCallback = (...args: any[]) => any;

type CompatibleTest = {
  (name: string, callback: TestCallback, timeout?: number): unknown;
  each(
    cases: readonly unknown[],
  ): (name: string, callback: TestCallback, timeout?: number) => void;
};

function formatCaseName(template: string, values: readonly unknown[]): string {
  let index = 0;
  return template.replace(/%[psdifjo]/g, () => inspect(values[index++]));
}

export const test: CompatibleTest = Object.assign(
  (name: string, callback: TestCallback, timeout?: number) =>
    nodeTest(name, timeout === undefined ? {} : { timeout }, callback),
  {
    each(cases: readonly unknown[]) {
      return (name: string, callback: TestCallback, timeout?: number) => {
        for (const value of cases) {
          const values = Array.isArray(value) ? value : [value];
          test(
            formatCaseName(name, values),
            () => callback(...values),
            timeout,
          );
        }
      };
    },
  },
);

type AsymmetricMatcher = {
  asymmetricMatch(value: unknown): boolean;
};

function isAsymmetric(value: unknown): value is AsymmetricMatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "asymmetricMatch" in value &&
    typeof (value as AsymmetricMatcher).asymmetricMatch === "function"
  );
}

function matches(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matches(actual[index], value))
    );
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null
  ) {
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every((key) =>
        matches(
          (actual as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
        ),
      )
    );
  }
  return isDeepStrictEqual(actual, expected);
}

function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((value, index) => matchesSubset(actual[index], value))
    );
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null) return false;
    return Object.keys(expected).every((key) =>
      matchesSubset(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      ),
    );
  }
  return isDeepStrictEqual(actual, expected);
}

function thrownMatches(error: unknown, expected?: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "string") {
    return error instanceof Error && error.message.includes(expected);
  }
  if (expected instanceof RegExp) {
    return error instanceof Error && expected.test(error.message);
  }
  if (typeof expected === "function") return error instanceof expected;
  return matches(error, expected);
}

function propertyAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null || !(part in current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[part];
  }, value);
}

function matcherSet(actual: unknown, negated = false): any {
  const verify = (pass: boolean, message: string) => {
    if (negated ? pass : !pass) {
      throw new assert.AssertionError({
        message: negated ? `not: ${message}` : message,
        actual,
      });
    }
  };

  return {
    get not() {
      return matcherSet(actual, !negated);
    },
    get resolves() {
      return promiseMatcher(actual, "resolves", negated);
    },
    get rejects() {
      return promiseMatcher(actual, "rejects", negated);
    },
    toBe(expected: unknown) {
      verify(Object.is(actual, expected), "expected values to be identical");
    },
    toEqual(expected: unknown) {
      verify(matches(actual, expected), "expected values to be deeply equal");
    },
    toMatchObject(expected: unknown) {
      verify(
        matchesSubset(actual, expected),
        "expected object to contain subset",
      );
    },
    toHaveLength(expected: number) {
      const length =
        typeof actual === "string" || Array.isArray(actual)
          ? actual.length
          : (actual as { length?: unknown } | null)?.length;
      verify(length === expected, `expected length ${expected}`);
    },
    toContain(expected: unknown) {
      const pass =
        typeof actual === "string" && typeof expected === "string"
          ? actual.includes(expected)
          : Array.isArray(actual) && actual.includes(expected);
      verify(pass, "expected value to contain item");
    },
    toContainEqual(expected: unknown) {
      verify(
        Array.isArray(actual) &&
          actual.some((value) => matches(value, expected)),
        "expected array to contain deeply equal item",
      );
    },
    toBeUndefined() {
      verify(actual === undefined, "expected value to be undefined");
    },
    toBeInstanceOf(expected: Function) {
      verify(actual instanceof expected, "expected value to be an instance");
    },
    toMatch(expected: RegExp | string) {
      const pass =
        typeof actual === "string" &&
        (typeof expected === "string"
          ? actual.includes(expected)
          : expected.test(actual));
      verify(pass, "expected string to match");
    },
    toHaveProperty(path: string, expected?: unknown) {
      const value = propertyAt(actual, path);
      const pass =
        value !== undefined &&
        (arguments.length === 1 || matches(value, expected));
      verify(pass, `expected object to have property ${path}`);
    },
    toThrow(expected?: unknown) {
      if (typeof actual !== "function") {
        verify(false, "expected value to be callable");
        return;
      }
      let thrown: unknown;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }
      verify(
        thrown !== undefined && thrownMatches(thrown, expected),
        "expected function to throw the requested error",
      );
    },
  };
}

function promiseMatcher(
  actual: unknown,
  mode: "resolves" | "rejects",
  negated: boolean,
): any {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "not") return promiseMatcher(actual, mode, !negated);
        return async (...args: unknown[]) => {
          const outcome = await Promise.resolve(actual).then(
            (value) => ({ resolved: true, value }),
            (value: unknown) => ({ resolved: false, value }),
          );
          const matchedMode =
            mode === "resolves" ? outcome.resolved : !outcome.resolved;
          if (!matchedMode) {
            throw new assert.AssertionError({
              message: `expected promise to ${mode}`,
              actual: outcome.value,
            });
          }
          if (mode === "rejects" && property === "toThrow") {
            const pass = thrownMatches(outcome.value, args[0]);
            if (negated ? pass : !pass) {
              throw new assert.AssertionError({
                message: "rejection did not match the requested error",
                actual: outcome.value,
              });
            }
            return;
          }
          const matcher = matcherSet(outcome.value, negated)[property];
          if (typeof matcher !== "function") {
            throw new TypeError(
              `unsupported async matcher ${String(property)}`,
            );
          }
          return matcher(...args);
        };
      },
    },
  );
}

export const expect = Object.assign((actual: unknown) => matcherSet(actual), {
  stringContaining(expected: string): AsymmetricMatcher {
    return {
      asymmetricMatch(value) {
        return typeof value === "string" && value.includes(expected);
      },
    };
  },
  objectContaining(expected: Record<string, unknown>): AsymmetricMatcher {
    return {
      asymmetricMatch(value) {
        return matchesSubset(value, expected);
      },
    };
  },
  arrayContaining(expected: unknown[]): AsymmetricMatcher {
    return {
      asymmetricMatch(value) {
        return (
          Array.isArray(value) &&
          expected.every((item) =>
            value.some((actual) => matches(actual, item)),
          )
        );
      },
    };
  },
});
