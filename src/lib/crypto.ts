import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-recommended scrypt parameters (N=2^16, r=8, p=1). scrypt is used
// rather than argon2id purely because it ships in Node's standard library:
// no native build step, so the same code runs on a developer laptop, in CI and
// in the container without a toolchain. Both are memory-hard and acceptable.
const SCRYPT = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * (1 << 16) * 8 * 2 };
const KEYLEN = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(plain, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  // Constant-time: a length-dependent early return would leak hash length.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ------------------------------------------------------------- envelope crypto

export interface EncryptedValue {
  v: 1;
  kid: string;   // master key id, so rotation can decrypt old rows
  dek: string;   // data key, wrapped with the master key
  iv: string;
  ct: string;
  tag: string;
}

const masterKey = (): Buffer => {
  const key = Buffer.from(config.DATA_MASTER_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('DATA_MASTER_KEY must decode to exactly 32 bytes');
  }
  return key;
};

function aesEncrypt(key: Buffer, plaintext: Buffer): { iv: string; ct: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function aesDecrypt(key: Buffer, iv: string, ct: string, tag: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]);
}

/**
 * Envelope-encrypt a value for storage.
 *
 * Each record gets its own random data key (DEK), which is itself encrypted
 * with the master key. Two consequences that matter:
 *   - rotating the master key rewraps DEKs, it does not re-encrypt every row;
 *   - deleting a single record's DEK renders that record unrecoverable, which
 *     is how erasure requests are satisfied on backups we cannot rewrite.
 */
export function encryptField(value: unknown): EncryptedValue {
  const dek = randomBytes(32);
  const { iv, ct, tag } = aesEncrypt(dek, Buffer.from(JSON.stringify(value), 'utf8'));
  const wrapped = aesEncrypt(masterKey(), dek);
  return {
    v: 1,
    kid: config.DATA_KEY_ID,
    dek: `${wrapped.iv}.${wrapped.ct}.${wrapped.tag}`,
    iv,
    ct,
    tag,
  };
}

export function decryptField<T = unknown>(enc: EncryptedValue | null | undefined): T | null {
  if (!enc) return null;
  const [wIv, wCt, wTag] = enc.dek.split('.');
  if (!wIv || !wCt || !wTag) throw new Error('malformed wrapped data key');
  const dek = aesDecrypt(masterKey(), wIv, wCt, wTag);
  return JSON.parse(aesDecrypt(dek, enc.iv, enc.ct, enc.tag).toString('utf8')) as T;
}

// ------------------------------------------------------------------- hashing

/** Opaque tokens are stored hashed, so a database leak is not a session leak. */
export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * IP addresses are personal data under the DPDP Act. Rate limiting and abuse
 * investigation only need a stable identifier, so store a salted hash.
 */
export const hashIp = (ip: string): string =>
  createHmac('sha256', config.IP_HASH_SALT).update(ip).digest('hex').slice(0, 32);

export const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const newId = (): string => randomUUID();

/** Stable hash of a request body, for detecting Idempotency-Key reuse. */
export function canonicalHash(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)]),
      );
    }
    return v;
  };
  return sha256(JSON.stringify(canonical(value) ?? null));
}
