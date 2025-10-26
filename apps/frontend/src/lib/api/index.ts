/**
 * API Error with HTTP status metadata
 */
export class APIError extends Error {
  public status: number;
  public statusText: string;
  public details: unknown;
  public data: unknown;

  constructor(
    message: string,
    status: number = 500,
    statusText: string = 'Internal Server Error',
    details?: unknown
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.statusText = statusText;
    this.details = details;
    this.data = details;
  }
}
