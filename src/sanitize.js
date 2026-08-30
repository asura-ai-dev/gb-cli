const SENSITIVE_KEY = /(token|authorization|cookie|secret|credential|password)/i;

function unicodeEscape(character) {
  return `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`;
}

export function escapeTerminalControls(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === '\t') return '\\t';
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\u001b') return '\\x1b';
    return unicodeEscape(character);
  });
}

export function escapeJsonTerminalControls(serialized) {
  return String(serialized).replace(/[\u007f-\u009f]/g, unicodeEscape);
}

function redactKnown(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) result = result.split(secret).join('<redacted>');
  }
  return result;
}

export function sanitize(value, seen = new WeakSet(), secrets = []) {
  if (typeof value === 'string') return redactKnown(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen, secrets));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const containsKnownSecret = secrets.some((secret) => typeof secret === 'string' && secret.length > 0 && key.includes(secret));
    if (!SENSITIVE_KEY.test(key) && !containsKnownSecret) output[key] = sanitize(item, seen, secrets);
  }
  return output;
}

export function sanitizeHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  if (typeof value.ok === 'boolean') clean.ok = value.ok;
  if (typeof value.isBusy === 'boolean') clean.isBusy = value.isBusy;
  if (typeof value.busyOnlyAwaitingApproval === 'boolean') {
    clean.busyOnlyAwaitingApproval = value.busyOnlyAwaitingApproval;
  }
  if (typeof value.startedAt === 'string' && value.startedAt.length > 0 && Number.isFinite(Date.parse(value.startedAt))) {
    clean.startedAt = value.startedAt;
  }
  if (Number.isFinite(value.lastBusyAtMs)) clean.lastBusyAtMs = value.lastBusyAtMs;
  return clean;
}
