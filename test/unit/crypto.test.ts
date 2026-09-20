import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, encryptField, decryptField,
  canonicalHash, hashIp, sha256,
} from '../../src/lib/crypto.ts';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  });

  it('never stores the password in the hash', async () => {
    const hash = await hashPassword('hunter2-hunter2-hunter2');
    assert.ok(!hash.includes('hunter2'));
  });

  it('salts: the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password-123'), hashPassword('same-password-123')]);
    assert.notEqual(a, b, 'identical hashes mean the salt is not random');
  });

  it('does not throw on a malformed stored hash', async () => {
    assert.equal(await verifyPassword('x', 'not-a-real-hash'), false);
    assert.equal(await verifyPassword('x', ''), false);
  });
});

describe('envelope encryption', () => {
  it('round-trips a string', () => {
    const enc = encryptField('Patient reports persistent headache');
    assert.equal(decryptField<string>(enc), 'Patient reports persistent headache');
  });

  it('round-trips a structured payload', () => {
    const payload = { diagnosis: 'Migraine', medicines: [{ name: 'Sumatriptan', dosage: '50mg' }] };
    assert.deepEqual(decryptField(encryptField(payload)), payload);
  });

  it('produces no plaintext in the stored ciphertext', () => {
    const enc = encryptField('Type 2 diabetes mellitus');
    assert.ok(!JSON.stringify(enc).includes('diabetes'));
  });

  it('uses a distinct data key per record', () => {
    const a = encryptField('same value');
    const b = encryptField('same value');
    assert.notEqual(a.dek, b.dek);
    assert.notEqual(a.ct, b.ct, 'identical ciphertext would leak equality between records');
  });

  it('tags the key id so rotation can find old records', () => {
    assert.equal(encryptField('x').kid, 'test');
  });

  it('rejects tampered ciphertext rather than returning garbage', () => {
    const enc = encryptField('original value');
    const tampered = { ...enc, ct: Buffer.from('attacker-controlled').toString('base64') };
    assert.throws(() => decryptField(tampered), /unable to authenticate|bad decrypt|unsupported/i);
  });

  it('returns null for an absent value', () => {
    assert.equal(decryptField(null), null);
  });
});

describe('canonicalHash', () => {
  it('is stable regardless of key order', () => {
    assert.equal(
      canonicalHash({ slotId: 'a', mode: 'video' }),
      canonicalHash({ mode: 'video', slotId: 'a' }),
      'key order must not change the idempotency fingerprint',
    );
  });

  it('changes when a value changes', () => {
    assert.notEqual(canonicalHash({ slotId: 'a' }), canonicalHash({ slotId: 'b' }));
  });

  it('handles nested structures', () => {
    assert.equal(
      canonicalHash({ a: { x: 1, y: [1, 2] } }),
      canonicalHash({ a: { y: [1, 2], x: 1 } }),
    );
  });

  it('distinguishes array order, which is semantically meaningful', () => {
    assert.notEqual(canonicalHash({ a: [1, 2] }), canonicalHash({ a: [2, 1] }));
  });
});

describe('ip hashing', () => {
  it('is deterministic for the same address', () => {
    assert.equal(hashIp('203.0.113.7'), hashIp('203.0.113.7'));
  });

  it('does not contain the address', () => {
    assert.ok(!hashIp('203.0.113.7').includes('203'));
  });

  it('differs between addresses', () => {
    assert.notEqual(hashIp('203.0.113.7'), hashIp('203.0.113.8'));
  });
});

describe('sha256', () => {
  it('matches the known digest of the empty string', () => {
    assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
