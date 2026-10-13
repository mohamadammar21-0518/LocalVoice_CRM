import { useState } from "react";
import { ArrowUpRight, Eye, EyeOff, Mic, ShieldCheck, Sparkles } from "lucide-react";
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
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await startLogin(username, password);
      if (result.ok) {
        // Reload to flush the in-memory query cache and start fresh.
        window.location.replace("/");
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
      <section className="auth-intro" aria-hidden="true">
        <div className="auth-brand"><div className="brand-mark"><Sparkles className="h-4 w-4" /></div><span>LocalVoice</span></div>
        <p className="eyebrow">Private CRM workspace</p>
        <h1>Every customer conversation, ready when you need it.</h1>
        <p>Build a CRM around your workflow. Speak updates naturally. Review every action before it is saved.</p>
        <div className="auth-feature-list"><span><Mic size={15} /> Voice-first updates</span><span><ShieldCheck size={15} /> Private local data</span></div>
        <div className="auth-visual"><div className="auth-grid-lines" /><div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /><div className="auth-signal"><span /><span /><span /></div></div>
      </section>
      <div className="auth-card auth-card-enter">
        <div className="auth-card-mark"><div className="brand-mark"><Sparkles className="h-4 w-4" /></div><span className="auth-status"><i /> Secure local sign-in</span></div>
        <p className="eyebrow">Welcome back</p>
        <h2>Enter your workspace.</h2>
        <p>Sign in to continue to your private CRM command centre.</p>

        <form onSubmit={handleLogin} className="flex flex-col gap-3 mt-5">
          <Input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <div className="password-wrap">
            <Input
              type={showPassword ? "text" : "password"}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
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
