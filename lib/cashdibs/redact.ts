/** Remove secrets/PII from anything that might be logged or returned to a client. */
const SECRET_KEY = /\b[S][A-Z2-7]{55}\b/g;
const SENSITIVE_FIELDS = /^(envelopeXdr|secret|secretKey|token|jwt|authorization|pin|sealedPin|first_name|last_name|email_address|id_number|bank_account_number|phone_number|address)$/i;

export function redact<T>(v: T): T {
  const seen = new WeakSet<object>();
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return x.replace(SECRET_KEY, '[REDACTED_SECRET]');
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      if (seen.has(x as object)) return '[circular]';
      seen.add(x as object);
      return Object.fromEntries(Object.entries(x as object).map(([k, val]) => [k, SENSITIVE_FIELDS.test(k) ? '[REDACTED]' : walk(val)]));
    }
    return x;
  };
  return walk(v) as T;
}

export function safeLog(msg: string, data?: unknown) {
  // eslint-disable-next-line no-console
  console.log(msg, data === undefined ? '' : JSON.stringify(redact(data)));
}
