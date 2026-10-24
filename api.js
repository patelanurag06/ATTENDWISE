let csrfToken = "";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(path, { method = "GET", body, csrf = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The AttendWise backend is unavailable. Start the API server on port 8000 and try again.", 0);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("The backend returned an invalid response. Restart the API server and try again.", response.status);
  }
  if (!response.ok) {
    if (response.status === 401) csrfToken = "";
    throw new ApiError(payload.error ?? "The request could not be completed.", response.status);
  }
  return payload;
}

export async function getPortalSession() {
  const payload = await request("/api/auth/me");
  csrfToken = payload.csrfToken;
  return payload.user;
}

export async function signIn(email, password) {
  await request("/api/auth/login", {
    method: "POST",
    body: { email, password },
    csrf: false,
  });
  return getPortalSession();
}

export async function signOut() {
  await request("/api/auth/logout", { method: "POST" });
  csrfToken = "";
}

export function apiGet(path) {
  return request(path);
}

export function apiPost(path, body) {
  return request(path, { method: "POST", body });
}

export function apiPut(path, body) {
  return request(path, { method: "PUT", body });
}
