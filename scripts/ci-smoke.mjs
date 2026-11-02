import assert from "node:assert/strict";

const origin = process.env.APP_ORIGIN || "http://127.0.0.1:3000";
const username = process.env.LOCAL_ADMIN_USERNAME || "admin";
const password = process.env.LOCAL_ADMIN_PASSWORD;
assert.ok(password, "LOCAL_ADMIN_PASSWORD is required");

async function request(path, options = {}) {
  return fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(10_000) });
}

let login;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    login = await request("/api/auth/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (login.status === 200) break;
  } catch { /* Wait for the app to bind its port. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.equal(login?.status, 200, "Administrator login must succeed");
const cookie = login.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "Login must set a session cookie");

const anonymous = await request("/api/trpc/contacts.list");
assert.equal(anonymous.status, 401, "Anonymous CRM read must be rejected");
const dashboard = await request("/api/trpc/dashboard.get", { headers: { Cookie: cookie } });
assert.equal(dashboard.status, 200, "Authenticated CRM read must succeed");
assert.ok((await dashboard.json()).result?.data, "CRM response must contain data");
console.log("PASS: login, session cookie, authenticated CRM read, anonymous rejection");
