import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, User, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { apiPost } from "../lib/api";
import { clearIdentity, getDefaultAvatar, getIdentity, patchIdentityUser, saveIdentity } from "../lib/identity";

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
  const signedIn = Boolean(identity?.token && identity?.userId);
  const isRegisterMode = authMode === "register";

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
      setAuthMode("login");
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
    setAuthMode("login");
    navigate("/");
  }

  async function saveProfile() {
    if (!identity?.token || !identity?.userId) {
      showNotice("Login first to update your profile", "warning");
      return;
    }

    const trimmedDisplayName = displayName.trim();
    if (!trimmedDisplayName) {
      showNotice("Display name cannot be empty", "warning");
      return;
    }

    setAuthLoading(true);
    try {
      const data = await apiPost("/api/auth/profile", {
        displayName: trimmedDisplayName,
        avatarUrl,
      });

      const savedIdentity = patchIdentityUser(data.user);
      setIdentity(savedIdentity);
      setDisplayName(savedIdentity?.displayName || trimmedDisplayName);
      setAvatarUrl(savedIdentity?.avatarUrl || avatarUrl);
      setUsername(savedIdentity?.username || username);
      showNotice("Profile updated", "success");
    } catch (err) {
      showNotice(err.message || "Could not save profile", "error");
    } finally {
      setAuthLoading(false);
    }
  }

  return (
    <div className="relative mx-auto max-w-5xl px-4 py-10 md:px-6 md:py-16">
      <section className="overflow-hidden rounded-[32px] border border-slate-700/70 bg-slate-900/55 shadow-2xl shadow-slate-950/50">
        <div className="grid gap-0 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="border-b border-slate-700/70 px-6 py-7 sm:px-8 lg:border-b-0 lg:border-r lg:px-10 lg:py-10">
            <span className="eyebrow">Account</span>
            <h1 className="max-w-sm text-3xl sm:text-4xl">Keep your room identity ready.</h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-slate-300 sm:text-base">
              Sign in to host rooms, save your profile, and come back to the lobby already set up for the next call.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">What you get</p>
                <p className="mt-2 text-sm text-slate-200">Host rooms, keep your avatar, and jump back into the same name across sessions.</p>
              </div>
              <div className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">After sign in</p>
                <p className="mt-2 text-sm text-slate-200">The login/register switch hides and the page becomes profile-only.</p>
              </div>
            </div>
          </div>

          <div className="px-6 py-7 sm:px-8 lg:px-10 lg:py-10">
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

            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold text-slate-100">
                  {signedIn ? "Profile" : isRegisterMode ? "Create account" : "Login"}
                </h2>
                <p className="mt-1 text-sm text-slate-400">
                  {signedIn
                    ? "Your account is active. Update your profile below or log out."
                    : isRegisterMode
                      ? "Create your room identity once, then use it in every session."
                      : "Log in to host rooms and keep your identity synced."}
                </p>
              </div>
              <button className="btn-ghost flex items-center gap-2" onClick={() => navigate("/") }>
                <ArrowLeft className="w-4 h-4" />
                Back
              </button>
            </div>

            {identity ? (
              <div className="mb-5 rounded-2xl border border-slate-700/70 bg-slate-900/55 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-bold uppercase tracking-[0.12em] text-slate-300">Profile</h3>
                  <span className="text-xs text-slate-500">Shown in room roster and chat</span>
                </div>

                <div className="flex items-center gap-3 mb-3">
                  <img
                    src={avatarUrl.trim() || getDefaultAvatar(displayName)}
                    alt="Avatar preview"
                    className="w-12 h-12 rounded-full object-cover border border-slate-700 bg-slate-900"
                    referrerPolicy="no-referrer"
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-100">{displayName.trim() || "Unnamed Player"}</p>
                    <p className="text-xs text-slate-500">{username ? `@${username}` : "Signed in"}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="relative">
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
                  />
                  <button
                    className="btn-secondary w-full"
                    onClick={saveProfile}
                    disabled={authLoading || !displayName.trim()}
                  >
                    {authLoading ? "Saving..." : "Save profile"}
                  </button>
                </div>
              </div>
            ) : null}

            {!signedIn ? (
              <>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <button
                    className={`btn-secondary ${!isRegisterMode ? "bg-slate-700 text-white" : ""}`}
                    onClick={() => setAuthMode("login")}
                    disabled={authLoading}
                  >
                    Login
                  </button>
                  <button
                    className={`btn-secondary ${isRegisterMode ? "bg-slate-700 text-white" : ""}`}
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

                {isRegisterMode ? (
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
                ) : null}

                <div className="mb-4 flex items-center gap-3">
                  <img
                    src={avatarUrl.trim() || getDefaultAvatar(displayName)}
                    alt="Avatar preview"
                    className="w-12 h-12 rounded-full object-cover border border-slate-700 bg-slate-900"
                    referrerPolicy="no-referrer"
                  />
                  <div className="text-xs text-slate-500">Your avatar appears in the room and chat.</div>
                </div>

                <button
                  className="btn-primary w-full"
                  onClick={submitAuth}
                  disabled={authLoading}
                >
                  {authLoading ? "Please wait..." : isRegisterMode ? "Create account" : "Login"}
                </button>
              </>
            ) : (
              <div className="space-y-3">
                <button className="btn-ghost w-full" onClick={() => navigate("/") }>
                  Back to lobby
                </button>
                <button className="btn-ghost w-full" onClick={logout}>
                  Logout ({identity.username || identity.displayName})
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
