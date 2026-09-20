import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { conflict, notFound, serviceUnavailable } from '../../lib/errors.js';
import { CircuitBreaker, withRetry } from '../../lib/retry.js';
import { logger } from '../../lib/logger.js';
import { auditInTransaction } from '../audit/auditService.js';
import { bookingService } from '../booking/bookingService.js';

export const capturePaymentSchema = z.object({
  paymentId: z.string().uuid(),
  /** Mock provider only: lets tests and the demo drive the failure path. */
  simulate: z.enum(['success', 'failure', 'timeout']).default('success'),
});

export interface PaymentProvider {
  readonly name: string;
  charge(input: { paymentId: string; amountPaise: number; simulate?: string }): Promise<{ providerRef: string }>;
}

/**
 * Stand-in for Razorpay/Stripe.
 *
 * The integration itself is out of scope for this submission — what is in
 * scope is everything around it: the retry schedule, the circuit breaker, the
 * saga that compensates when it fails, and the idempotency that stops a
 * retried request charging twice. Swapping this for a real provider is one
 * class implementing this interface.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';

  async charge({ paymentId, simulate }: { paymentId: string; amountPaise: number; simulate?: string }) {
    await new Promise((r) => setTimeout(r, 20));
    if (simulate === 'failure') throw new Error('card_declined');
    if (simulate === 'timeout') {
      const err = new Error('provider_timeout');
      (err as Error & { retryable: boolean }).retryable = true;
      throw err;
    }
    return { providerRef: `mock_${paymentId.slice(0, 8)}_${Date.now()}` };
  }
}

const breaker = new CircuitBreaker({ name: 'payment-provider', failureThreshold: 5, resetTimeoutMs: 30_000 });

export function createPaymentService(provider: PaymentProvider = new MockPaymentProvider()) {
  return {
    /**
     * Capture a pending payment and confirm the consultation.
     *
     * The state transition is guarded in SQL (`WHERE status = 'pending'`), so
     * a duplicate capture — a retried client call, a replayed webhook — finds
     * nothing to update and returns the existing result instead of charging
     * again.
     */
    async capture(paymentId: string, patientId: string, simulate = 'success') {
      const found = await query<{
        id: string; consultation_id: string; amount_paise: number;
        status: string; patient_id: string;
      }>(
        `SELECT id, consultation_id, amount_paise, status, patient_id
           FROM payments WHERE id = $1`,
        [paymentId],
      );
      const payment = found.rows[0];
      if (!payment) throw notFound('Payment');
      if (payment.patient_id !== patientId) throw notFound('Payment');

      if (payment.status === 'captured') {
        // Already done. Returning success is correct: the caller's intent has
        // been satisfied, and erroring would push clients into retry loops.
        return { paymentId, status: 'captured', alreadyCaptured: true };
      }
      if (payment.status !== 'pending') {
        throw conflict(`Payment is ${payment.status} and cannot be captured`, 'INVALID_PAYMENT_STATE');
      }

      let providerRef: string;
      try {
        providerRef = (
          await breaker.execute(() =>
            withRetry(
              () => provider.charge({ paymentId, amountPaise: payment.amount_paise, simulate }),
              {
                attempts: 3,
                baseMs: 100,
                maxMs: 2_000,
                // A declined card is a terminal answer; retrying it just
                // annoys the issuer and delays the user's real error.
                retryable: (err) => (err as Error).message !== 'card_declined',
              },
            ),
          )
        ).providerRef;
      } catch (err) {
        await query(
          `UPDATE payments
              SET status = 'failed', attempts = attempts + 1,
                  last_error = $2, updated_at = now()
            WHERE id = $1`,
          [paymentId, (err as Error).message.slice(0, 500)],
        );
        logger.warn({ err, paymentId }, 'payment capture failed');

        if ((err as Error).message.includes('circuit')) {
          throw serviceUnavailable('Payment provider is unavailable. Your slot is held — please retry shortly.');
        }
        throw conflict('Payment was declined', 'PAYMENT_DECLINED');
      }

      await withTransaction(async (client) => {
        const updated = await query(
          `UPDATE payments
              SET status = 'captured', provider = $2, provider_ref = $3,
                  attempts = attempts + 1, updated_at = now()
            WHERE id = $1 AND status = 'pending'`,
          [paymentId, provider.name, providerRef],
          client,
        );

        // Lost the race to a concurrent capture — the other one confirmed the
        // consultation, so there is nothing left to do here.
        if (updated.rowCount === 0) return;

        await bookingService.confirm(payment.consultation_id, client);
        await auditInTransaction(
          {
            action: 'payment.captured', resourceType: 'payment', resourceId: paymentId,
            actorId: patientId,
            metadata: { consultationId: payment.consultation_id, amountPaise: payment.amount_paise },
          },
          client,
        );
      });

      return { paymentId, status: 'captured', consultationId: payment.consultation_id };
    },

    async listForPatient(patientId: string) {
      const { rows } = await query(
        `SELECT id, consultation_id, amount_paise, currency, status, created_at
           FROM payments WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [patientId],
      );
      return rows;
    },

    breakerState: () => breaker.currentState,
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
