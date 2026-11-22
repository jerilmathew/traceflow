import type { ApiErrorBody } from '@traceflow/shared';

/** Every non-2xx API response uses the same `{ error: { code, message, details? } }` shape. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
