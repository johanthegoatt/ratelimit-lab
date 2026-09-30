import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { server } from "../server.js";

test("demo server rate limits /api/ping and refuses paths outside the allowlist", async () => {
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await fetch(`${base}/api/ping`)).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.deepEqual(statuses.slice(10), [429, 429]);

    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  } finally {
    server.close();
  }
});
