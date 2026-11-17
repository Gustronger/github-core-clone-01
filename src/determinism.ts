// Determinism primitives for the forge.
//
// The trial runs every entry twice (live + replay) and compares the exported
// state byte for byte, so nothing observable may come from a wall clock or a
// random source. Every timestamp the forge emits comes from the logical clock
// below (a fixed base epoch plus a monotonic tick); every id comes from a
// counter or a hash of stable inputs. The clock is per-store: one trial is
// one store, so one clock is the whole trial's time.

// The clock's base epoch: 2023-11-14T22:13:20Z, the same constant the
// conformance client's own commit builder defaults to (git-client.ts
// buildCommit). Any fixed value would do; matching the client's default
// keeps locally-built commits and client-built commits in the same era.
export const BASE_EPOCH_SEC = 1700000000;

/**
 * A logical clock: `nowSec()` returns BASE_EPOCH_SEC plus a tick that
 * advances by one on every call, so timestamps are strictly increasing and
 * fully determined by the sequence of calls that produced them.
 */
export class LogicalClock {
  private tick = 0;

  /** The next timestamp, in Unix seconds. */
  nowSec(): number {
    const value = BASE_EPOCH_SEC + this.tick;
    this.tick += 1;
    return value;
  }

  /** The next timestamp as an ISO-8601 string (REST/GraphQL `created_at`). */
  nowIso(): string {
    return formatIso(this.nowSec());
  }

  /** How many timestamps have been issued so far (for tests). */
  issued(): number {
    return this.tick;
  }
}

/** Format a Unix timestamp as an ISO-8601 string (no clock advance). */
export function formatIso(epochSec: number): string {
  // Integer civil-from-days (Howard Hinnant's algorithm): the same string
  // `new Date(epochSec * 1000).toISOString()` produces, without building a
  // Date. Years outside 0000–9999 take the slow path (toISOString's
  // six-digit signed form), so every input stays exact.
  const days = Math.floor(epochSec / 86_400);
  const secsOfDay = epochSec - days * 86_400;
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  if (year < 0 || year > 9_999) return new Date(epochSec * 1_000).toISOString();
  const hh = Math.floor(secsOfDay / 3_600);
  const mm = Math.floor((secsOfDay % 3_600) / 60);
  const ss = secsOfDay % 60;
  return (
    `${pad4(year)}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.000Z`
  );
}

/** Zero-pad a number to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Zero-pad a number to four digits. */
function pad4(n: number): string {
  if (n < 10) return `000${n}`;
  if (n < 100) return `00${n}`;
  if (n < 1_000) return `0${n}`;
  return `${n}`;
}

/**
 * A monotonically increasing counter, starting at 1. Used for request ids
 * (`req-<n>`) and for any per-store sequence that must be stable across a
 * live run and its replay (same requests in the same order → same numbers).
 */
export class Counter {
  private value = 0;

  next(): number {
    this.value += 1;
    return this.value;
  }

  current(): number {
    return this.value;
  }
}
