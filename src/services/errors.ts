// A request the service refuses, with the HTTP status and the message to show.

export class ServiceError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(status: ServiceError["status"], message: string) {
    super(message);
    this.status = status;
  }
}
