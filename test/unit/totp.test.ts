import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Decode, base32Encode, generateSecret, hotp, otpauthUri, totp, verifyTotp,
} from '../../src/lib/totp.ts';

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    const input = Buffer.from('hello world of telemedicine');
    assert.deepEqual(base32Decode(base32Encode(input)), input);
  });

  it('matches RFC 4648 test vectors', () => {
    assert.equal(base32Encode(Buffer.from('f')), 'MY');
    assert.equal(base32Encode(Buffer.from('fo')), 'MZXQ');
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  });

  it('rejects characters outside the alphabet', () => {
    assert.throws(() => base32Decode('ABC1!'), /invalid base32/);
  });
});

describe('HOTP (RFC 4226 appendix D)', () => {
  // The RFC's shared secret "12345678901234567890" in base32.
  const SECRET = base32Encode(Buffer.from('12345678901234567890'));
  const EXPECTED = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
  ];

  it('reproduces all ten published vectors', () => {
    EXPECTED.forEach((expected, counter) => {
      assert.equal(hotp(SECRET, counter), expected, `counter ${counter}`);
    });
  });
});

describe('TOTP (RFC 6238)', () => {
  const secret = generateSecret();

  it('accepts a freshly generated code', () => {
    assert.equal(verifyTotp(secret, totp(secret)), true);
  });

  it('rejects a code from a different secret', () => {
    assert.equal(verifyTotp(generateSecret(), totp(secret)), false);
  });

  it('accepts the previous window, tolerating clock drift', () => {
    const now = Date.now();
    const previous = totp(secret, now - 30_000);
    assert.equal(verifyTotp(secret, previous, 1, now), true);
  });

  it('rejects a code that is two windows old', () => {
    const now = Date.now();
    const stale = totp(secret, now - 90_000);
    assert.equal(verifyTotp(secret, stale, 1, now), false);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56']) {
      assert.equal(verifyTotp(secret, bad), false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('produces six digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      assert.match(totp(secret, Date.now() + i * 30_000), /^\d{6}$/);
    }
  });
});

describe('otpauth URI', () => {
  it('is a well-formed enrolment URI', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'priya@example.com');
    assert.ok(uri.startsWith('otpauth://totp/Amrutam%3Apriya%40example.com?'));
    assert.ok(uri.includes('secret=JBSWY3DPEHPK3PXP'));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
  });
});
