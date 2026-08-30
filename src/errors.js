export class GbError extends Error {
  constructor(message, exitCode, options = {}) {
    super(message, options);
    this.name = this.constructor.name;
    this.exitCode = exitCode;
  }
}

export class UsageError extends GbError {
  constructor(message) {
    super(message, 2);
  }
}

export class ConfigError extends GbError {
  constructor(message) {
    super(message, 3);
  }
}

export class CapabilityError extends ConfigError {
  constructor(reason, message, hint) {
    super(message);
    this.reason = reason;
    this.hint = hint;
    this.capability = true;
  }
}

export class TransportError extends GbError {
  constructor(message) {
    super(message, 4);
  }
}

export class ApiError extends GbError {
  constructor(message, status) {
    super(message, 5);
    this.status = status;
  }
}

export function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join('<redacted>');
    }
  }
  text = text.replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, 'Authorization: <redacted>');
  text = text.replace(/bearer\s+[^\s,;]+/gi, 'Bearer <redacted>');
  return text;
}
