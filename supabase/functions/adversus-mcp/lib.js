// Ren logik för Adversus-kopplingen till Claude (MCP). Ingen Deno- eller nätverkskod här,
// så att den kan testas med Node. Körs i Supabase Edge Functions via index.ts.

export const PROTOCOL_VERSION = '2025-06-18';
export const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

// ---------- Signerade tokens (HMAC-SHA256), ingen databas behövs ----------

const enc = new TextEncoder();

export function b64url(bytes) {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...new Uint8Array(bytes));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function sha256b64url(text) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function signToken(payload, secret, ttlSeconds, now = Date.now()) {
  const body = b64url(unescape(encodeURIComponent(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }))));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyToken(token, secret, type, now = Date.now()) {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig || sig !== (await hmac(secret, body))) return null;
  const payload = JSON.parse(decodeURIComponent(escape(b64urlDecode(body))));
  if (payload.typ !== type || payload.exp < Math.floor(now / 1000)) return null;
  return payload;
}

// Hemligheten som signerar tokens härleds från lösenordet: byts lösenordet blir gamla inloggningar ogiltiga.
export const tokenSecret = (password) => sha256b64url(`adversus-mcp:${password}`);

// Jämförelse i konstant tid för lösenordet.
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// ---------- Adversus-data ----------

const PLACEHOLDERS = new Set(['', '-', '.', ',', 'x', 'c', 'e', 'f', 'r', '?', '0', 'n/a', 'ej hittad']);
const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return PLACEHOLDERS.has(s.toLowerCase()) || /^[,.\s-]+$/.test(s) ? null : s;
};
const fields = (list = []) => Object.fromEntries(list.map((f) => [f.label, f.value]));

const STATUS = {
  success: 'Bokat möte',
  notInterested: 'Inte intresserad',
  unqualified: 'Ej kvalificerad',
  invalid: 'Ogiltig',
  automaticRedial: 'Ring igen (automatiskt)',
  privateRedial: 'Ring igen (bokad återringning)',
};
export const STATUS_KEYS = Object.keys(STATUS);

const TEST_NAMES = /^(test|401$|eztablisher$)/i;
export const isRealLead = (l) => {
  const name = clean(fields(l.masterData)['Företagsnamn']);
  return l.active !== false && !(name && TEST_NAMES.test(name)) && (name || l.masterData?.length);
};

// Kompakt sammanfattning av ett lead för Claude.
export function summarize(lead) {
  const m = fields(lead.masterData);
  const r = fields(lead.resultData);
  const pick = (prefix) => clean(Object.entries(r).find(([k, v]) => k.startsWith(prefix) && clean(v))?.[1]);
  const out = {
    lead_id: lead.id,
    bolag: clean(m['Företagsnamn']),
    orgnr: clean(m['Organisationsnr']),
    kontakt: clean(m['Kontaktperson']),
    titel: clean(m['Befattning']),
    email: clean(m['Email']),
    telefon: clean(m['Direkt nummer']) ?? clean(m['Telefon nummer']),
    linkedin: clean(m['Linkedin länk']),
    status: STATUS[lead.status] ?? lead.status,
    anledning: pick('Anledning'),
    kommentar: pick('Kommentar'),
    aterkoppling: clean(r['Lämplig återkoppling']),
    antal_samtal: Number(lead.contactAttempts) || 0,
    senast_andrad: lead.lastModifiedTime,
    nasta_samtal: lead.nextContactTime,
    moteanteckning: clean(r['Beskrivning']),
    mote_skickat_till: clean(r['Email sent to consultant']),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null && v !== ''));
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s-]/g, '');

function matches(lead, s, q) {
  if (q.status && lead.status !== q.status) return false;
  if (q.sedan && !(Date.parse(lead.lastModifiedTime) >= Date.parse(q.sedan))) return false;
  if (q.fritext) {
    const hay = norm([s.bolag, s.orgnr, s.kontakt, s.titel, s.email, s.kommentar, s.anledning].join(' '));
    if (!norm(q.fritext).split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

// ---------- Verktyg som Claude ser ----------

export const TOOLS = [
  {
    name: 'sok_leads',
    title: 'Sök leads i Adversus',
    description:
      'Söker bland eztablishers prospekteringsleads i Adversus (live). Filtrera på fritext (bolag, org.nr, person, titel, e-post), status och ändrat sedan datum. Svaret är sorterat med senast ändrade först.',
    inputSchema: {
      type: 'object',
      properties: {
        fritext: { type: 'string', description: 'T.ex. bolagsnamn, org.nr eller personnamn' },
        status: { type: 'string', enum: STATUS_KEYS, description: 'success = bokat möte, automaticRedial = inget svar/ring igen, privateRedial = bokad återringning' },
        sedan: { type: 'string', description: 'ISO-datum, t.ex. 2026-10-20. Bara leads ändrade (ringda) efter detta.' },
        max: { type: 'number', description: 'Max antal träffar (standard 25, max 200)' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'hamta_lead',
    title: 'Hämta ett lead',
    description: 'Hämtar allt om ett lead i Adversus via lead-ID, inklusive mötesanteckning.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'number' } }, required: ['lead_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'statistik',
    title: 'Statistik för prospekteringen',
    description:
      'Sammanställning av eztablishers ringande: antal leads per status, totalt antal samtal, och alla bokade möten. Valfritt från ett datum.',
    inputSchema: {
      type: 'object',
      properties: { sedan: { type: 'string', description: 'ISO-datum, t.ex. 2026-10-01' } },
    },
    annotations: { readOnlyHint: true },
  },
];

export function runTool(name, args = {}, leads) {
  const real = leads.filter(isRealLead);
  if (name === 'sok_leads') {
    const max = Math.min(Number(args.max) || 25, 200);
    const hits = real
      .map((l) => [l, summarize(l)])
      .filter(([l, s]) => matches(l, s, args))
      .sort(([a], [b]) => Date.parse(b.lastModifiedTime) - Date.parse(a.lastModifiedTime));
    return { antal_traffar: hits.length, visar: Math.min(max, hits.length), leads: hits.slice(0, max).map(([, s]) => s) };
  }
  if (name === 'hamta_lead') {
    const lead = leads.find((l) => Number(l.id) === Number(args.lead_id));
    return lead ? summarize(lead) : { fel: `Inget lead med ID ${args.lead_id}` };
  }
  if (name === 'statistik') {
    const sel = real.filter((l) => !args.sedan || Date.parse(l.lastModifiedTime) >= Date.parse(args.sedan));
    const perStatus = {};
    for (const l of sel) perStatus[STATUS[l.status] ?? l.status] = (perStatus[STATUS[l.status] ?? l.status] ?? 0) + 1;
    const booked = sel.filter((l) => l.status === 'success').map(summarize)
      .map(({ bolag, kontakt, titel, senast_andrad, mote_skickat_till }) => ({ bolag, kontakt, titel, datum: senast_andrad, skickat_till: mote_skickat_till }));
    return {
      period: args.sedan ? `från ${args.sedan}` : 'allt',
      antal_leads: sel.length,
      antal_samtal_totalt: sel.reduce((n, l) => n + (Number(l.contactAttempts) || 0), 0),
      per_status: perStatus,
      bokade_moten: booked,
    };
  }
  throw new Error(`Okänt verktyg: ${name}`);
}

// ---------- MCP (JSON-RPC över Streamable HTTP, utan strömning) ----------

export async function handleRpc(msg, getLeads) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined) return null; // notifikation, t.ex. notifications/initialized
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'adversus', title: 'Adversus (eztablisher)', version: '1.0.0' },
        instructions:
          'Läsåtkomst till eztablishers prospektering för Indivd i Adversus: leads, utfall, antal samtal och bokade möten. Data är live men cachas i 15 minuter.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      try {
        const data = runTool(params?.name, params?.arguments, await getLeads());
        return ok({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Fel: ${e.message}` }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Metoden stöds inte: ${method}` } };
  }
}
