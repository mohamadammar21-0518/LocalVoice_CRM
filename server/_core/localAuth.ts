import type { Express, Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import * as bcrypt from "bcryptjs";
import { parse as parseCookies } from "cookie";
import { and, eq, isNull } from "drizzle-orm";
import { COOKIE_NAME } from "@shared/const";
import * as db from "../db";
import { ENV } from "./env";
import { rateLimiter } from "./security";

function secretKey() {
  if (ENV.cookieSecret.length < 32 || ENV.cookieSecret.startsWith("change-me")) throw new Error("JWT_SECRET must be configured securely");
  return new TextEncoder().encode(ENV.cookieSecret);
}
export function localCookieOptions(req: Request) {
  return { httpOnly: true, path: "/", sameSite: "lax" as const, secure: req.secure || req.protocol === "https" || ENV.isProduction && new URL(ENV.appOrigin).protocol === "https:" };
}
export async function createLocalSession(openId: string, name: string, sessionVersion = 0) {
  return new SignJWT({ openId, name, sessionVersion }).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setIssuer(ENV.appId).setAudience(ENV.appId).setJti(crypto.randomUUID()).setExpirationTime(`${ENV.sessionHours}h`).sign(secretKey());
}
export async function verifyLocalSession(token: string | undefined | null): Promise<{ openId: string; name: string; sessionVersion: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"], issuer: ENV.appId, audience: ENV.appId });
    if (typeof payload.openId !== "string" || !payload.openId || typeof payload.sessionVersion !== "number" || !Number.isInteger(payload.sessionVersion)) return null;
    return { openId: payload.openId, name: typeof payload.name === "string" ? payload.name : "", sessionVersion: payload.sessionVersion };
  } catch { return null; }
}
export async function authenticateRequest(req: Request) {
  const cookies = parseCookies(req.headers.cookie ?? "");
  const token = cookies[COOKIE_NAME] ?? (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined);
  const session = await verifyLocalSession(token);
  if (!session) return null;
  const user = await db.getUserByOpenId(session.openId);
  return user && user.sessionVersion === session.sessionVersion ? user : null;
}
export function registerLocalAuthRoutes(app: Express) {
  app.post("/api/auth/login", rateLimiter(10, 15 * 60000), async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!req.is("application/json") || typeof username !== "string" || !/^[a-z0-9_]{3,32}$/.test(username) || typeof password !== "string" || password.length > 200) { res.status(400).json({ error: "Valid username and password are required" }); return; }
    try {
      const openId = `local_${username}`;
      let user = await db.getUserByOpenId(openId);
      const stored = user?.passwordHash;
      let authenticated = stored ? await bcrypt.compare(password, stored) : false;
      const bootstrap = !stored && username === ENV.localAdminUsername && Boolean(ENV.localAdminPassword);
      if (bootstrap) authenticated = ENV.localAdminPassword.startsWith("$2") ? await bcrypt.compare(password, ENV.localAdminPassword) : password === ENV.localAdminPassword;
      if (!authenticated) { res.status(401).json({ error: "Invalid credentials" }); return; }
      if (bootstrap) {
        await db.upsertUser({ openId, name: user?.name ?? username, loginMethod: "local", role: "admin" });
        const database = await db.requireDb();
        await database.update(db.users).set({ passwordHash: await bcrypt.hash(password, 12) }).where(and(eq(db.users.openId, openId), isNull(db.users.passwordHash)));
      }
      user = await db.getUserByOpenId(openId);
      if (!user) throw new Error("User unavailable");
      const database = await db.requireDb();
      await database.update(db.users).set({ lastSignedIn: new Date() }).where(eq(db.users.id, user.id));
      const token = await createLocalSession(openId, user.name ?? username, user.sessionVersion);
      res.cookie(COOKIE_NAME, token, { ...localCookieOptions(req), maxAge: ENV.sessionHours * 3600000 });
      res.json({ success: true, username: user.name ?? username, role: user.role });
    } catch { console.error("[Auth] Login could not complete"); res.status(503).json({ error: "Login is unavailable. Check the database and migrations." }); }
  });
  app.post("/api/auth/logout", async (req, res) => {
    try { const user = await authenticateRequest(req); if (user) await db.revokeUserSessions(user.id); }
    catch { res.status(503).json({ error: "Could not revoke the session. Please retry." }); return; }
    res.clearCookie(COOKIE_NAME, localCookieOptions(req)); res.json({ success: true });
  });
}
