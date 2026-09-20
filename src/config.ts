import 'dotenv/config';
import { z } from 'zod';

/**
 * All environment access happens here and nowhere else. Reading process.env
 * from inside modules makes configuration untestable and lets a typo become a
 * runtime `undefined` deep in a request; this fails loudly at boot instead.
 */
/**
 * Boolean from an environment variable.
 *
 * NOT z.coerce.boolean(), which applies JavaScript's Boolean() and therefore
 * reads the string "false" as true — every non-empty string is truthy. That
 * silently inverts the meaning of `OTEL_ENABLED=false`, which is exactly the
 * kind of configuration bug that only shows up in production.
 */
export const envBoolean = (defaultValue: boolean) =>
  z
    .preprocess((value) => {
      if (typeof value !== 'string') return value;
      const normalised = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'off', ''].includes(normalised)) return false;
      return value; // anything else fails validation loudly rather than guessing
    }, z.boolean())
    .default(defaultValue);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // 'silent' is pino's off switch; tests use it so assertion output is readable.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: envBoolean(false),

  REDIS_URL: z.string().optional(),

  // Secrets. In production these come from the platform's secret store; the
  // length floor exists so a placeholder cannot reach production by accident.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Master key for envelope encryption of PII/PHI. 32 bytes, base64.
  // See docs/security-checklist.md for the rotation procedure.
  DATA_MASTER_KEY: z.string().min(32, 'DATA_MASTER_KEY must be a 32-byte base64 key'),
  DATA_KEY_ID: z.string().default('k1'),

  // Salt for one-way hashing of IP addresses. Raw IPs are never stored.
  IP_HASH_SALT: z.string().min(16, 'IP_HASH_SALT must be at least 16 chars'),

  SLOT_HOLD_MINUTES: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),

  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  OTEL_ENABLED: envBoolean(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
  OTEL_SERVICE_NAME: z.string().default('amrutam-telemedicine'),

  WORKER_ENABLED: envBoolean(true),
});

export type Config = Readonly<z.infer<typeof EnvSchema>> & {
  readonly corsOrigins: readonly string[];
  readonly isProduction: boolean;
};

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Deliberately not the logger: this runs before the logger is configured.
    console.error(`Invalid configuration:\n${issues}\n\nSee .env.example.`);
    process.exit(1);
  }

  const env = parsed.data;
  return Object.freeze({
    ...env,
    corsOrigins: Object.freeze(
      env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
    ),
    isProduction: env.NODE_ENV === 'production',
  });
}

export const config: Config = load();
