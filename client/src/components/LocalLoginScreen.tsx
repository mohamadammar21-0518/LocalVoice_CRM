import { useState } from "react";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { startLogin } from "@/const";

/**
 * Full-page login form shown when the user has no active session.
 * On success the page reloads to hydrate the authenticated workspace.
 */
export function LocalLoginScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await startLogin(username, password);
      if (result.ok) {
        // Reload to flush the in-memory query cache and start fresh.
        window.location.reload();
      } else {
        setError(result.error ?? "Invalid credentials");
      }
    } catch {
      setError("Login failed — check the server is running");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand-mark">
          <Sparkles className="h-4 w-4" />
        </div>
        <p className="eyebrow">Lumen personal CRM</p>
        <h1>A quieter way to remember.</h1>
        <p>Keep people, context, and promises close in one private workspace.</p>

        <form onSubmit={handleLogin} className="flex flex-col gap-3 mt-5">
          <Input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="primary-button w-full"
            disabled={loading || !username || !password}
          >
            {loading ? (
              "Signing in…"
            ) : (
              <>
                Enter your workspace <ArrowUpRight className="h-4 w-4" />
              </>
            )}
          </Button>
        </form>

        <p className="text-xs text-muted-foreground mt-4 text-center">
          Ask your CRM administrator for an account.
        </p>
      </div>
    </div>
  );
}
