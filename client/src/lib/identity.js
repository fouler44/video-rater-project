import { v4 as uuidv4 } from "uuid";

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
    if (parsed?.uuid && parsed?.displayName) {
      return {
        uuid: parsed.uuid,
        displayName: String(parsed.displayName).trim(),
        avatarUrl: normalizeAvatar(parsed.avatarUrl) || getDefaultAvatar(parsed.displayName),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveIdentity(input, maybeAvatarUrl) {
  const nextDisplayName =
    typeof input === "string" ? input : String(input?.displayName || "");
  const nextAvatarUrl =
    typeof input === "string" ? maybeAvatarUrl : input?.avatarUrl;

  const trimmedName = String(nextDisplayName || "").trim();
  if (!trimmedName) return null;

  const existing = getIdentity();

  const shouldReuseUuid =
    existing &&
    normalizeName(existing.displayName) === normalizeName(trimmedName);

  const identity = {
    uuid: shouldReuseUuid ? existing.uuid : uuidv4(),
    displayName: trimmedName,
    avatarUrl: normalizeAvatar(nextAvatarUrl) || getDefaultAvatar(trimmedName),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
