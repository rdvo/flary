export class FlaryHostError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "FlaryHostError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function featureUnavailable(feature: string): FlaryHostError {
  return new FlaryHostError(
    501,
    "feature_not_configured",
    `${feature} is not configured for this Flary host`,
  );
}
