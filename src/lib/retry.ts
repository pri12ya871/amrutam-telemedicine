import { logger } from './logger.js';

export interface RetryOptions {
  attempts?: number;
  baseMs?: number;
  maxMs?: number;
  /** Only retry what is worth retrying; a 400 will never become a 200. */
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

/**
 * Exponential backoff with **full jitter**: delay = random(0, min(max, base*2^n)).
 *
 * Equal-jitter and no-jitter schedules re-synchronise every client that failed
 * at the same moment, so a downstream recovering from an outage is immediately
 * hit by a thundering herd of retries. Full jitter spreads them out; it is the
 * variant AWS recommends and measurably reduces total client wait.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 3, baseMs = 100, maxMs = 5_000, retryable = () => true, onRetry, signal } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !retryable(err)) break;

      const ceiling = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      onRetry?.(err, attempt, delay);
      logger.warn({ attempt, delay, err: (err as Error)?.message }, 'retrying after failure');
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  halfOpenMax?: number;
  name?: string;
}

/**
 * Circuit breaker for outbound dependencies.
 *
 * Retries alone make an outage worse: every caller keeps hammering a service
 * that is already failing. The breaker converts a slow cascading failure into
 * a fast local one, which is what keeps the p95 promise honest when the
 * payment provider is down.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMax: number;
  readonly name: string;

  constructor(opts: BreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.halfOpenMax = opts.halfOpenMax ?? 1;
    this.name = opts.name ?? 'breaker';
  }

  get currentState(): BreakerState {
    // Lazily transition open -> half_open so no timer has to be held open.
    if (this.state === 'open' && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;

    if (state === 'open') {
      throw new Error(`circuit '${this.name}' is open`);
    }
    if (state === 'half_open') {
      if (this.halfOpenInFlight >= this.halfOpenMax) {
        throw new Error(`circuit '${this.name}' is half-open and saturated`);
      }
      this.halfOpenInFlight++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.halfOpenInFlight = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.halfOpenInFlight = 0;
    // A single failure in half-open means the dependency is still unhealthy.
    if (this.state === 'half_open' || this.failures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      logger.error({ breaker: this.name, failures: this.failures }, 'circuit opened');
    }
  }
}
