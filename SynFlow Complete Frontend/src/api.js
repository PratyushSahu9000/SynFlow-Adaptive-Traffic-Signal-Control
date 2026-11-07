const BASE = import.meta.env.VITE_API_URL || '/api';

async function req(path, opts) {
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

export const api = {
  list: () => req('/experiments'),
  start: () => req('/experiments', { method: 'POST' }),
  get: (id) => req(`/experiments/${id}`),
  compare: (id) => req(`/experiments/${id}/compare`),
  streamUrl: (id) => `${BASE}/experiments/${id}/stream`,
};
