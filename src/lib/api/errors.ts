// docs/MCP.md §4 — how the MCP endpoint and its byte routes refuse.
//
// An operation throws an `ApiError`; the MCP layer turns it into a tool
// result with `isError` and a body of `{ code, message, … }`, and a byte route
// into the HTTP status that fits. Anything else thrown is a fault, logged and
// answered as `internal` with no detail.
//
// **An object the actor may not read is `not_found`**, the same as one that
// does not exist, so a token can't probe for PRIVATE titles. `forbidden` is
// for an object the actor *can* read and may not change.

export type ApiErrorCode =
  | "invalid"
  | "unknown_author"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "ambiguous"
  | "no_match"
  | "read_only"
  | "already_done"
  | "too_large"
  | "rate_limited"
  | "unavailable"
  | "internal";

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  body(): Record<string, unknown> {
    return { code: this.code, message: this.message, ...this.details };
  }
}

export function invalid(message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError("invalid", message, details);
}

export function notFound(what = "That"): ApiError {
  return new ApiError("not_found", `${what} doesn't exist, or isn't yours to read.`);
}

export function forbidden(message: string): ApiError {
  return new ApiError("forbidden", message);
}

const HTTP_STATUS: Record<ApiErrorCode, number> = {
  invalid: 400,
  unknown_author: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  ambiguous: 409,
  no_match: 422,
  read_only: 409,
  already_done: 409,
  too_large: 413,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** The status a byte route answers an `ApiError` with. */
export function httpStatusOf(error: ApiError): number {
  return HTTP_STATUS[error.code];
}

/** At most this many entries in any list inside an error (§4: every list is capped). */
export const ERROR_LIST_CAP = 5;
