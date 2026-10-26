import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The clan the current HTTP request is scoped to, readable from code that has
 * no `req` in hand — today only `logAction`, which stamps it on the audit row.
 *
 * Why the audit log needs it: an account can act in more than one clan
 * (user_clan_access, v88). Filing its entries under the actor's HOME clan
 * would show clan A's admins everything that account did as an admin of clan
 * B. Set by `requireAuth`/`optionalAuth`, so every authenticated handler and
 * anything it awaits runs inside it.
 */
interface RequestContext {
  clanId: number | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestClan<T>(clanId: number | null, fn: () => T): T {
  return storage.run({ clanId }, fn);
}

/** The request's clan, or null outside a request (background jobs). */
export function currentRequestClanId(): number | null {
  return storage.getStore()?.clanId ?? null;
}
