import { describe, expect, it } from 'vitest';
import { decodeInlineJson, InlineJsonError } from '../src/config/inline-json.js';

/**
 * Regression suite for how long JSON values survive a trip through a hosting
 * dashboard. A real Vercel deployment failed because the value box contained
 * the whole `SCHEMA_MAPPING_JSON=...` line, which base64-decoded to binary and
 * produced "Unexpected token '�'" — an error that named neither the cause
 * nor the fix.
 */
const payload = { meta: { project: 'p' }, nested: { list: [1, 2, 3], text: 'hello world' } };
const raw = JSON.stringify(payload);
const b64 = Buffer.from(raw).toString('base64');
const decode = (v: string) => JSON.parse(decodeInlineJson(v, 'MY_VAR').json);

describe('decodeInlineJson — accepted forms', () => {
  it('reads raw JSON', () => {
    expect(decode(raw)).toEqual(payload);
    expect(decodeInlineJson(raw, 'MY_VAR').encoding).toBe('raw');
  });

  it('reads standard base64', () => {
    expect(decode(b64)).toEqual(payload);
    expect(decodeInlineJson(b64, 'MY_VAR').encoding).toBe('base64');
  });

  it('strips an accidentally included VAR= prefix (the real Vercel failure)', () => {
    expect(decode(`MY_VAR=${b64}`)).toEqual(payload);
    expect(decode(`MY_VAR = ${b64}`)).toEqual(payload);
  });

  it('strips a VAR= prefix in front of raw JSON too', () => {
    expect(decode(`MY_VAR=${raw}`)).toEqual(payload);
  });

  it('strips surrounding quotes', () => {
    expect(decode(`"${b64}"`)).toEqual(payload);
    expect(decode(`'${b64}'`)).toEqual(payload);
    expect(decode(`"${raw}"`)).toEqual(payload);
  });

  it('tolerates base64 wrapped across lines or broken by spaces', () => {
    expect(decode(b64.match(/.{1,8}/g)!.join('\n'))).toEqual(payload);
    expect(decode(b64.match(/.{1,8}/g)!.join(' '))).toEqual(payload);
  });

  it('accepts the url-safe base64 alphabet', () => {
    expect(decode(b64.replace(/\+/g, '-').replace(/\//g, '_'))).toEqual(payload);
  });

  it('ignores leading and trailing whitespace', () => {
    expect(decode(`\n\t  ${b64}  \n`)).toEqual(payload);
  });

  it('handles a value that is both prefixed and quoted', () => {
    expect(decode(`MY_VAR="${b64}"`)).toEqual(payload);
  });
});

describe('decodeInlineJson — rejected, with an actionable message', () => {
  it('rejects an empty value', () => {
    expect(() => decodeInlineJson('   ', 'MY_VAR')).toThrow(InlineJsonError);
    expect(() => decodeInlineJson('   ', 'MY_VAR')).toThrow(/empty/);
  });

  it('rejects a double-encoded value and names the variable', () => {
    const doubled = Buffer.from(b64).toString('base64');
    expect(() => decodeInlineJson(doubled, 'MY_VAR')).toThrow(/MY_VAR could not be read as JSON/);
    expect(() => decodeInlineJson(doubled, 'MY_VAR')).toThrow(/double-encoded/);
  });

  it('rejects plain garbage', () => {
    expect(() => decodeInlineJson('this is not json or base64 !!!', 'MY_VAR')).toThrow(InlineJsonError);
  });

  it('reports the size so truncation is visible, without echoing the value', () => {
    const secret = Buffer.from('{"private_key":"SUPERSECRET"}').toString('base64');
    // Double-encode so it fails, then confirm the message stays quiet about content.
    const doubled = Buffer.from(secret).toString('base64');
    let message = '';
    try {
      decodeInlineJson(doubled, 'GOOGLE_CREDENTIALS_JSON');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/\d+ characters/);
    expect(message).not.toContain('SUPERSECRET');
    expect(message).not.toContain(doubled);
  });
});
