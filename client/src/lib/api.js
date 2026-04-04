import { getAuthToken } from "./identity";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

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
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export async function apiPost(path, payload, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: buildHeaders({ "Content-Type": "application/json" }, options.auth !== false),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await response.text());

  if (response.status === 204) return null;
  return response.json();
}

export async function apiDelete(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    headers: buildHeaders({}, options.auth !== false),
  });

  if (!response.ok) throw new Error(await response.text());
  if (response.status === 204) return null;
  return response.json();
}

export { API_BASE };
