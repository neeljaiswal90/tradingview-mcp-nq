export interface AppError {
  code: string;
  message: string;
  hint?: string;
  details?: unknown;
}

export type Result<T> =
  | { success: true; data: T }
  | { success: false; error: AppError };

export function ok<T>(data: T): Result<T> {
  return { success: true, data };
}

export function fail<T = never>(code: string, message: string, hint?: string, details?: unknown): Result<T> {
  return { success: false, error: { code, message, hint, details } };
}

export function unwrap<T>(result: Result<T>): T {
  if (result.success) return result.data;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}

export function isOk<T>(result: Result<T>): result is { success: true; data: T } {
  return result.success;
}

export function isFail<T>(result: Result<T>): result is { success: false; error: AppError } {
  return !result.success;
}
