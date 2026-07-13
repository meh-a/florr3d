// Discord OAuth2 login + stateless signed-cookie sessions.
//
// Routes (attach ahead of static file serving):
//   /auth/discord   — redirect to Discord's consent page
//   /auth/callback  — code -> token exchange, upsert account, set session
//   /auth/me        — { loggedIn, username, avatar } for the current cookie
//   /auth/logout    — clear the session cookie
//   /auth/dev       — DEV_AUTH=1 only: fake login without Discord, for tests
//
// Session cookie: `sid=<accountId>.<expiry>.<hmac>` signed with
// SESSION_SECRET — no session table needed. The websocket upgrade handler
// reads the same cookie via sessionFromCookie().
//
// Env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET,
// DISCORD_REDIRECT_URI (defaults to https://<host>/auth/callback).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { upsertAccount, getAccount } from './db.js';

const SESSION_DAYS = 30;
const secret = process.env.SESSION_SECRET || randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('auth: SESSION_SECRET not set — sessions will not survive a restart');
}

const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

function makeSession(accountId) {
  const payload = `${accountId}.${Date.now() + SESSION_DAYS * 86400_000}`;
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  const [accountId, expiry] = payload.split('.');
  if (Date.now() > Number(expiry)) return null;
  return Number(accountId);
}

export function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// account id for a raw Cookie header, or null — used by ws.js on upgrade
export function sessionFromCookie(cookieHeader) {
  return verifySession(parseCookies(cookieHeader).sid);
}

const setSession = (res, token) => res.setHeader('Set-Cookie',
  `sid=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`);

const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };
const json = (res, obj) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

// Handles a request if it's an /auth/* route; returns false otherwise so
// the caller falls through to its own routing (static files, etc.).
export async function handleAuth(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/auth/')) return false;

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI
    || `https://${req.headers.host}/auth/callback`;

  switch (url.pathname) {
    case '/auth/discord': {
      if (!clientId) { res.writeHead(503); res.end('login not configured'); return true; }
      const q = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri,
        response_type: 'code', scope: 'identify', prompt: 'none',
      });
      redirect(res, `https://discord.com/oauth2/authorize?${q}`);
      return true;
    }

    case '/auth/callback': {
      const code = url.searchParams.get('code');
      if (!code || !clientId) return redirect(res, '/'), true;
      try {
        // the server-side half: code -> token -> who is this
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId, client_secret: clientSecret,
            grant_type: 'authorization_code', code, redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
        const { access_token } = await tokenRes.json();
        const userRes = await fetch('https://discord.com/api/users/@me', {
          headers: { authorization: `Bearer ${access_token}` },
        });
        if (!userRes.ok) throw new Error(`users/@me ${userRes.status}`);
        const user = await userRes.json();
        const account = upsertAccount({
          discordId: user.id,
          username: user.global_name || user.username,
          avatar: user.avatar,
        });
        setSession(res, makeSession(account.id));
      } catch (err) {
        console.error('auth: discord login failed —', err.message);
      }
      redirect(res, '/');
      return true;
    }

    case '/auth/me': {
      const accountId = sessionFromCookie(req.headers.cookie);
      const account = accountId != null ? getAccount(accountId) : null;
      json(res, account
        ? { loggedIn: true, username: account.username, avatar: account.avatar }
        : { loggedIn: false });
      return true;
    }

    case '/auth/logout': {
      res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
      redirect(res, '/');
      return true;
    }

    case '/auth/dev': {
      // test-only fake login, never enabled in production
      if (process.env.DEV_AUTH !== '1') { res.writeHead(404); res.end(); return true; }
      const account = upsertAccount({
        discordId: `dev:${url.searchParams.get('id') || 'tester'}`,
        username: url.searchParams.get('name') || 'DevTester',
        avatar: null,
      });
      setSession(res, makeSession(account.id));
      json(res, { loggedIn: true, username: account.username });
      return true;
    }

    default:
      res.writeHead(404);
      res.end();
      return true;
  }
}
