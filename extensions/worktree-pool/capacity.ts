export const MIN_POOL_CAPACITY = 3;
export const MAX_POOL_CAPACITY = 5;
export const POOL_CAPACITY_REQUIREMENT = `must be an integer between ${MIN_POOL_CAPACITY} and ${MAX_POOL_CAPACITY}`;

export function isValidPoolCapacity(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_POOL_CAPACITY &&
    (value as number) <= MAX_POOL_CAPACITY
  );
}
