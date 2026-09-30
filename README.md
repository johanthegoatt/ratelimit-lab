# ratelimit-lab

Five rate limiting algorithms, an HTTP middleware that advertises quota with the
IETF `RateLimit` headers, and a simulator that replays the same traffic through
all five so the differences are visible instead of theoretical.

Zero dependencies. Node 20+.

```bash
npm test      # 20 tests: algorithms, middleware over real sockets, simulator
npm start     # http://localhost:8787, simulator plus a rate limited /api/ping
```

## The algorithms

Each one implements `attempt(key, now)` and returns `allowed`, `remaining`,
`resetMs` and `retryAfterMs`. The clock is passed in rather than read, so every
test is deterministic and the browser can replay a pattern through all five.

| Algorithm | State per key | Worst window (limit 10, edge bursts) | Notes |
| --- | --- | --- | --- |
| Fixed window | 2 numbers | 20 | Resets on the boundary, so a burst either side of it doubles the limit |
| Sliding log | 1 timestamp per request | 10 | Exact, memory grows with the limit |
| Sliding window counter | 3 numbers | 10 | Cloudflare's weighted estimate of the previous window |
| Token bucket | 2 numbers | 10 | Refilled lazily from elapsed time, no timers |
| GCRA | 1 number | 10 | Token bucket behaviour stored as one theoretical arrival time |

The worst window column comes from the simulator: the most allowed requests
inside any real window, found with a two-pointer sweep over the allowed
timestamps.

**Sliding window counter.** Cloudflare estimates the rate as
`previous * (window - elapsed) / window + current`. Their measurement over
400 million requests from 270,000 sources found 0.003% of requests wrongly
allowed or limited. The tests reproduce their worked example (42 last minute,
18 this minute, 15 seconds in, estimate 49.5) and solve that same inequality
for an exact `Retry-After`.

**Token bucket and GCRA are rate limits, not window limits.** With capacity 10
and a refill of 10 per second, a client can spend the full bucket and then the
refill inside one second, so the steady pattern shows 19 in a window. That is
the intended contract (a sustained rate plus a burst allowance), and the
simulator flags it so the trade is visible. The tests check that GCRA and the
token bucket make identical decisions on a steady flood.

## The middleware

```js
import { createServer } from "node:http";
import { GCRA } from "./src/limiters.js";
import { createRateLimiter } from "./src/middleware.js";

const limit = createRateLimiter({
  limiter: new GCRA({ limit: 100, periodMs: 60_000 }),
  windowMs: 60_000,
  policy: "api",
  key: (req) => req.headers["x-api-key"] ?? req.socket.remoteAddress,
});

createServer((req, res) => limit(req, res, () => res.end("ok"))).listen(3000);
```

Headers follow
[draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/):

```
RateLimit-Policy: "api";q=100;w=60
RateLimit: "api";r=97;t=2
```

`RateLimit-Policy` states the quota, `RateLimit` states what is left and how
many seconds until it is whole again. A denied request gets `429` and
`Retry-After` rounded up to whole seconds, so a well-behaved client never
retries early. Policy names are escaped into valid structured-field strings.

The demo server only serves files on an explicit allowlist, so path tricks like
`/..%2fserver.js` return 404; there is a test for that.

## Layout

```
src/limiters.js     the five algorithms
src/middleware.js   node:http middleware and RateLimit headers
src/sim.js          traffic patterns, replay and worst-window sweep
index.html          simulator UI (canvas timelines, live API panel)
server.js           demo server
test/               node:test suites
```

## Sources

- Cloudflare, [How we built rate limiting capable of scaling to millions of domains](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- IETF HTTPAPI, [RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
