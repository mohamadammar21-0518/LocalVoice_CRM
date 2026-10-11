import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export type SalesforceOwner = { id: number; sessionVersion: number };
const connectionSchema = z.object({
  version: z.number().int().nonnegative(),
  accessToken: z.string().min(1).max(16384),
  refreshToken: z.string().min(1).max(16384).optional(),
  instance: z.string().url(),
});
export type SalesforceConnection = z.infer<typeof connectionSchema>;

// One application process owns this store. All operations for an owner share
// a lock, including remote refresh, so disconnect cannot race a token save.
export class SalesforceConnectionStore {
  private memory = new Map<number, SalesforceConnection>();
  private locks = new Map<number, Promise<unknown>>();
  readonly persistent: boolean;
  constructor(
    private options: {
      directory: string;
      key?: Buffer;
      binding: string;
      instance: string;
    }
  ) {
    if (options.key && options.key.length !== 32)
      throw new Error("Salesforce encryption key must contain 32 bytes");
    this.persistent = Boolean(options.key);
  }

  async exclusive<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.locks.set(userId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(userId) === current) this.locks.delete(userId);
    }
  }

  private filename(userId: number) {
    if (!Number.isSafeInteger(userId) || userId < 1)
      throw new Error("Invalid connection owner");
    return path.join(this.options.directory, `${userId}.json`);
  }
  private aad(userId: number) {
    return Buffer.from(
      `localvoice:salesforce:v1:${userId}:${this.options.binding}`
    );
  }

  async load(
    owner: SalesforceOwner
  ): Promise<SalesforceConnection | undefined> {
    let connection = this.memory.get(owner.id);
    if (this.options.key) {
      try {
        const file = await fs.open(this.filename(owner.id), "r");
        let raw: string;
        try {
          if ((await file.stat()).size > 65536)
            throw new Error("Invalid connection file");
          raw = await file.readFile("utf8");
        } finally {
          await file.close();
        }
        const envelope = z
          .object({
            version: z.literal(1),
            iv: z.string(),
            tag: z.string(),
            data: z.string(),
          })
          .parse(JSON.parse(raw));
        const iv = Buffer.from(envelope.iv, "base64"),
          tag = Buffer.from(envelope.tag, "base64");
        if (iv.length !== 12 || tag.length !== 16)
          throw new Error("Invalid encrypted connection");
        const decipher = createDecipheriv("aes-256-gcm", this.options.key, iv);
        decipher.setAAD(this.aad(owner.id));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, "base64")),
          decipher.final(),
        ]);
        connection = connectionSchema.parse(
          JSON.parse(plaintext.toString("utf8"))
        );
        if (connection.instance !== this.options.instance)
          throw new Error("Organisation mismatch");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw new Error(
          "Saved Salesforce connection is unavailable. Disconnect and reconnect Salesforce."
        );
      }
    }
    if (connection && connection.version < owner.sessionVersion) {
      await this.remove(owner.id);
      return undefined;
    }
    return connection?.version === owner.sessionVersion
      ? connection
      : undefined;
  }

  async save(owner: SalesforceOwner, connection: SalesforceConnection) {
    connectionSchema.parse(connection);
    if (
      connection.version !== owner.sessionVersion ||
      connection.instance !== this.options.instance
    )
      throw new Error("Connection owner or organisation mismatch");
    if (!this.options.key) {
      if (this.memory.size >= 500 && !this.memory.has(owner.id))
        throw new Error("Salesforce connection capacity reached");
      this.memory.set(owner.id, connection);
      return;
    }
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.options.key, iv);
    cipher.setAAD(this.aad(owner.id));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(connection), "utf8"),
      cipher.final(),
    ]);
    const envelope = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const target = this.filename(owner.id),
      temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, envelope, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async remove(userId: number) {
    this.memory.delete(userId);
    if (this.options.key)
      await fs.unlink(this.filename(userId)).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

let singleton: SalesforceConnectionStore | undefined;
export function salesforceStore() {
  if (!singleton) {
    const secret = process.env.SALESFORCE_TOKEN_ENCRYPTION_KEY?.trim();
    const key = secret ? Buffer.from(secret, "base64") : undefined;
    if (secret && (key?.length !== 32 || key.toString("base64") !== secret))
      throw new Error(
        "SALESFORCE_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key"
      );
    const instance = new URL(process.env.SALESFORCE_LOGIN_URL!).origin;
    singleton = new SalesforceConnectionStore({
      directory: path.resolve(".localvoice-private/salesforce"),
      key,
      instance,
      binding: createHash("sha256")
        .update(`${instance}:${process.env.SALESFORCE_CLIENT_ID?.trim()}`)
        .digest("hex"),
    });
  }
  return singleton;
}
