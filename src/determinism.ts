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
  return new Date(epochSec * 1000).toISOString();
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
