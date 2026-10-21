// The server serves the UI and the WebSocket on the same port. Under `vite dev` the UI is on
// another port, so point at the server's default port instead.
export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = import.meta.env.DEV ? `${location.hostname}:8080` : location.host;
  return `${proto}://${host}`;
}
