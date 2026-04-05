import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { apiPost } from "../lib/api";
import { clearIdentity, getDefaultAvatar, getIdentity, saveIdentity } from "../lib/identity";

export default function AuthPage() {
  const navigate = useNavigate();
  const [identity, setIdentity] = useState(getIdentity());
  const [displayName, setDisplayName] = useState(identity?.displayName || "");
  const [avatarUrl, setAvatarUrl] = useState(identity?.avatarUrl || "");
  const [username, setUsername] = useState(identity?.username || "");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("login");
  const [authLoading, setAuthLoading] = useState(false);
  const [uiNotice, setUiNotice] = useState(null);

  useEffect(() => {
    const current = getIdentity();
    setIdentity(current);
    setDisplayName(current?.displayName || "");
    setAvatarUrl(current?.avatarUrl || "");
    setUsername(current?.username || "");
  }, []);

  useEffect(() => {
    if (!uiNotice) return;

    const timeout = window.setTimeout(() => {
      setUiNotice(null);
    }, 3600);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [uiNotice]);

  async function submitAuth() {
    const safeUsername = username.trim().toLowerCase();
    const safePassword = password.trim();
    const safeDisplayName = displayName.trim();

    if (!safeUsername || !safePassword) {
      showNotice("Username and password are required", "warning");
      return;
    }

    if (authMode === "register" && !safeDisplayName) {
      showNotice("Display name is required for register", "warning");
      return;
    }

    setAuthLoading(true);
    try {
      const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
      const payload = authMode === "register"
        ? {
            username: safeUsername,
            password: safePassword,
            displayName: safeDisplayName,
            avatarUrl,
          }
        : {
            username: safeUsername,
            password: safePassword,
          };

      const data = await apiPost(path, payload, { auth: false });
      const saved = saveIdentity(data);
      setIdentity(saved);
      setDisplayName(saved?.displayName || safeDisplayName);
      setAvatarUrl(saved?.avatarUrl || avatarUrl);
      setUsername(saved?.username || safeUsername);
      setPassword("");
      showNotice(authMode === "register" ? "Account created" : "Logged in", "success");
      navigate("/");
    } catch (err) {
      showNotice(err.message || "Authentication failed", "error");
    } finally {
      setAuthLoading(false);
    }
  }

  function showNotice(message, tone = "error") {
    setUiNotice({ message: String(message || "Unexpected error"), tone });
  }

  function logout() {
    clearIdentity();
    setIdentity(null);
    setPassword("");
    navigate("/");
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-12">
      <section className="card">
        {uiNotice ? (
          <div
            className={`mb-4 text-sm px-4 py-3 rounded-xl border flex items-start gap-3 animate-fade-in ${
              uiNotice.tone === "success"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-100"
                : uiNotice.tone === "warning"
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-100"
            }`}
            role="alert"
          >
            {uiNotice.tone === "success" ? (
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            )}
            <span className="flex-1">{uiNotice.message}</span>
            <button
              type="button"
              className="p-1 rounded-md hover:bg-black/20 transition-colors"
              onClick={() => setUiNotice(null)}
              aria-label="Close notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-xl font-bold">Login / Register</h2>
          <button className="btn-ghost flex items-center gap-2" onClick={() => navigate("/")}>
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
        </div>

        <p className="muted mb-4">Manage your account access from this tab.</p>

        <div className="grid grid-cols-2 gap-2 mb-3">
          <button
            className={`btn-secondary ${authMode === "login" ? "bg-slate-700 text-white" : ""}`}
            onClick={() => setAuthMode("login")}
            disabled={authLoading}
          >
            Login
          </button>
          <button
            className={`btn-secondary ${authMode === "register" ? "bg-slate-700 text-white" : ""}`}
            onClick={() => setAuthMode("register")}
            disabled={authLoading}
          >
            Register
          </button>
        </div>

        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          className="mb-3"
          autoCapitalize="off"
          autoCorrect="off"
        />

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mb-3"
        />

        <div className="flex items-center gap-3 mb-4">
          <img
            src={avatarUrl.trim() || getDefaultAvatar(displayName)}
            alt="Avatar preview"
            className="w-12 h-12 rounded-full object-cover border border-slate-700 bg-slate-900"
            referrerPolicy="no-referrer"
          />
          <div className="text-xs text-slate-500">
            Your avatar appears in the room and chat.
          </div>
        </div>

        {authMode === "register" && (
          <>
            <div className="relative mb-3">
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Display name"
                className="pl-10"
              />
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            </div>
            <input
              value={avatarUrl}
              onChange={(e) => setAvatarUrl(e.target.value)}
              placeholder="Avatar URL (optional)"
              className="mb-3"
            />
          </>
        )}

        <button
          className="btn-primary w-full"
          onClick={submitAuth}
          disabled={authLoading}
        >
          {authLoading ? "Please wait..." : authMode === "register" ? "Create account" : "Login"}
        </button>

        {identity && (
          <button className="btn-ghost w-full mt-3" onClick={logout}>
            Logout ({identity.username || identity.displayName})
          </button>
        )}
      </section>
    </div>
  );
}
