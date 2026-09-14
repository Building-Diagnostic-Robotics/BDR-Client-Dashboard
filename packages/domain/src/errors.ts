export type DomainErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function authenticationRequired(): never {
  throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication required");
}

export function forbidden(): never {
  throw new DomainError("FORBIDDEN", "Access denied");
}

export function notFound(): never {
  throw new DomainError("NOT_FOUND", "Resource not found");
}

export function conflict(message = "Resource changed; reload and retry"): never {
  throw new DomainError("CONFLICT", message);
}

export function invalidState(message: string): never {
  throw new DomainError("INVALID_STATE", message);
}
