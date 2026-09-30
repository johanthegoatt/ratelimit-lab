// Demo server: the simulator UI plus a rate limited JSON endpoint.
//   node server.js            -> http://localhost:8787
//   curl -i localhost:8787/api/ping
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { GCRA } from "./src/limiters.js";
import { createRateLimiter } from "./src/middleware.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT) || 8787;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const publicFiles = new Set(["/index.html", "/src/limiters.js", "/src/sim.js", "/src/style.css"]);

const limit = createRateLimiter({
  limiter: new GCRA({ limit: 10, periodMs: 10_000 }),
  windowMs: 10_000,
  policy: "ping",
});

export const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");

  if (pathname === "/api/ping") {
    return limit(req, res, () => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, at: new Date().toISOString() }));
    });
  }

  const file = pathname === "/" ? "/index.html" : normalize(pathname).replace(/\\/g, "/");
  if (!publicFiles.has(file)) {
    res.statusCode = 404;
    return res.end("not found");
  }
  try {
    const body = await readFile(join(root, file));
    res.setHeader("Content-Type", `${types[extname(file)] ?? "text/plain"}; charset=utf-8`);
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(port, () => console.log(`ratelimit-lab on http://localhost:${port}`));
}
