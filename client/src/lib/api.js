import { getAuthToken } from "./identity";
import { APP_ENV } from "./env";

const API_BASE = APP_ENV.apiBaseUrl;

async function parseError(response) {
  const text = await response.text();
  if (!text) return `Request failed (${response.status})`;

  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error || text);
  } catch {
    return text;
  }
}

function buildHeaders(extraHeaders = {}, useAuth = true) {
  const headers = { ...extraHeaders };
  if (useAuth) {
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export async function apiGet(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: buildHeaders({}, options.auth !== false),
  });
  if (!response.ok) throw new Error(await parseError(response));
  return response.json();
}

export async function apiPost(path, payload, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "application/json" }, options.auth !== false),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await parseError(response));

  if (response.status === 204) return null;
  return response.json();
}

export async function apiDelete(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: buildHeaders({}, options.auth !== false),
  });

  if (!response.ok) throw new Error(await parseError(response));
  if (response.status === 204) return null;
  return response.json();
}

export { API_BASE };
