import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { SalesforceConnectionStore } from "./salesforceStore";

const directories: string[] = [];
const owner = { id: 7, sessionVersion: 2 };
const connection = {
  version: 2,
  accessToken: "secret-access-token",
  refreshToken: "secret-refresh-token",
  instance: "https://demo.my.salesforce.com",
};
async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "localvoice-sf-test-")
  );
  directories.push(directory);
  const options = {
    directory,
    key: randomBytes(32),
    binding: "test-org-client",
    instance: connection.instance,
  };
  return { options, store: new SalesforceConnectionStore(options) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith("localvoice-sf-test-")
    )
      throw new Error("Unsafe test cleanup path");
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("encrypted Salesforce connection storage", () => {
  it("survives a new store instance without writing tokens in plaintext", async () => {
    const { store, options } = await fixture();
    await store.save(owner, connection);
    const raw = await fs.readFile(
      path.join(options.directory, "7.json"),
      "utf8"
    );
    expect(raw).not.toContain(connection.accessToken);
    expect(raw).not.toContain(connection.refreshToken);
    expect(await new SalesforceConnectionStore(options).load(owner)).toEqual(
      connection
    );
    await store.save(owner, { ...connection, refreshToken: "rotated-refresh" });
    expect(
      await new SalesforceConnectionStore(options).load(owner)
    ).toMatchObject({ refreshToken: "rotated-refresh" });
  });
  it("rejects copied, tampered, wrong-key and wrong-organisation ciphertext", async () => {
    const { store, options } = await fixture();
    await store.save(owner, connection);
    await fs.copyFile(
      path.join(options.directory, "7.json"),
      path.join(options.directory, "8.json")
    );
    await expect(store.load({ ...owner, id: 8 })).rejects.toThrow(
      "Saved Salesforce connection is unavailable"
    );
    await expect(
      new SalesforceConnectionStore({ ...options, key: randomBytes(32) }).load(
        owner
      )
    ).rejects.toThrow();
    await expect(
      new SalesforceConnectionStore({
        ...options,
        binding: "another-client",
      }).load(owner)
    ).rejects.toThrow();
    const file = path.join(options.directory, "7.json"),
      envelope = JSON.parse(await fs.readFile(file, "utf8"));
    const data = Buffer.from(envelope.data, "base64");
    data[0] ^= 1;
    envelope.data = data.toString("base64");
    await fs.writeFile(file, JSON.stringify(envelope));
    await expect(store.load(owner)).rejects.toThrow();
  });
  it("invalidates revoked sessions without letting an older request delete a newer connection", async () => {
    const { store } = await fixture();
    await store.save(owner, connection);
    expect(await store.load({ ...owner, sessionVersion: 1 })).toBeUndefined();
    expect(await store.load(owner)).toEqual(connection);
    expect(await store.load({ ...owner, sessionVersion: 3 })).toBeUndefined();
    expect(await store.load(owner)).toBeUndefined();
  });
  it("serializes refresh and disconnect so a late refresh cannot restore disconnected tokens", async () => {
    const { store } = await fixture();
    await store.save(owner, connection);
    let started!: () => void, finish!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const gate = new Promise<void>(resolve => {
      finish = resolve;
    });
    const refresh = store.exclusive(owner.id, async () => {
      started();
      await gate;
      await store.save(owner, { ...connection, accessToken: "rotated" });
    });
    await ready;
    const disconnect = store.exclusive(owner.id, () => store.remove(owner.id));
    finish();
    await Promise.all([refresh, disconnect]);
    expect(await store.load(owner)).toBeUndefined();
  });
  it("recovers the owner lock after a failed operation", async () => {
    const { store } = await fixture();
    await expect(
      store.exclusive(owner.id, async () => {
        throw new Error("failed");
      })
    ).rejects.toThrow("failed");
    await store.exclusive(owner.id, () => store.save(owner, connection));
    expect(await store.load(owner)).toEqual(connection);
  });
});
