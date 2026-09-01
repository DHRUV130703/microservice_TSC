/**
 * Decoding for JSON configuration supplied through an environment variable.
 *
 * Dashboards and shells mangle long values in predictable ways: the whole
 * `VAR=value` line gets pasted into the value box, editors wrap base64 across
 * lines, values arrive quoted, or a url-safe alphabet is used. Each of those
 * produced an unreadable "Unexpected token '�'" failure, which tells an
 * operator nothing about what to fix. This normalises the common cases and,
 * when it still cannot decode, explains what was actually received.
 */
export interface DecodeResult {
  json: string;
  /** How the value was interpreted, for logging. */
  encoding: 'raw' | 'base64';
}

export class InlineJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InlineJsonError';
  }
}

/** Describes a value without revealing it — safe for logs and error responses. */
function describe(value: string): string {
  const compact = value.replace(/\s+/g, '');
  const looksBase64 = /^[A-Za-z0-9+/_-]*={0,2}$/.test(compact) && compact.length > 0;
  return (
    `${value.length} characters` +
    (value.length !== compact.length ? ` (${compact.length} ignoring whitespace)` : '') +
    `, ${looksBase64 ? 'base64-like' : 'not valid base64'}`
  );
}

export function decodeInlineJson(rawValue: string, varName: string): DecodeResult {
  let value = rawValue.trim();

  // The whole `VAR=...` line pasted into the value box.
  const prefixed = new RegExp(`^${varName}\\s*=\\s*`);
  if (prefixed.test(value)) value = value.replace(prefixed, '').trim();

  // Surrounding quotes, as shells and some dashboards add.
  if (value.length > 1) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }

  if (value.length === 0) {
    throw new InlineJsonError(`${varName} is empty after trimming.`);
  }

  // Raw JSON.
  if (value.startsWith('{')) {
    return { json: value, encoding: 'raw' };
  }

  // Base64, tolerating wrapping whitespace and the url-safe alphabet.
  const compact = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(compact, 'base64').toString('utf8');

  if (decoded.trimStart().startsWith('{')) {
    return { json: decoded.trim(), encoding: 'base64' };
  }

  throw new InlineJsonError(
    `${varName} could not be read as JSON. Received ${describe(rawValue)}; ` +
      `base64-decoding it did not produce JSON either. Common causes: the value box ` +
      `contains the whole "${varName}=..." line instead of just the value; the value was ` +
      `truncated on paste; or it is double-encoded. Re-copy it as a single unbroken line ` +
      `with no variable name and no surrounding quotes.`,
  );
}
