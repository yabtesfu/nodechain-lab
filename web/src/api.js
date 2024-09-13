// Where the node lives. In dev, point at the node's port; in a node-served
// production build, use same-origin. Override with VITE_NODE_URL if needed.
export const API =
  import.meta.env.VITE_NODE_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');

async function req(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

export const getOverview = () => req('/overview');
export const getChain = () => req('/chain');
export const createWallet = () => req('/wallets', { method: 'POST' });
export const sendTransaction = (payload) =>
  req('/transactions/new', { method: 'POST', body: JSON.stringify(payload) });
export const mineOnce = (minerAddress) =>
  req('/mine', { method: 'POST', body: JSON.stringify({ minerAddress }) });
export const startMining = (payload) =>
  req('/mining/start', { method: 'POST', body: JSON.stringify(payload) });
export const stopMining = () => req('/mining/stop', { method: 'POST' });

// Subscribe to the node's live event stream. Returns the EventSource so the
// caller can close it. onEvent(type, data) fires for each named event.
export function openEvents(onEvent, onStatus) {
  const es = new EventSource(`${API}/events`);
  for (const type of ['block:added', 'chain:replaced', 'transaction:added']) {
    es.addEventListener(type, (e) => {
      try {
        onEvent(type, JSON.parse(e.data));
      } catch {
        onEvent(type, null);
      }
    });
  }
  es.onopen = () => onStatus && onStatus(true);
  es.onerror = () => onStatus && onStatus(false);
  return es;
}
