import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envBoolean } from '../../src/config.ts';

/**
 * Regression test for a real bug.
 *
 * The original schema used z.coerce.boolean(), which applies JavaScript's
 * Boolean() — so the string "false" became true, and every one of
 * DATABASE_SSL=false, OTEL_ENABLED=false and WORKER_ENABLED=false meant the
 * opposite of what it said. It was caught by running the service against a
 * local database and watching it insist on SSL.
 */
describe('envBoolean', () => {
  const parse = (value: unknown, fallback = false) => envBoolean(fallback).parse(value);

  it('reads "false" as false — the bug this replaced got this wrong', () => {
    assert.equal(parse('false', true), false);
  });

  it('accepts the usual truthy spellings', () => {
    for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'on', ' true ']) {
      assert.equal(parse(value), true, `${JSON.stringify(value)} should be true`);
    }
  });

  it('accepts the usual falsy spellings', () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', '', '  ']) {
      assert.equal(parse(value, true), false, `${JSON.stringify(value)} should be false`);
    }
  });

  it('passes real booleans through', () => {
    assert.equal(parse(true), true);
    assert.equal(parse(false, true), false);
  });

  it('applies the default when the variable is unset', () => {
    assert.equal(parse(undefined, true), true);
    assert.equal(parse(undefined, false), false);
  });

  it('rejects a value it cannot interpret rather than guessing', () => {
    // "maybe" is a typo, not a boolean. Failing loudly at boot beats picking
    // an interpretation the operator did not intend.
    assert.throws(() => parse('maybe'));
    assert.throws(() => parse('enabled'));
  });
});
