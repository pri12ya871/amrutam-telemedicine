import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { can, PERMISSIONS } from '../../src/middleware/auth.ts';
import { canTransition } from '../../src/modules/consultations/consultationService.ts';

/**
 * The permission matrix is security-critical configuration, so it is asserted
 * rather than trusted. These tests are the executable version of the RBAC
 * table in docs/security-checklist.md — if someone widens a role, one of them
 * fails.
 */
describe('RBAC matrix', () => {
  it('lets a patient book but never verify a doctor', () => {
    assert.equal(can('patient', 'booking:create'), true);
    assert.equal(can('patient', 'doctor:verify'), false);
  });

  it('never lets a patient read another patient\'s records', () => {
    assert.equal(can('patient', 'consultation:read:any'), false);
    assert.equal(can('patient', 'prescription:read:any'), false);
    assert.equal(can('patient', 'profile:read:any'), false);
  });

  it('lets a doctor prescribe but not book on a patient\'s behalf', () => {
    assert.equal(can('doctor', 'prescription:create'), true);
    assert.equal(can('doctor', 'booking:create'), false);
  });

  it('never lets a doctor read analytics or the audit trail', () => {
    assert.equal(can('doctor', 'analytics:read'), false);
    assert.equal(can('doctor', 'audit:read'), false);
  });

  it('gives admins analytics and audit access', () => {
    assert.equal(can('admin', 'analytics:read'), true);
    assert.equal(can('admin', 'audit:read'), true);
  });

  it('never grants prescription:create to a non-doctor', () => {
    assert.equal(can('patient', 'prescription:create'), false);
    // Admins administer the platform; they do not practise medicine on it.
    assert.equal(can('admin', 'prescription:create'), false);
  });

  it('refuses unknown permissions for every role', () => {
    for (const role of ['patient', 'doctor', 'admin'] as const) {
      assert.equal(can(role, 'database:drop'), false);
      assert.equal(can(role, ''), false);
    }
  });

  it('grants no permission by accident through duplication', () => {
    for (const [role, perms] of Object.entries(PERMISSIONS)) {
      assert.equal(new Set(perms).size, perms.length, `${role} has duplicate permissions`);
    }
  });
});

/**
 * The consultation state machine. Every illegal transition asserted here is
 * one that would otherwise be reachable through the API.
 */
describe('consultation state machine', () => {
  it('allows the happy path', () => {
    assert.equal(canTransition('pending_payment', 'scheduled'), true);
    assert.equal(canTransition('scheduled', 'in_progress'), true);
    assert.equal(canTransition('in_progress', 'completed'), true);
  });

  it('refuses to skip payment', () => {
    assert.equal(canTransition('pending_payment', 'in_progress'), false);
    assert.equal(canTransition('pending_payment', 'completed'), false);
  });

  it('refuses to reopen a finished consultation', () => {
    for (const to of ['scheduled', 'in_progress', 'completed', 'cancelled']) {
      assert.equal(canTransition('completed', to), false, `completed -> ${to}`);
      assert.equal(canTransition('cancelled', to), false, `cancelled -> ${to}`);
    }
  });

  it('allows cancellation from any live state', () => {
    assert.equal(canTransition('pending_payment', 'cancelled'), true);
    assert.equal(canTransition('scheduled', 'cancelled'), true);
    assert.equal(canTransition('in_progress', 'cancelled'), true);
  });

  it('only allows no_show from scheduled', () => {
    assert.equal(canTransition('scheduled', 'no_show'), true);
    assert.equal(canTransition('in_progress', 'no_show'), false);
    assert.equal(canTransition('pending_payment', 'no_show'), false);
  });

  it('refuses transitions from an unknown state', () => {
    assert.equal(canTransition('nonsense', 'completed'), false);
  });
});
