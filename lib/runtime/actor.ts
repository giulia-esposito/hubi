/**
 * Who made a request, for the audit log (ISSTD28 5.6: application logs carry the
 * acting user identifier and the source IP).
 *
 * Behind IAP, Cloud Run receives the authenticated user in the
 * X-Goog-Authenticated-User-Email header ("accounts.google.com:name@company")
 * and the client address in X-Forwarded-For. Logging them stores employee
 * identifiers, which the approved design did not, so it is OFF unless
 * HUBI_LOG_ACTOR=1 is set. Turn it on for production once InfoSec has agreed
 * (see docs/production-promotion-plan.md); the rate guard keys on the user
 * regardless and never logs it.
 */

export interface Actor {
  user?: string;
  ip?: string;
}

type Env = Record<string, string | undefined>;

export function actorLoggingEnabled(env: Env = process.env): boolean {
  return env.HUBI_LOG_ACTOR?.trim() === "1";
}

const MAX_FIELD = 200;

function clean(value: string | null | undefined): string | undefined {
  const v = value?.trim();
  return v ? v.slice(0, MAX_FIELD) : undefined;
}

/** The authenticated user as the proxy states it, without IAP's provider prefix. */
export function userFromHeaders(headers: { get(name: string): string | null }): string | undefined {
  const raw = clean(headers.get("x-goog-authenticated-user-email"));
  if (!raw) return undefined;
  const at = raw.indexOf(":");
  return clean(at >= 0 ? raw.slice(at + 1) : raw);
}

/** The original client address: the first entry of X-Forwarded-For, which the platform sets. */
export function ipFromHeaders(headers: { get(name: string): string | null }): string | undefined {
  const forwarded = clean(headers.get("x-forwarded-for"));
  return clean(forwarded?.split(",")[0]);
}

/** The actor to put in a log entry, or undefined when actor logging is off or nothing is known. */
export function actorForLog(headers: { get(name: string): string | null }, env: Env = process.env): Actor | undefined {
  if (!actorLoggingEnabled(env)) return undefined;
  const actor: Actor = { user: userFromHeaders(headers), ip: ipFromHeaders(headers) };
  return actor.user || actor.ip ? actor : undefined;
}
