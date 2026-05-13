// Standard error shapes (invariant #10).
//
// Every error response has shape: { status, error, code, error_details? }.

export type ErrorDetails = Record<string, string[]>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errorDetails?: ErrorDetails;
  readonly httpError: string;

  constructor(status: number, code: string, options: {
    httpError?: string;
    message?: string;
    errorDetails?: ErrorDetails;
  } = {}) {
    super(options.message ?? code);
    this.status = status;
    this.code = code;
    this.httpError = options.httpError ?? statusToError(status);
    this.errorDetails = options.errorDetails;
  }
}

function statusToError(status: number): string {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 422: return 'Unprocessable Entity';
    case 500: return 'Internal Server Error';
    default: return 'Error';
  }
}

export function notFound(resource: string): ApiError {
  return new ApiError(404, `${resource}_not_found`);
}

export function pathNotFound(): ApiError {
  return new ApiError(404, 'resource_not_found');
}

export function validation(details: ErrorDetails, message?: string): ApiError {
  return new ApiError(422, 'validation_errors', { errorDetails: details, message });
}

export function conflict(code: string, details?: ErrorDetails): ApiError {
  return new ApiError(409, code, { errorDetails: details });
}

export function forbidden(code: string): ApiError {
  return new ApiError(403, code);
}

export function unauthorized(code: string): ApiError {
  return new ApiError(401, code);
}

export function serializeError(err: ApiError): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status: err.status,
    error: err.httpError,
    code: err.code,
  };
  if (err.errorDetails) {
    body.error_details = err.errorDetails;
  }
  return body;
}
