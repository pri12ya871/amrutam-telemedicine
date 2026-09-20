import { z } from 'zod';

/**
 * Password policy follows NIST SP 800-63B: length is the primary control,
 * composition rules are not imposed (they push users toward predictable
 * substitutions), and a deny-list catches the handful of passwords that
 * credential-stuffing tries first.
 */
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', 'qwertyui',
  'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'letmein1', 'amrutam123',
]);

export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'This password is too common');

export const emailSchema = z.string().email().max(254).toLowerCase().trim();

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  fullName: z.string().min(2).max(120).trim(),
  // Admins are never self-registered; they are provisioned out of band.
  role: z.enum(['patient', 'doctor']).default('patient'),
  phone: z.string().regex(/^\+?[0-9]{8,15}$/, 'Invalid phone number').optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

export const mfaConfirmSchema = z.object({
  totp: z.string().regex(/^\d{6}$/, 'TOTP code must be 6 digits'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
