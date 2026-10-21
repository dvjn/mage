// A request the service refuses, with the HTTP status, the message to show and, for a refusal a
// page explains in its own words, a reason it can tell apart.

export class ServiceError extends Error {
  readonly status: 400 | 403 | 404 | 409 | 410;
  readonly reason?: string;

  constructor(status: ServiceError["status"], message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}
