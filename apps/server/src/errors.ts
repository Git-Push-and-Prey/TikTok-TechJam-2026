export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export class CredentialError extends HttpError {
  constructor(message = "Invalid Agent credential") {
    super(401, message);
    this.name = "CredentialError";
  }
}
