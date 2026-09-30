import { test } from "node:test";
import assert from "node:assert/strict";
import { callInProcess, createPingLimiter, PING } from "../src/ping.js";

test("in-tab ping gives the same decisions and headers as the server", () => {
  const limit = createPingLimiter(() => 0);
  const calls = Array.from({ length: PING.limit + 2 }, () => callInProcess(limit));

  assert.deepEqual(calls.map((c) => c.status), [...Array(PING.limit).fill(200), 429, 429]);
  assert.equal(calls[0].headers["ratelimit-policy"], '"ping";q=10;w=10');
  assert.equal(calls[0].headers.ratelimit, '"ping";r=9;t=1');
  assert.equal(calls[PING.limit].headers["retry-after"], "1");
});

test("in-tab ping keys clients separately", () => {
  const limit = createPingLimiter(() => 0);
  for (let i = 0; i < PING.limit; i += 1) callInProcess(limit, "a");
  assert.equal(callInProcess(limit, "a").status, 429);
  assert.equal(callInProcess(limit, "b").status, 200);
});
