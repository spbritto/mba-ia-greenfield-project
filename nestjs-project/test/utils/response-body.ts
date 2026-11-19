import type { Response } from 'supertest';

/** Error contract emitted by DomainExceptionFilter / ValidationExceptionFilter. */
export interface ErrorBody {
  statusCode: number;
  error: string;
  message: unknown;
}

/**
 * supertest types `res.body` as `any`; this narrows it to the expected
 * response contract so assertions stay type-safe under typed linting.
 */
export function bodyOf<T>(res: Response): T {
  return res.body as T;
}
