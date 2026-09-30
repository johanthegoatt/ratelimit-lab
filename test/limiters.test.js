import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FixedWindow,
  SlidingLog,
  SlidingWindowCounter,
  TokenBucket,
  GCRA,
  createAll,
} from "../src/limiters.js";

const allowedCount = (limiter, times, key = "k") =>
  times.filter((t) => limiter.attempt(key, t).allowed).length;

test("every limiter caps a same-instant burst at the limit", () => {
  for (const limiter of createAll({ limit: 5, windowMs: 1000 })) {
    const burst = Array(20).fill(10_000);
    assert.equal(allowedCount(limiter, burst), 5, limiter.name);
  }
});

test("fixed window lets through double the limit across a boundary", () => {
  // 5 at t=999 and 5 at t=1000: ten requests inside one millisecond-wide span.
  const edge = [...Array(5).fill(999), ...Array(5).fill(1000)];
  assert.equal(allowedCount(new FixedWindow({ limit: 5, windowMs: 1000 }), edge), 10);
  assert.equal(allowedCount(new SlidingLog({ limit: 5, windowMs: 1000 }), edge), 5);
  assert.equal(allowedCount(new SlidingWindowCounter({ limit: 5, windowMs: 1000 }), edge), 5);
  assert.equal(allowedCount(new GCRA({ limit: 5, periodMs: 1000 }), edge), 5);
});

test("keys are isolated", () => {
  for (const limiter of createAll({ limit: 1, windowMs: 1000 })) {
    assert.ok(limiter.attempt("a", 0).allowed, limiter.name);
    assert.ok(limiter.attempt("b", 0).allowed, limiter.name);
    assert.ok(!limiter.attempt("a", 0).allowed, limiter.name);
  }
});

test("sliding window counter reproduces Cloudflare's worked example", () => {
  // 50/min limit, 42 requests last minute, 18 this minute, 15s in -> 49.5.
  const limiter = new SlidingWindowCounter({ limit: 50, windowMs: 60_000 });
  for (let i = 0; i < 42; i += 1) limiter.attempt("k", 1_000);
  for (let i = 0; i < 18; i += 1) assert.ok(limiter.attempt("k", 75_000).allowed);
  assert.equal(limiter.estimate("k", 75_000), 49.5);
  assert.ok(!limiter.attempt("k", 75_000).allowed, "49.5 + 1 exceeds 50");
});

test("sliding window counter retry-after is when the weighted count drops enough", () => {
  const limiter = new SlidingWindowCounter({ limit: 10, windowMs: 1000 });
  for (let i = 0; i < 10; i += 1) limiter.attempt("k", 0);
  const denied = limiter.attempt("k", 1000);
  assert.ok(!denied.allowed);
  // prev=10 must weigh <= 9, i.e. 100ms into the new window.
  assert.equal(denied.retryAfterMs, 100);
  assert.ok(!limiter.attempt("k", 1099).allowed);
  assert.ok(limiter.attempt("k", 1100).allowed);
});

test("sliding log retry-after points at the oldest entry leaving the window", () => {
  const limiter = new SlidingLog({ limit: 2, windowMs: 1000 });
  limiter.attempt("k", 0);
  limiter.attempt("k", 400);
  const denied = limiter.attempt("k", 500);
  assert.equal(denied.retryAfterMs, 500);
  assert.ok(limiter.attempt("k", 1001).allowed);
  assert.equal(limiter.stateSize("k"), 2);
});

test("token bucket refills continuously", () => {
  const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 4 });
  assert.ok(bucket.attempt("k", 0).allowed);
  assert.ok(bucket.attempt("k", 0).allowed);
  const denied = bucket.attempt("k", 0);
  assert.equal(denied.retryAfterMs, 250);
  assert.ok(!bucket.attempt("k", 249).allowed);
  assert.ok(bucket.attempt("k", 250).allowed);
});

test("GCRA spaces requests at the emission interval once the burst is spent", () => {
  const gcra = new GCRA({ limit: 4, periodMs: 1000 }); // T = 250ms
  const first = gcra.attempt("k", 0);
  assert.equal(first.remaining, 3);
  for (let i = 0; i < 3; i += 1) assert.ok(gcra.attempt("k", 0).allowed);
  const denied = gcra.attempt("k", 0);
  assert.equal(denied.retryAfterMs, 250);
  assert.ok(gcra.attempt("k", 250).allowed);
  assert.ok(!gcra.attempt("k", 251).allowed);
  assert.equal(gcra.stateSize("k"), 1);
});

test("GCRA and token bucket agree on a steady over-limit stream", () => {
  const times = Array.from({ length: 400 }, (_, i) => i * 10); // 100 req/s for 4s
  const gcra = allowedCount(new GCRA({ limit: 10, periodMs: 1000 }), times);
  const bucket = allowedCount(new TokenBucket({ capacity: 10, refillPerSecond: 10 }), times);
  assert.equal(gcra, bucket);
});

test("remaining never goes negative and retry-after is zero when allowed", () => {
  for (const limiter of createAll({ limit: 3, windowMs: 500 })) {
    for (let t = 0; t < 3000; t += 37) {
      const r = limiter.attempt("k", t);
      assert.ok(r.remaining >= 0, limiter.name);
      if (r.allowed) assert.equal(r.retryAfterMs, 0, limiter.name);
      else assert.ok(r.retryAfterMs > 0, `${limiter.name} at ${t}`);
    }
  }
});
