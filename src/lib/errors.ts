/** An error the API returns as-is: { error: code, message } with the given HTTP status. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = "bad_request") => new HttpError(400, code, message);
export const unauthorized = (message = "Sign in to continue", code = "unauthorized", details?: Record<string, unknown>) =>
  new HttpError(401, code, message, details);
export const forbidden = (message: string, code = "forbidden") => new HttpError(403, code, message);
export const notFound = (message = "Not found") => new HttpError(404, "not_found", message);
export const conflict = (message: string, code = "conflict") => new HttpError(409, code, message);
export const locked = (message: string) => new HttpError(423, "locked", message);
