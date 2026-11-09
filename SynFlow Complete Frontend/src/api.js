const BASE = import.meta.env.VITE_API_URL || '/api';

// A structured error keeps HTTP status and safe backend fields without ever
// surfacing raw server internals to the UI.
export class ApiError extends Error {
  constructor(message, { status = 0, body = null, retryAfterSeconds = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retrySeconds(response, body) {
  const fromBody = Number(body && body.retryAfterSeconds);
  if (Number.isFinite(fromBody) && fromBody > 0) return fromBody;

  const header = response.headers.get('Retry-After');
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;

  return null;
}

async function req(path, opts) {
  let response;
  try {
    response = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
  } catch {
    throw new ApiError('Network request failed', { status: 0 });
  }

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }

  if (!response.ok) {
    throw new ApiError((body && body.error) || response.statusText || 'Request failed', {
      status: response.status,
      body,
      retryAfterSeconds: retrySeconds(response, body),
    });
  }

  return body;
}

export const api = {
  list: () => req('/experiments'),
  start: () => req('/experiments', { method: 'POST' }),
  get: (id) => req(`/experiments/${id}`),
  compare: (id) => req(`/experiments/${id}/compare`),
  streamUrl: (id) => `${BASE}/experiments/${id}/stream`,
};
