// The /api/ping quota, shared by the demo server and the browser page so the
// two cannot drift apart. On a static host there is no server, so the page
// runs this same middleware in the tab against a stand-in request/response.
import { GCRA } from "./limiters.js";
import { createRateLimiter } from "./middleware.js";

export const PING = { limit: 10, periodMs: 10_000, policy: "ping" };

export function createPingLimiter(now) {
  return createRateLimiter({
    limiter: new GCRA({ limit: PING.limit, periodMs: PING.periodMs }),
    windowMs: PING.periodMs,
    policy: PING.policy,
    ...(now ? { now } : {}),
  });
}

// One request through the middleware with no socket: returns the status and
// the headers it set, exactly as a client would read them off the wire.
export function callInProcess(limit, key = "tab") {
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader: (name, value) => { headers[name.toLowerCase()] = value; },
    end: () => {},
  };
  limit({ headers: {}, socket: { remoteAddress: key } }, res, () => {});
  return { status: res.statusCode, headers };
}
