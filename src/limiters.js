// Five rate limiting algorithms behind one interface.
//
// Every limiter takes the clock as an argument (`now`, in milliseconds) instead
// of reading Date.now(). That keeps them deterministic under test and lets the
// browser simulator replay a traffic pattern through all five at once.
//
// attempt(key, now) returns:
//   allowed       whether this request goes through
//   remaining     requests that would still be allowed right now
//   resetMs       ms until the quota is fully available again
//   retryAfterMs  ms until the next request could succeed (0 when allowed)

export class FixedWindow {
  constructor({ limit, windowMs }) {
    this.name = "fixed-window";
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map(); // key -> { start, count }
  }

  attempt(key, now) {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    let w = this.windows.get(key);
    if (!w || w.start !== start) {
      w = { start, count: 0 };
      this.windows.set(key, w);
    }
    const resetMs = start + this.windowMs - now;
    if (w.count >= this.limit) {
      return { allowed: false, remaining: 0, resetMs, retryAfterMs: resetMs };
    }
    w.count += 1;
    return { allowed: true, remaining: this.limit - w.count, resetMs, retryAfterMs: 0 };
  }

  stateSize(key) {
    return this.windows.has(key) ? 2 : 0;
  }
}

// Exact, but stores one timestamp per allowed request: memory grows with the
// limit, which is why it is rarely used for large quotas.
export class SlidingLog {
  constructor({ limit, windowMs }) {
    this.name = "sliding-log";
    this.limit = limit;
    this.windowMs = windowMs;
    this.logs = new Map(); // key -> ascending timestamps
  }

  attempt(key, now) {
    const log = this.logs.get(key) ?? [];
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < log.length && log[drop] <= cutoff) drop += 1;
    if (drop) log.splice(0, drop);
    this.logs.set(key, log);

    if (log.length >= this.limit) {
      const retryAfterMs = log[0] + this.windowMs - now;
      const resetMs = log[log.length - 1] + this.windowMs - now;
      return { allowed: false, remaining: 0, resetMs, retryAfterMs };
    }
    log.push(now);
    return {
      allowed: true,
      remaining: this.limit - log.length,
      resetMs: this.windowMs,
      retryAfterMs: 0,
    };
  }

  stateSize(key) {
    return this.logs.get(key)?.length ?? 0;
  }
}

// Cloudflare's approximation: weight the previous fixed window's count by how
// much of it still overlaps the sliding window, and add the current count.
//   estimate = prev * (windowMs - elapsed) / windowMs + current
// Two counters per key, with a reported 0.003% of requests misjudged over
// 400M requests in Cloudflare's own measurement.
export class SlidingWindowCounter {
  constructor({ limit, windowMs }) {
    this.name = "sliding-window-counter";
    this.limit = limit;
    this.windowMs = windowMs;
    this.counters = new Map(); // key -> { start, current, previous }
  }

  estimate(key, now) {
    const c = this.#roll(key, now);
    const elapsed = now - c.start;
    return (c.previous * (this.windowMs - elapsed)) / this.windowMs + c.current;
  }

  #roll(key, now) {
    const start = Math.floor(now / this.windowMs) * this.windowMs;
    let c = this.counters.get(key);
    if (!c) {
      c = { start, current: 0, previous: 0 };
    } else if (c.start !== start) {
      const adjacent = start - c.start === this.windowMs;
      c = { start, current: 0, previous: adjacent ? c.current : 0 };
    }
    this.counters.set(key, c);
    return c;
  }

  attempt(key, now) {
    const c = this.#roll(key, now);
    const elapsed = now - c.start;
    const weight = (this.windowMs - elapsed) / this.windowMs;
    const estimate = c.previous * weight + c.current;
    // Fully reset once every counted request has aged out of the window.
    const resetMs = c.start + this.windowMs - now + (c.current ? this.windowMs : 0);

    if (estimate + 1 > this.limit) {
      // Solve prev * (W - t) / W + current + 1 <= limit for the wait t.
      let retryAfterMs = c.start + this.windowMs - now;
      if (c.previous > 0 && c.current + 1 <= this.limit) {
        const needed = this.windowMs - ((this.limit - c.current - 1) * this.windowMs) / c.previous;
        retryAfterMs = Math.max(1, Math.ceil(needed - elapsed));
      }
      return { allowed: false, remaining: 0, resetMs, retryAfterMs };
    }
    c.current += 1;
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(this.limit - (estimate + 1))),
      resetMs: c.start + 2 * this.windowMs - now,
      retryAfterMs: 0,
    };
  }

  stateSize(key) {
    return this.counters.has(key) ? 3 : 0;
  }
}

// Classic token bucket, refilled lazily from the elapsed time on each call so
// no timer runs per key.
export class TokenBucket {
  constructor({ capacity, refillPerSecond }) {
    this.name = "token-bucket";
    this.limit = capacity;
    this.capacity = capacity;
    this.msPerToken = 1000 / refillPerSecond;
    this.buckets = new Map(); // key -> { tokens, updated }
  }

  attempt(key, now) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updated: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updated) / this.msPerToken);
    b.updated = now;

    if (b.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - b.tokens) * this.msPerToken);
      const resetMs = Math.ceil((this.capacity - b.tokens) * this.msPerToken);
      return { allowed: false, remaining: 0, resetMs, retryAfterMs };
    }
    b.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(b.tokens),
      resetMs: Math.ceil((this.capacity - b.tokens) * this.msPerToken),
      retryAfterMs: 0,
    };
  }

  stateSize(key) {
    return this.buckets.has(key) ? 2 : 0;
  }
}

// Generic Cell Rate Algorithm. Behaves like a token bucket but stores a single
// number per key, the theoretical arrival time (TAT) of the next request.
//   T   = periodMs / limit   emission interval
//   tau = T * limit          how far TAT may run ahead of now (the burst)
export class GCRA {
  constructor({ limit, periodMs }) {
    this.name = "gcra";
    this.limit = limit;
    this.interval = periodMs / limit;
    this.tolerance = this.interval * limit;
    this.tat = new Map(); // key -> theoretical arrival time
  }

  attempt(key, now) {
    const tat = Math.max(this.tat.get(key) ?? now, now);
    const newTat = tat + this.interval;
    const allowAt = newTat - this.tolerance;

    if (now < allowAt) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: Math.ceil(tat - now),
        retryAfterMs: Math.ceil(allowAt - now),
      };
    }
    this.tat.set(key, newTat);
    return {
      allowed: true,
      remaining: Math.floor((now - allowAt) / this.interval + 1e-9),
      resetMs: Math.ceil(newTat - now),
      retryAfterMs: 0,
    };
  }

  stateSize(key) {
    return this.tat.has(key) ? 1 : 0;
  }
}

// Builds all five with equivalent settings: `limit` requests per `windowMs`.
export function createAll({ limit, windowMs }) {
  return [
    new FixedWindow({ limit, windowMs }),
    new SlidingLog({ limit, windowMs }),
    new SlidingWindowCounter({ limit, windowMs }),
    new TokenBucket({ capacity: limit, refillPerSecond: (limit * 1000) / windowMs }),
    new GCRA({ limit, periodMs: windowMs }),
  ];
}
