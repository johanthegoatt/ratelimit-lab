import { createAll } from "./limiters.js";

// Seeded PRNG (mulberry32) so a pattern replays identically for every
// algorithm and across reloads.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each pattern returns sorted request timestamps (ms) for one client.
export const PATTERNS = {
  steady: {
    label: "Steady, 2x over the limit",
    make: ({ limit, windowMs, durationMs }) => {
      const gap = windowMs / (limit * 2);
      return Array.from({ length: Math.floor(durationMs / gap) }, (_, i) => i * gap);
    },
  },
  boundary: {
    label: "Bursts on window edges",
    make: ({ limit, windowMs, durationMs }) => {
      const out = [];
      for (let edge = windowMs; edge < durationMs; edge += windowMs * 2) {
        for (let i = 0; i < limit; i += 1) out.push(edge - 1 - i * 0.5, edge + i * 0.5);
      }
      return out.sort((a, b) => a - b);
    },
  },
  bursty: {
    label: "Idle, then a flood",
    make: ({ limit, windowMs, durationMs }) => {
      const out = [];
      for (let start = 0; start < durationMs; start += windowMs * 3) {
        for (let i = 0; i < limit * 3; i += 1) out.push(start + (i * windowMs) / (limit * 6));
      }
      return out;
    },
  },
  poisson: {
    label: "Random arrivals (Poisson)",
    make: ({ limit, windowMs, durationMs }) => {
      const next = rng(42);
      const mean = windowMs / (limit * 1.5);
      const out = [];
      for (let t = 0; t < durationMs; ) {
        t += -Math.log(1 - next()) * mean;
        if (t < durationMs) out.push(t);
      }
      return out;
    },
  },
};

// Largest number of allowed requests inside any window of windowMs, measured
// exactly. This is the burst a backend actually has to absorb.
export function worstWindow(times, windowMs) {
  let best = 0;
  for (let lo = 0, hi = 0; hi < times.length; hi += 1) {
    while (times[hi] - times[lo] >= windowMs) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

export function simulate({ limit, windowMs, durationMs, pattern }) {
  const times = PATTERNS[pattern].make({ limit, windowMs, durationMs });
  return createAll({ limit, windowMs }).map((limiter) => {
    let peakState = 0;
    const events = times.map((t) => {
      const { allowed } = limiter.attempt("client", t);
      peakState = Math.max(peakState, limiter.stateSize("client"));
      return { t, allowed };
    });
    const allowedTimes = events.filter((e) => e.allowed).map((e) => e.t);
    return {
      name: limiter.name,
      events,
      allowed: allowedTimes.length,
      denied: events.length - allowedTimes.length,
      worst: worstWindow(allowedTimes, windowMs),
      peakState,
    };
  });
}
