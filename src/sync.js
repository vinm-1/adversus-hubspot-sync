import { fetchLeads } from './adversus.js';
import { HubSpot, ASSOC, assoc } from './hubspot.js';
import {
  parseLead,
  skipReason,
  companyKey,
  companyAttempts,
  fillBlanks,
  newCalls,
  orgnrVariants,
  companyDomain,
  nameVariants,
  callStatus,
  callOutcome,
  callBody,
} from './transform.js';

const CONTACT_PROPS = [
  'firstname', 'lastname', 'email', 'phone', 'mobilephone', 'jobtitle', 'hs_linkedin_url',
  'adversus_lead_id', 'adversus_contact_attempts',
];
const COMPANY_PROPS = ['name', 'domain', 'organization_number', 'organisation_number'];

// organization_number är ett nummerfält i HubSpot och tar bara siffror.
const orgnrProps = (orgnr) => ({
  organisation_number: orgnr,
  organization_number: orgnr ? orgnr.replace('-', '') : null,
});

// Ägare för nya deals: HUBSPOT_DEAL_OWNER_ID (Victor) om den är satt. Annars den som
// eztablisher skickade mötet till enligt Adversus.
async function ownerProp(hs, email) {
  const id = process.env.HUBSPOT_DEAL_OWNER_ID || (await hs.ownerIdByEmail?.(email));
  return id ? { hubspot_owner_id: String(id) } : {};
}

export async function syncLead(hs, p, companyTotals, stats, companyCache) {
  // Företag
  let companyId = null;
  const key = companyKey(p);
  if (key && companyCache.has(key)) {
    companyId = companyCache.get(key);
  } else if (key) {
    const found = await hs.findCompany(
      {
        orgnrVariants: orgnrVariants(p.company.orgnr),
        names: nameVariants(p.company.name),
        domain: companyDomain(p),
      },
      COMPANY_PROPS,
    );
    const total = companyTotals.get(key) ?? 0;
    if (found) {
      companyId = found.id;
      await hs.update('companies', found.id, {
        ...fillBlanks(found.properties, {
          name: p.company.name,
          domain: companyDomain(p),
          ...orgnrProps(p.company.orgnr),
        }),
        adversus_contact_attempts: total,
      });
    } else if (p.company.name) {
      const created = await hs.create(
        'companies',
        Object.fromEntries(
          Object.entries({
            name: p.company.name,
            domain: companyDomain(p),
            ...orgnrProps(p.company.orgnr),
            adversus_contact_attempts: total,
            // Märker bolag som synken skapat, så att eventuella dubbletter är lätta att hitta och slå ihop.
            adversus_created_at: new Date().toISOString(),
          }).filter(([, v]) => v != null),
        ),
      );
      companyId = created.id;
      stats.companiesCreated++;
    }
    companyCache.set(key, companyId);
  }

  // Kontakt
  const c = p.contact;
  if (!c.email && !c.phone && !c.mobilephone && !c.lastname && !c.firstname) {
    stats.noContact++;
    return;
  }
  const adversusProps = {
    adversus_lead_id: p.leadId,
    adversus_contact_attempts: p.attempts,
    adversus_status: p.statusLabel,
    adversus_last_result: p.result ?? '',
    adversus_last_contacted: p.lastContacted,
    adversus_next_contact: p.nextContact ?? '',
  };
  const base = {
    firstname: c.firstname,
    lastname: c.lastname,
    email: c.email,
    phone: c.phone,
    mobilephone: c.mobilephone,
    jobtitle: c.jobtitle,
    hs_linkedin_url: c.linkedin,
  };
  const found = await hs.findContact(
    { leadId: p.leadId, email: c.email, phone: c.mobilephone ?? c.phone },
    CONTACT_PROPS,
  );
  let contactId;
  let stored = null;
  if (found) {
    contactId = found.id;
    // Samma person kan finnas som flera leads. Räkna bara samtal mot leadet som äger kontakten.
    const sameLead = !found.properties.adversus_lead_id || found.properties.adversus_lead_id === p.leadId;
    stored = sameLead ? found.properties.adversus_contact_attempts : null;
    if (sameLead) {
      await hs.update('contacts', contactId, { ...fillBlanks(found.properties, base), ...adversusProps });
    } else {
      await hs.update('contacts', contactId, fillBlanks(found.properties, base));
    }
    stats.contactsUpdated++;
  } else {
    try {
      const created = await hs.create(
        'contacts',
        Object.fromEntries(Object.entries({ ...base, ...adversusProps }).filter(([, v]) => v != null && v !== '')),
        companyId ? [assoc(companyId, ASSOC.contactToCompany)] : [],
      );
      contactId = created.id;
      stats.contactsCreated++;
    } catch (err) {
      // HubSpots sökindex hänger ibland efter: kontakten finns redan med samma e-post.
      const existing = err.message.match(/Existing ID: (\d+)/)?.[1];
      if (!existing) throw err;
      contactId = existing;
      await hs.update('contacts', contactId, adversusProps);
      if (companyId) await hs.associate('contacts', contactId, 'companies', companyId, ASSOC.contactToCompany);
      stats.contactsUpdated++;
    }
  }
  if (found && companyId) await hs.associate('contacts', contactId, 'companies', companyId, ASSOC.contactToCompany);

  // Samtal: ett Call per nytt försök sedan förra körningen.
  const calls = newCalls(stored, p.attempts);
  for (let i = 0; i < calls; i++) {
    const associations = [assoc(contactId, ASSOC.callToContact)];
    if (companyId) associations.push(assoc(companyId, ASSOC.callToCompany));
    await hs.create(
      'calls',
      {
        hs_timestamp: p.lastContacted ?? new Date().toISOString(),
        hs_call_title: `Samtal via eztablisher (Adversus): ${p.statusLabel}`,
        hs_call_body: callBody(p, Number(stored) + i + 1),
        hs_call_direction: 'OUTBOUND',
        hs_call_status: callStatus(p.status),
        hs_call_disposition: callOutcome(p),
        ...(process.env.HUBSPOT_CALL_OWNER_ID ? { hubspot_owner_id: process.env.HUBSPOT_CALL_OWNER_ID } : {}),
      },
      associations,
    );
    stats.callsLogged++;
  }

  // Bokat möte blir en deal, men bara om bolaget inte redan har en deal (då är mötet redan i pipen).
  const hasDeal = async () =>
    (await hs.findDeal(p.leadId)) || (companyId && !String(companyId).startsWith('dry-') && (await hs.companyHasDeal(companyId)));
  if (p.status === 'success' && !(await hasDeal())) {
    const associations = [assoc(contactId, ASSOC.dealToContact)];
    if (companyId) associations.push(assoc(companyId, ASSOC.dealToCompany));
    await hs.create(
      'deals',
      {
        dealname: `${p.company.name ?? 'Okänt bolag'} – möte bokat av eztablisher`,
        pipeline: process.env.HUBSPOT_PIPELINE ?? 'default',
        dealstage: process.env.HUBSPOT_DEAL_STAGE ?? 'appointmentscheduled',
        description: p.meetingNote ?? '',
        adversus_lead_id: p.leadId,
        ...(await ownerProp(hs, p.consultantEmail)),
      },
      associations,
    );
    stats.dealsCreated++;
  }
}

export async function run({ dryRun = false, limit = Infinity, log = console.log } = {}) {
  const raw = await fetchLeads();
  const stats = {
    leads: raw.length, skipped: {}, companiesCreated: 0, contactsCreated: 0,
    contactsUpdated: 0, callsLogged: 0, dealsCreated: 0, noContact: 0, errors: 0,
  };
  const kept = [];
  for (const lead of raw) {
    const why = skipReason(lead);
    if (why) stats.skipped[why] = (stats.skipped[why] ?? 0) + 1;
    else kept.push(parseLead(lead));
  }
  const totals = companyAttempts(kept);
  // Domän per bolag från alla dess kontakter: första kontakten saknar ibland e-post (så skapades "Lager157").
  const domains = new Map();
  for (const p of kept) {
    const k = companyKey(p);
    const d = companyDomain(p);
    if (k && d && !domains.has(k)) domains.set(k, d);
  }
  for (const p of kept) if (!p.company.domain) p.company.domain = domains.get(companyKey(p)) ?? null;

  // LIMIT räknar bolag, så att en provkörning visar hela bolag med alla kontakter.
  // Provkörningen tar bolag med riktiga kontakter (e-post) först, så att provet visar något.
  const ordered = Number.isFinite(limit)
    ? [...kept].sort((a, b) => Number(!!b.contact.email) - Number(!!a.contact.email))
    : kept;
  const keys = [...new Set(ordered.map(companyKey))].slice(0, limit);
  const selected = Number.isFinite(limit) ? kept.filter((p) => keys.includes(companyKey(p))) : kept;

  const hs = new HubSpot(undefined, { dryRun, log });
  const cache = new Map();
  for (const p of selected) {
    try {
      await syncLead(hs, p, totals, stats, cache);
    } catch (err) {
      stats.errors++;
      log(`FEL på lead ${p.leadId} (${p.company.name}): ${err.message}`);
    }
  }
  log('Klart:', JSON.stringify(stats, null, 2));
  if (stats.errors) process.exitCode = 1;
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await run({
    dryRun: process.env.DRY_RUN === 'true',
    // Tomt eller 0 betyder alla bolag.
    limit: Number(process.env.LIMIT) > 0 ? Number(process.env.LIMIT) : Infinity,
  });
}
