import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";

// Generates private runtime configuration; never prints secrets or overwrites it.
const filename = ".env.twenty";
try {
  await fs.writeFile(filename, [
    "# Generated local Twenty configuration. Keep private and preserve these keys.",
    "TWENTY_IMAGE=twentycrm/twenty:v2.45.0",
    `TWENTY_DB_PASSWORD=${randomBytes(32).toString("hex")}`,
    `TWENTY_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
  console.log("Created .env.twenty with generated secrets. Image is release-pinned, pending local runtime testing.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  console.log("Existing .env.twenty preserved.");
}
