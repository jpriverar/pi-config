import { MAX_PRIVATE_REPORT_BYTES } from "../task-reconciler/files.js";
import { readMigrationJson } from "../work-catalog/migration-io.js";

export { writePrivateReportJson as writeLifecycleV2MigrationReport } from "../task-reconciler/files.js";

export function readLifecycleV2MigrationReport(path: string): Promise<unknown> {
  return readMigrationJson(path, MAX_PRIVATE_REPORT_BYTES);
}
