import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { authenticateRequest } from "./localAuth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    // authenticateRequest reads the cookie/Authorization header and validates
    // the JWT + session version against the database in a single call.
    user = await authenticateRequest(opts.req);
  } catch {
    user = null;
  }

  return { req: opts.req, res: opts.res, user };
}
