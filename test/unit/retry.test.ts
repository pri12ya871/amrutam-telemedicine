import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, withRetry } from '../../src/lib/retry.ts';

describe('withRetry', () => {
  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries until it succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      { baseMs: 1 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('always down');
        },
        { attempts: 4, baseMs: 1 },
      ),
      /always down/,
    );
    assert.equal(calls, 4);
  });

  it('does not retry an error classified as terminal', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('card_declined');
        },
        { attempts: 5, baseMs: 1, retryable: (e) => (e as Error).message !== 'card_declined' },
      ),
      /card_declined/,
    );
    assert.equal(calls, 1, 'a declined card must not be retried');
  });

  it('keeps every delay inside the full-jitter ceiling', async () => {
    const delays: number[] = [];
    await assert.rejects(
      withRetry(
        async () => {
          throw new Error('fail');
        },
        { attempts: 5, baseMs: 10, maxMs: 80, onRetry: (_e, _a, d) => delays.push(d) },
      ),
    );
    // Full jitter: delay is uniform in [0, min(maxMs, baseMs * 2^(n-1))).
    const ceilings = [10, 20, 40, 80];
    delays.forEach((delay, i) => {
      assert.ok(delay >= 0 && delay < ceilings[i]!, `delay ${delay} outside [0, ${ceilings[i]})`);
    });
  });
});

describe('CircuitBreaker', () => {
  it('passes calls through while closed', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    assert.equal(await breaker.execute(async () => 42), 42);
    assert.equal(breaker.currentState, 'closed');
  });

  it('opens once the failure threshold is reached', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, name: 'test' });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(breaker.execute(async () => {
        throw new Error('downstream down');
      }));
    }
    assert.equal(breaker.currentState, 'open');
  });

  it('fails fast while open, without calling the dependency', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
    await assert.rejects(breaker.execute(async () => {
      throw new Error('boom');
    }));

    let called = false;
    await assert.rejects(
      breaker.execute(async () => {
        called = true;
        return 'never';
      }),
      /is open/,
    );
    assert.equal(called, false, 'an open circuit must not reach the dependency');
  });

  it('moves to half-open after the reset timeout and closes on success', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    await assert.rejects(breaker.execute(async () => {
      throw new Error('boom');
    }));
    assert.equal(breaker.currentState, 'open');

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(breaker.currentState, 'half_open');

    assert.equal(await breaker.execute(async () => 'healthy again'), 'healthy again');
    assert.equal(breaker.currentState, 'closed');
  });

  it('reopens immediately if the half-open probe fails', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 20 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(breaker.execute(async () => {
        throw new Error('boom');
      }));
    }
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(breaker.currentState, 'half_open');

    await assert.rejects(breaker.execute(async () => {
      throw new Error('still broken');
    }));
    assert.equal(breaker.currentState, 'open', 'one failed probe is enough to reopen');
  });
});
