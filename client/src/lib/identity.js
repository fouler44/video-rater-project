const STORAGE_KEY = "aor_identity";
const DEFAULT_AVATAR_BASE = "https://api.dicebear.com/9.x/thumbs/svg";

function normalizeName(value = "") {
  return String(value).trim().toLowerCase();
}

function normalizeAvatar(value = "") {
  const trimmed = String(value || "").trim();
  return trimmed || "";
}

export function getDefaultAvatar(displayName = "") {
  const fallbackSeed = normalizeName(displayName) || "guest";
  return `${DEFAULT_AVATAR_BASE}?seed=${encodeURIComponent(fallbackSeed)}`;
}

export function getIdentity() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.token || !parsed?.user?.id || !parsed?.user?.displayName) return null;

    return {
      token: String(parsed.token),
      expiresAt: parsed.expiresAt || null,
      userId: String(parsed.user.id),
      username: String(parsed.user.username || ""),
      displayName: String(parsed.user.displayName).trim(),
      avatarUrl: normalizeAvatar(parsed.user.avatarUrl) || getDefaultAvatar(parsed.user.displayName),
      role: String(parsed.user.role || "user"),
    };
  } catch {
    return null;
  }
}

export function saveIdentity(sessionPayload) {
  const token = String(sessionPayload?.token || "").trim();
  const user = sessionPayload?.user;
  const displayName = String(user?.displayName || "").trim();
  if (!token || !user?.id || !displayName) return null;

  const identity = {
    token,
    expiresAt: sessionPayload?.expiresAt || null,
    user: {
      id: String(user.id),
      username: String(user.username || ""),
      displayName,
      avatarUrl: normalizeAvatar(user.avatarUrl) || getDefaultAvatar(displayName),
      role: String(user.role || "user"),
    },
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return getIdentity();
}

export function patchIdentityUser(nextUser = {}) {
  const current = getIdentity();
  if (!current) return null;

  return saveIdentity({
    token: current.token,
    expiresAt: current.expiresAt,
    user: {
      id: current.userId,
      username: current.username,
      displayName: nextUser.displayName || current.displayName,
      avatarUrl: nextUser.avatarUrl ?? current.avatarUrl,
      role: nextUser.role || current.role,
    },
  });
}

export function getAuthToken() {
  return getIdentity()?.token || "";
}

export function clearIdentity() {
  localStorage.removeItem(STORAGE_KEY);
}
