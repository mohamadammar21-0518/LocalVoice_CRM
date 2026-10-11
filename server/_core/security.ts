import type { RequestHandler } from "express";
import { ENV } from "./env";

export function rateLimiter(limit: number, windowMs: number): RequestHandler {
  const entries = new Map<string, { count: number; reset: number }>();
  let lastSweep = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now - lastSweep > 60000) { for (const [key, entry] of entries) if (entry.reset <= now) entries.delete(key); lastSweep = now; }
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    let entry = entries.get(key);
    if (!entry || entry.reset <= now) {
      if (entries.size >= 10000 && !entry) { res.status(429).json({ error: "Please try again later" }); return; }
      entry = { count: 0, reset: now + windowMs }; entries.set(key, entry);
    }
    entry.count++;
    if (entry.count > limit) { res.setHeader("Retry-After", Math.ceil((entry.reset - now) / 1000)); res.status(429).json({ error: "Too many requests. Please try again later." }); return; }
    next();
  };
}
export const securityMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "microphone=(self), camera=()");
  if (ENV.isProduction) res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) {
    res.setHeader("Cache-Control", "no-store");
    const hosts = new Set([new URL(ENV.appOrigin).host, ...(ENV.host === "127.0.0.1" ? [`localhost:${ENV.port}`, `127.0.0.1:${ENV.port}`] : [])]);
    if (!hosts.has(req.get("host") ?? "")) { res.status(403).json({ error: "Host is not allowed" }); return; }
    const origin = req.get("origin");
    const origins = new Set([new URL(ENV.appOrigin).origin, ...(ENV.host === "127.0.0.1" ? [`http://localhost:${ENV.port}`, `http://127.0.0.1:${ENV.port}`] : [])]);
    const oauthCallback = req.method === "GET" && req.path === "/api/salesforce/callback";
    // OAuth returns from Salesforce cross-site; its handler verifies browser state and local ownership.
    if (!oauthCallback && ((origin && !origins.has(origin)) || req.get("sec-fetch-site") === "cross-site")) { res.status(403).json({ error: "Origin is not allowed" }); return; }
  }
  next();
};
