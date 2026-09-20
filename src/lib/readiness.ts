/**
 * Liveness and readiness are different questions, and conflating them causes
 * restart loops.
 *
 * Liveness: is this process healthy enough to keep? If it answers no, the
 * orchestrator kills and replaces it.
 *
 * Readiness: should it receive traffic right now? A pod that is still applying
 * migrations, or whose database is briefly unreachable, is alive but not
 * ready — restarting it would help nothing and would throw away in-flight
 * requests.
 *
 * So the server starts listening immediately and reports not-ready until the
 * schema is in place.
 */
let migrationsApplied = false;

export const markMigrationsApplied = (): void => {
  migrationsApplied = true;
};

export const areMigrationsApplied = (): boolean => migrationsApplied;
