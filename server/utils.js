let nextUid = 1;
export function uid() { return nextUid++; }

// frame-rate independent lerp factor
export function damp(k, dt) { return 1 - Math.exp(-k * dt); }

// Caddy fronts the game in production, so the peer address is always
// localhost — the real client is the first X-Forwarded-For hop. In dev
// there's no proxy and the socket address is the client itself. Shared by
// ws.js (connection ip) and the /join-token route (mint ip) so a token is
// checked against the same address it was minted for.
export const clientIp = (req) =>
  req.headers['x-forwarded-for']?.split(',')[0].trim()
  || req.socket.remoteAddress;
