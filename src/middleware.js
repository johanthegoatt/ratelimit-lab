// Rate limiting for node:http (and anything with the same req/res shape),
// advertising quota with the IETF RateLimit header fields
// (draft-ietf-httpapi-ratelimit-headers-11):
//
//   RateLimit-Policy: "api";q=10;w=60      the quota: 10 units per 60s
//   RateLimit: "api";r=7;t=42              7 left, full again in 42s
//
// Denied requests get 429 with Retry-After, which clients already honour.

const DEFAULT_KEY = (req) => req.socket?.remoteAddress ?? "unknown";

// Structured-field strings only allow printable ASCII; keep policy names safe.
function sfString(value) {
  return `"${String(value).replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "\\$&")}"`;
}

export function createRateLimiter({
  limiter,
  windowMs,
  policy = "default",
  key = DEFAULT_KEY,
  now = () => Date.now(),
}) {
  if (!limiter || typeof limiter.attempt !== "function") {
    throw new TypeError("createRateLimiter needs a limiter with attempt(key, now)");
  }
  if (!(windowMs > 0)) throw new TypeError("windowMs must be a positive number");

  const name = sfString(policy);
  const policyHeader = `${name};q=${limiter.limit};w=${Math.ceil(windowMs / 1000)}`;

  return function rateLimit(req, res, next) {
    const result = limiter.attempt(key(req), now());
    res.setHeader("RateLimit-Policy", policyHeader);
    res.setHeader(
      "RateLimit",
      `${name};r=${result.remaining};t=${Math.ceil(result.resetMs / 1000)}`,
    );

    if (result.allowed) return next();

    // Retry-After is whole seconds; round up so a client never retries early.
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "rate_limited", retryAfterMs: result.retryAfterMs }));
  };
}
