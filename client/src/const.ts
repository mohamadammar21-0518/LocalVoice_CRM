export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Local login — calls the local auth endpoint instead of Manus OAuth.
 * Returns true on success, false on failure.
 */
export const startLogin = async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
  const resp = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });
  if (resp.ok) {
    return { ok: true };
  }
  const body = await resp.json().catch(() => ({})) as { error?: string };
  return { ok: false, error: body.error ?? "Login failed" };
};
