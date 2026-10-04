import type { IngestIssue } from "../domain/ingest/parse";

export type StorageErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "INSUFFICIENT_STOCK"
  | "UNIT_MISMATCH"
  | "CORRUPT"
  | "MISSING_REGISTRY"
  | "UNRESOLVED_INGREDIENTS";

/** Every storage failure is a typed StorageError so the UI can branch on `code`. */
export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly issues: IngestIssue[] = [],
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
