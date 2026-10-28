import type { LifecycleMetadata, LifecycleMetadataV1 } from "./types.js";

export function legacyLifecycle(value: LifecycleMetadata): LifecycleMetadataV1;
export function legacyLifecycle(
  value: LifecycleMetadata | null,
): LifecycleMetadataV1 | null;
export function legacyLifecycle(
  value: LifecycleMetadata | null | undefined,
): LifecycleMetadataV1 | null | undefined;
export function legacyLifecycle(
  value: LifecycleMetadata | null | undefined,
): LifecycleMetadataV1 | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (value.version !== 1) throw new Error("expected a v1 lifecycle fixture");
  return value;
}
