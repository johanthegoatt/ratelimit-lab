import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, simulate, worstWindow } from "../src/sim.js";

test("worstWindow counts the densest half-open window exactly", () => {
  assert.equal(worstWindow([], 1000), 0);
  assert.equal(worstWindow([0, 999, 1000, 1500], 1000), 3);
  assert.equal(worstWindow([0, 1000, 2000], 1000), 1);
});

test("patterns are sorted, in range and deterministic", () => {
  const settings = { limit: 10, windowMs: 1000, durationMs: 6000 };
  for (const [name, { make }] of Object.entries(PATTERNS)) {
    const times = make(settings);
    assert.ok(times.length > 0, name);
    assert.ok(times.every((t, i) => t >= 0 && t < 6000 && (i === 0 || times[i - 1] <= t)), name);
    assert.deepEqual(make(settings), times, name);
  }
});

test("on edge bursts only the fixed window leaks past the limit", () => {
  const results = simulate({ limit: 10, windowMs: 1000, durationMs: 6000, pattern: "boundary" });
  const worst = Object.fromEntries(results.map((r) => [r.name, r.worst]));
  assert.equal(worst["fixed-window"], 20);
  for (const name of ["sliding-log", "sliding-window-counter", "gcra"]) {
    assert.ok(worst[name] <= 10, `${name} admitted ${worst[name]}`);
  }
});

test("peak state shows the sliding log paying memory per request", () => {
  const results = simulate({ limit: 20, windowMs: 1000, durationMs: 4000, pattern: "steady" });
  const state = Object.fromEntries(results.map((r) => [r.name, r.peakState]));
  assert.equal(state["sliding-log"], 20);
  assert.equal(state.gcra, 1);
});
