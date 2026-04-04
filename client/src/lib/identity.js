import { v4 as uuidv4 } from "uuid";

const STORAGE_KEY = "aor_identity";

function normalizeName(value = "") {
  return String(value).trim().toLowerCase();
}

export function getIdentity() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.uuid && parsed?.displayName) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveIdentity(displayName) {
  const trimmedName = String(displayName || "").trim();
  if (!trimmedName) return null;

  const existing = getIdentity();

  const shouldReuseUuid =
    existing &&
    normalizeName(existing.displayName) === normalizeName(trimmedName);

  const identity = {
    uuid: shouldReuseUuid ? existing.uuid : uuidv4(),
    displayName: trimmedName,
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}
