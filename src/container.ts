import { authRepository } from './modules/auth/authRepository.js';
import { createAuthService, type AuthService } from './modules/auth/authService.js';
import {
  createPaymentService, MockPaymentProvider,
  type PaymentProvider, type PaymentService,
} from './modules/payments/paymentService.js';

/**
 * Composition root.
 *
 * Dependencies are constructed here and passed down, rather than each module
 * importing its collaborators directly. The point is not ceremony: it is that
 * a test can build the same object graph with a fake repository or a payment
 * provider that always fails, without monkey-patching module internals.
 *
 * Hand-rolled rather than a DI framework — at this size a factory function is
 * the whole feature set that would actually get used.
 */
export interface Container {
  authService: AuthService;
  paymentService: PaymentService;
}

export interface ContainerOverrides {
  paymentProvider?: PaymentProvider;
}

export function createContainer(overrides: ContainerOverrides = {}): Container {
  return {
    authService: createAuthService(authRepository),
    paymentService: createPaymentService(overrides.paymentProvider ?? new MockPaymentProvider()),
  };
}
