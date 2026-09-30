import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { SlidingLog, TokenBucket } from "../src/limiters.js";
import { createRateLimiter } from "../src/middleware.js";

async function withServer(middleware, run) {
  const server = createServer((req, res) =>
    middleware(req, res, () => res.end("ok")),
  );
  server.listen(0);
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test("advertises the policy and remaining quota with IETF headers", async () => {
  let clock = 0;
  const mw = createRateLimiter({
    limiter: new SlidingLog({ limit: 3, windowMs: 60_000 }),
    windowMs: 60_000,
    policy: "api",
    now: () => clock,
  });
  await withServer(mw, async (url) => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ratelimit-policy"), '"api";q=3;w=60');
    assert.equal(res.headers.get("ratelimit"), '"api";r=2;t=60');
  });
});

test("returns 429 with a rounded-up Retry-After once exhausted", async () => {
  let clock = 0;
  const mw = createRateLimiter({
    limiter: new TokenBucket({ capacity: 2, refillPerSecond: 0.4 }), // 2.5s per token
    windowMs: 5_000,
    now: () => clock,
  });
  await withServer(mw, async (url) => {
    await fetch(url);
    await fetch(url);
    const denied = await fetch(url);
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get("retry-after"), "3");
    assert.match(denied.headers.get("ratelimit"), /;r=0;/);
    assert.deepEqual(await denied.json(), { error: "rate_limited", retryAfterMs: 2500 });

    clock = 2_500;
    assert.equal((await fetch(url)).status, 200);
  });
});

test("uses the key function to separate clients", async () => {
  const mw = createRateLimiter({
    limiter: new SlidingLog({ limit: 1, windowMs: 1000 }),
    windowMs: 1000,
    key: (req) => req.headers["x-api-key"],
    now: () => 0,
  });
  await withServer(mw, async (url) => {
    assert.equal((await fetch(url, { headers: { "x-api-key": "a" } })).status, 200);
    assert.equal((await fetch(url, { headers: { "x-api-key": "b" } })).status, 200);
    assert.equal((await fetch(url, { headers: { "x-api-key": "a" } })).status, 429);
  });
});

test("escapes policy names into valid structured-field strings", async () => {
  const mw = createRateLimiter({
    limiter: new SlidingLog({ limit: 1, windowMs: 1000 }),
    windowMs: 1000,
    policy: 'say "hi"',
  });
  await withServer(mw, async (url) => {
    const res = await fetch(url);
    assert.equal(res.headers.get("ratelimit-policy"), '"say \\"hi\\"";q=1;w=1');
  });
});

test("rejects a missing limiter or window", () => {
  assert.throws(() => createRateLimiter({ windowMs: 1000 }), TypeError);
  assert.throws(
    () => createRateLimiter({ limiter: new SlidingLog({ limit: 1, windowMs: 1 }), windowMs: 0 }),
    TypeError,
  );
});
