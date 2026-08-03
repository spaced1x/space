export class SpaceError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SpaceError";
    this.code = code;
    this.details = details;
  }
}

export class ConfigError extends SpaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_INVALID", message, details);
    this.name = "ConfigError";
  }
}

export class DatabaseUnavailableError extends SpaceError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("DATABASE_UNAVAILABLE", message, details);
    this.name = "DatabaseUnavailableError";
  }
}