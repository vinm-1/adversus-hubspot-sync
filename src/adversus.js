import { request } from './http.js';

const BASE = process.env.ADVERSUS_BASE_URL ?? 'https://api.adversus.dk/v1';

function auth() {
  const user = process.env.ADVERSUS_USER;
  const pass = process.env.ADVERSUS_PASSWORD;
  if (!user || !pass) throw new Error('ADVERSUS_USER och ADVERSUS_PASSWORD måste vara satta');
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// Hämtar alla leads. Sidindelningen är inte bekräftad mot Adversus dokumentation,
// så vi slutar när en sida är tom, kortare än sidstorleken eller upprepar förra sidan.
export async function fetchLeads({ pageSize = 1000, maxPages = 50 } = {}) {
  const all = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/leads?page=${page}&pageSize=${pageSize}`;
    const data = await request(url, { headers: { Authorization: auth(), Accept: 'application/json' } });
    const leads = data?.leads ?? [];
    const fresh = leads.filter((l) => !seen.has(l.id));
    fresh.forEach((l) => seen.add(l.id));
    all.push(...fresh);
    if (fresh.length === 0 || leads.length < pageSize) break;
  }
  return all;
}
