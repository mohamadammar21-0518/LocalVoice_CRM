import { AlertCircle, Home } from "lucide-react";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  const handleGoHome = () => {
    setLocation("/");
  };

  return (
    <div className="auth-screen" style={{ gridTemplateColumns: "1fr" }}>
      <div className="auth-card" style={{ textAlign: "center" }}>
        <div className="flex justify-center mb-6">
          <div className="relative">
            <div className="notfound-pulse" />
            <AlertCircle
              className="relative h-16 w-16"
              style={{ color: "var(--purple-600)" }}
            />
          </div>
        </div>

        <h1 className="notfound-code">404</h1>

        <h2 className="notfound-title">Page Not Found</h2>

        <p className="text-slate-600 mb-8 leading-relaxed" style={{ color: "#948999", fontSize: "13px", lineHeight: 1.7 }}>
          Sorry, the page you are looking for doesn't exist.
          <br />
          It may have been moved or deleted.
        </p>

        <div
          id="not-found-button-group"
          className="flex flex-col sm:flex-row gap-3 justify-center"
        >
          <button
            onClick={handleGoHome}
            className="primary-button"
            style={{ display: "inline-flex", alignItems: "center", gap: "8px", padding: "10px 24px" }}
          >
            <Home className="w-4 h-4" />
            Go Home
          </button>
        </div>
      </div>
    </div>
  );
}
