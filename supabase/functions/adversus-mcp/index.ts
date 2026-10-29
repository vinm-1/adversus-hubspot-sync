// Adversus-kopplingen till Claude (custom connector, remote MCP) i Supabase Edge Functions.
// Inloggning: OAuth 2.1 med PKCE. Claude skickar dig till /authorize, där du anger
// CONNECTOR_PASSWORD. Inga tokens sparas: de är signerade och tidsbegränsade.
import {
  ALLOWED_REDIRECTS,
  handleRpc,
  isRealLead,
  safeEqual,
  sha256b64url,
  signToken,
  tokenSecret,
  verifyToken,
} from './lib.js';

const ADVERSUS = Deno.env.get('ADVERSUS_BASE_URL') ?? 'https://api.adversus.dk/v1';
const PASSWORD = Deno.env.get('CONNECTOR_PASSWORD') ?? '';
const BASE = (Deno.env.get('PUBLIC_URL') ?? '').replace(/\/$/, ''); // https://<ref>.supabase.co/functions/v1/adversus-mcp

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

// Leads cachas i 15 minuter, så att Claude inte äter upp Adversus timgräns (synken behöver den också).
let cache: { at: number; leads: unknown[] } | null = null;
async function getLeads() {
  if (cache && Date.now() - cache.at < 15 * 60_000) return cache.leads;
  const auth = 'Basic ' + btoa(`${Deno.env.get('ADVERSUS_USER')}:${Deno.env.get('ADVERSUS_PASSWORD')}`);
  const all: any[] = [];
  const seen = new Set();
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${ADVERSUS}/leads?page=${page}&pageSize=1000`, { headers: { Authorization: auth } });
    if (!res.ok) {
      if (cache) return cache.leads; // hellre lite gammal data än inget svar
      throw new Error(`Adversus svarade ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const leads = (await res.json()).leads ?? [];
    const fresh = leads.filter((l: any) => !seen.has(l.id));
    fresh.forEach((l: any) => seen.add(l.id));
    all.push(...fresh);
    if (!fresh.length || leads.length < 1000) break;
  }
  cache = { at: Date.now(), leads: all.filter(isRealLead) };
  return cache.leads;
}

const authServerMeta = () => ({
  issuer: BASE,
  authorization_endpoint: `${BASE}/authorize`,
  token_endpoint: `${BASE}/token`,
  registration_endpoint: `${BASE}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: ['adversus.read'],
});

const loginPage = (q: URLSearchParams, error = '') => `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Adversus för Claude</title>
<style>body{font-family:system-ui,sans-serif;max-width:360px;margin:15vh auto;padding:0 16px}
input,button{width:100%;padding:12px;margin-top:8px;font-size:16px;box-sizing:border-box}button{cursor:pointer}
.err{color:#b00020}</style></head><body><h2>Koppla Adversus till Claude</h2>
<p>Ange lösenordet för kopplingen.</p>${error ? `<p class="err">${error}</p>` : ''}
<form method="post">${[...q].map(([k, v]) => `<input type="hidden" name="${k}" value="${v.replace(/"/g, '&quot;')}">`).join('')}
<input type="password" name="password" placeholder="Lösenord" autofocus required><button>Logga in</button></form></body></html>`;

async function authorize(req: Request, url: URL) {
  const q = req.method === 'POST' ? new URLSearchParams(await req.text()) : url.searchParams;
  const redirect = q.get('redirect_uri') ?? '';
  if (!ALLOWED_REDIRECTS.includes(redirect)) return new Response('Otillåten redirect_uri', { status: 400 });
  if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
    return new Response('Kräver response_type=code och PKCE (S256)', { status: 400 });
  }
  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (req.method === 'GET') return html(loginPage(q));
  if (!PASSWORD || !safeEqual(q.get('password') ?? '', PASSWORD)) {
    q.delete('password');
    return html(loginPage(q, 'Fel lösenord.'), 401);
  }
  const code = await signToken(
    { typ: 'code', ch: q.get('code_challenge'), ru: redirect, cid: q.get('client_id') },
    await tokenSecret(PASSWORD),
    300,
  );
  const back = new URL(redirect);
  back.searchParams.set('code', code);
  if (q.get('state')) back.searchParams.set('state', q.get('state')!);
  return Response.redirect(back.toString(), 302);
}

async function token(req: Request) {
  const f = new URLSearchParams(await req.text());
  const secret = await tokenSecret(PASSWORD);
  const issue = async () => json({
    access_token: await signToken({ typ: 'access' }, secret, 3600),
    refresh_token: await signToken({ typ: 'refresh' }, secret, 30 * 24 * 3600),
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'adversus.read',
  }, 200, { 'Cache-Control': 'no-store' });

  if (f.get('grant_type') === 'authorization_code') {
    const code = await verifyToken(f.get('code'), secret, 'code');
    if (!code || code.ru !== f.get('redirect_uri') || code.ch !== (await sha256b64url(f.get('code_verifier') ?? ''))) {
      return json({ error: 'invalid_grant' }, 400);
    }
    return issue();
  }
  if (f.get('grant_type') === 'refresh_token') {
    if (!(await verifyToken(f.get('refresh_token'), secret, 'refresh'))) return json({ error: 'invalid_grant' }, 400);
    return issue();
  }
  return json({ error: 'unsupported_grant_type' }, 400);
}

Deno.serve(async (req) => {
  if (!BASE || !PASSWORD) return new Response('PUBLIC_URL och CONNECTOR_PASSWORD måste vara satta', { status: 500 });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/adversus-mcp/, '') || '/';
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } });

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    return json({ resource: BASE, authorization_servers: [BASE], scopes_supported: ['adversus.read'], bearer_methods_supported: ['header'] });
  }
  if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) {
    return json(authServerMeta());
  }
  if (path === '/register' && req.method === 'POST') {
    // Dynamisk klientregistrering: vi litar inte på klienten, bara på lösenord + PKCE + redirect-listan.
    const meta = await req.json().catch(() => ({}));
    return json({ ...meta, client_id: crypto.randomUUID(), token_endpoint_auth_method: 'none' }, 201);
  }
  if (path === '/authorize') return authorize(req, url);
  if (path === '/token' && req.method === 'POST') return token(req);

  if (path === '/' && req.method === 'POST') {
    const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!(await verifyToken(bearer, await tokenSecret(PASSWORD), 'access'))) {
      return json({ error: 'invalid_token' }, 401, {
        'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`,
      });
    }
    const body = await req.json().catch(() => null);
    if (!body) return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ogiltig JSON' } }, 400);
    const msgs = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(msgs.map((m) => handleRpc(m, getLeads)))).filter(Boolean);
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  }
  if (path === '/' && req.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: CORS });
  return new Response('Not found', { status: 404, headers: CORS });
});
