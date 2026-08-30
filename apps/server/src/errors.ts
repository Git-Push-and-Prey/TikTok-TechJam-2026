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

/**
 * Enforces per-owner access to a resource. `requestedOwnerId === undefined`
 * means "internal/trusted call, skip the check". Always 404 (never 403) so a
 * resource's existence isn't leaked to a non-owner.
 */
export function assertOwned(
  resourceOwnerId: string | null,
  requestedOwnerId: string | null | undefined,
  notFoundMessage: string,
): void {
  if (requestedOwnerId !== undefined && resourceOwnerId !== requestedOwnerId) {
    throw new HttpError(404, notFoundMessage);
  }
}
