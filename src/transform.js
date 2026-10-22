// Ren logik utan nätverk: tolkar Adversus-leads och bestämmer vad som ska till HubSpot.

const FIELD = {
  company: 'Företagsnamn',
  orgnr: 'Organisationsnr',
  contactName: 'Kontaktperson',
  title: 'Befattning',
  email: 'Email',
  phone: 'Telefon nummer',
  mobile: 'Direkt nummer',
  linkedin: 'Linkedin länk',
  description: 'Beskrivning',
};

// Värden som säljarna skriver när fältet egentligen är tomt.
const PLACEHOLDERS = new Set(['', '-', '.', ',', 'x', 'c', 'e', 'f', 'r', '?', '0', 'n/a', 'ej hittad']);

export function clean(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (PLACEHOLDERS.has(v.toLowerCase()) || /^[,.\s-]+$/.test(v)) return null;
  return v;
}

function firstOf(value) {
  const v = clean(value);
  return v ? clean(v.split(',')[0]) : null;
}

export function fieldMap(list = []) {
  const out = {};
  for (const f of list) out[f.label] = f.value;
  return out;
}

// Svenskt org.nr: 10 siffror. Allt annat (danska, norska, skräp) lämnas som det är.
export function normalizeOrgnr(value) {
  const v = clean(value);
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  if (digits.length === 10) return `${digits.slice(0, 6)}-${digits.slice(6)}`;
  return null;
}

export function orgnrVariants(orgnr) {
  if (!orgnr) return [];
  return [orgnr, orgnr.replace('-', '')];
}

export function normalizePhone(value) {
  const v = firstOf(value);
  if (!v) return null;
  const plus = v.startsWith('+');
  let d = v.replace(/\D/g, '');
  if (!d) return null;
  if (plus) return `+${d}`;
  if (d.startsWith('00')) return `+${d.slice(2)}`;
  if (d.startsWith('0')) return `+46${d.slice(1)}`;
  if (/^(45|46|47|358)\d{7,}$/.test(d)) return `+${d}`;
  if (d.length === 10) return `+1${d}`;
  return `+${d}`;
}

export function normalizeEmail(value) {
  const v = firstOf(value);
  if (!v || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return null;
  return v.toLowerCase();
}

export function splitName(full) {
  const v = clean(full);
  if (!v || /linkedin\.com/i.test(v)) return { firstname: null, lastname: null };
  const parts = v.split(/\s+/);
  return { firstname: parts[0], lastname: parts.slice(1).join(' ') || null };
}

const TEST_NAMES = /^(test|401$|eztablisher$)/i;

// Varför ett lead ska hoppas över, eller null om det ska synkas.
export function skipReason(lead) {
  const m = fieldMap(lead.masterData);
  const r = fieldMap(lead.resultData);
  if (lead.active === false) return 'inaktivt';
  const name = clean(m[FIELD.company]);
  if (name && TEST_NAMES.test(name)) return 'testlead';
  const comment = String(r['Kommentar - Unqualified'] ?? '').toLowerCase();
  if (lead.status === 'unqualified' && /dubbel|dubblet/.test(comment)) return 'dubblett';
  if (!name && !normalizeEmail(m[FIELD.email])) return 'tomt lead';
  return null;
}

const STATUS_LABEL = {
  success: 'Bokat möte',
  notInterested: 'Inte intresserad',
  unqualified: 'Ej kvalificerad',
  invalid: 'Ogiltig',
  automaticRedial: 'Ring igen (automatiskt)',
  privateRedial: 'Ring igen (bokad återringning)',
};

const SV_DATE = new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Stockholm' });

// Läsbart utfall, t.ex. "Nöjd med befintlig lösning. Kommentar: mäter redan. Återkoppling: 23 juli 2026".
export function resultSummary(lead) {
  const r = fieldMap(lead.resultData);
  const pick = (prefix) => Object.entries(r).find(([k, v]) => k.startsWith(prefix) && clean(v))?.[1];
  const parts = [];
  const reason = pick('Anledning');
  const comment = pick('Kommentar');
  const callback = clean(r['Lämplig återkoppling']);
  if (reason) parts.push(clean(reason));
  if (comment && comment !== reason) parts.push(`Kommentar: ${clean(comment)}`);
  if (callback && !Number.isNaN(Date.parse(callback))) parts.push(`Återkoppling: ${SV_DATE.format(new Date(callback))}`);
  return parts.join('. ') || null;
}

// HubSpots samtalsstatus utifrån leadets status i Adversus.
export function callStatus(status) {
  if (status === 'automaticRedial') return 'NO_ANSWER';
  if (status === 'invalid') return 'FAILED';
  return 'COMPLETED';
}

export function parseLead(lead) {
  const m = fieldMap(lead.masterData);
  const r = fieldMap(lead.resultData);
  const { firstname, lastname } = splitName(m[FIELD.contactName]);
  return {
    leadId: String(lead.id),
    status: lead.status,
    statusLabel: STATUS_LABEL[lead.status] ?? lead.status,
    attempts: Number(lead.contactAttempts) || 0,
    lastContacted: lead.lastModifiedTime ?? null,
    nextContact: lead.nextContactTime ?? null,
    result: resultSummary(lead),
    meetingNote: clean(r[FIELD.description]),
    consultantEmail: normalizeEmail(r['Email sent to consultant']),
    company: {
      name: clean(m[FIELD.company]),
      orgnr: normalizeOrgnr(m[FIELD.orgnr]),
      domain: clean(m['URL'])?.replace(/^https?:\/\//, '').replace(/\/.*$/, '') ?? null,
    },
    contact: {
      firstname,
      lastname,
      jobtitle: clean(m[FIELD.title]),
      email: normalizeEmail(m[FIELD.email]),
      phone: normalizePhone(m[FIELD.phone]),
      mobilephone: normalizePhone(m[FIELD.mobile]),
      linkedin: clean(m[FIELD.linkedin]),
    },
  };
}

// Nyckel för att summera samtal per bolag: org.nr, annars namnet.
export function companyKey(p) {
  return p.company.orgnr ?? (p.company.name ? `namn:${p.company.name.toLowerCase()}` : null);
}

export function companyAttempts(parsed) {
  const sums = new Map();
  for (const p of parsed) {
    const k = companyKey(p);
    if (k) sums.set(k, (sums.get(k) ?? 0) + p.attempts);
  }
  return sums;
}

// Fyll bara i tomma fält: HubSpot vinner alltid när det redan finns ett värde.
export function fillBlanks(existing, incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null || v === '') continue;
    const cur = existing?.[k];
    if (cur == null || String(cur).trim() === '') out[k] = v;
  }
  return out;
}

// Antal nya samtal sedan förra körningen. Första gången (inget sparat värde)
// loggas inga enskilda samtal, bara totalen, eftersom datum för gamla samtal saknas.
export function newCalls(storedAttempts, attempts) {
  if (storedAttempts == null || storedAttempts === '') return 0;
  return Math.max(0, attempts - Number(storedAttempts));
}

const FREEMAIL = /^(gmail|hotmail|outlook|live|yahoo|icloud|me|telia|spray|bredband)\./i;

// Bolagets domän: URL-fältet i Adversus, annars domänen i kontaktens e-post (inte gratistjänster).
export function companyDomain(p) {
  if (p.company.domain) return p.company.domain.toLowerCase().replace(/^www\./, '');
  const d = p.contact.email?.split('@')[1];
  return d && !FREEMAIL.test(d) ? d : null;
}

// Namnvarianter för exakt sökning: original, utan parentes, och med ihopslagna mellanslag.
export function nameVariants(name) {
  if (!name) return [];
  const base = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([name, base, base.replace(/&/g, ' ').replace(/\s+/g, ' ')])];
}

// HubSpots standardval för "Call outcome" (hs_call_disposition).
const OUTCOME = {
  connected: 'f240bbac-87c9-4f6e-bf70-924b57d47db7',
  meetingBooked: '2e7360c1-6b71-40e9-ab2b-30ae98a4678c',
  noAnswer: '73a0d17f-1163-4015-bdd5-ec830791da20',
  wrongNumber: '17b47fee-58de-441e-a44c-c6300d46f273',
};

export function callOutcome(p) {
  if (p.status === 'success') return OUTCOME.meetingBooked;
  if (p.status === 'automaticRedial') return OUTCOME.noAnswer;
  if (p.status === 'invalid') return /nummer/i.test(p.result ?? '') ? OUTCOME.wrongNumber : OUTCOME.noAnswer;
  return OUTCOME.connected; // privateRedial (bokad återringning), notInterested, unqualified
}

const esc = (v) => String(v).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const SV_DATETIME = new Intl.DateTimeFormat('sv-SE', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm',
});

// Samtalets text i HubSpot: alltid med utfall, bolag, titel och vad som händer härnäst.
export function callBody(p, n, now = Date.now()) {
  const name = [p.contact.firstname, p.contact.lastname].filter(Boolean).join(' ') || 'kontakten';
  const rows = [
    `<b>${esc(p.statusLabel)}</b>${p.result ? `: ${esc(p.result)}` : ''}`,
    `Samtal ${n} av ${p.attempts} till ${esc(name)}${p.contact.jobtitle ? `, ${esc(p.contact.jobtitle)}` : ''}${p.company.name ? ` på ${esc(p.company.name)}` : ''}.`,
  ];
  const next = p.nextContact ? Date.parse(p.nextContact) : NaN;
  if (p.status === 'privateRedial' && next > now) rows.push(`Bokad återringning: ${SV_DATETIME.format(new Date(next))}`);
  else if (p.status === 'automaticRedial') rows.push('Inget svar. eztablisher ringer igen.');
  if (p.status === 'success' && p.meetingNote) rows.push(`<i>Mötesanteckning:</i> ${esc(p.meetingNote)}`);
  rows.push('<i>Ringt av eztablisher via Adversus</i>');
  return rows.map((r) => `<p>${r}</p>`).join('');
}
