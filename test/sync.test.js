import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncLead } from '../src/sync.js';
import { parseLead } from '../src/transform.js';

// Fejkad HubSpot som minns vad som skapats.
function fakeHs(existingContact = null, existingDeal = false) {
  const made = [];
  return {
    made,
    findCompany: async () => null,
    findContact: async () => existingContact,
    findDeal: async () => null,
    ownerIdByEmail: async (e) => (e === 'robin@indivd.com' ? '78560277' : null),
    companyHasDeal: async () => (existingDeal ? { id: 'd1' } : null),
    create: async (object, properties) => { made.push({ object, properties }); return { id: `${object}-${made.length}` }; },
    update: async (object, id, properties) => { made.push({ object, id, update: properties }); },
    associate: async () => {},
  };
}

const stats = () => ({ companiesCreated: 0, contactsCreated: 0, contactsUpdated: 0, callsLogged: 0, dealsCreated: 0, noContact: 0 });

const rusta = (over) => parseLead({
  id: 7, status: 'automaticRedial', active: true, contactAttempts: 5,
  lastModifiedTime: '2026-10-20T10:00:00Z', nextContactTime: null,
  masterData: [
    { label: 'Företagsnamn', value: 'Rusta' },
    { label: 'Organisationsnr', value: '556280-2115' },
    { label: 'Kontaktperson', value: 'Linda Hammar' },
    { label: 'Email', value: 'linda@rusta.com' },
  ],
  resultData: [],
  ...over,
});

test('ny kontakt: bolag + kontakt skapas, inga samtal första gången', async () => {
  const hs = fakeHs();
  const s = stats();
  await syncLead(hs, rusta(), new Map([['556280-2115', 5]]), s, new Map());
  assert.deepEqual(hs.made.map((m) => m.object), ['companies', 'contacts']);
  assert.equal(hs.made[0].properties.adversus_contact_attempts, 5);
  assert.equal(s.callsLogged, 0);
});

test('befintlig kontakt med 3 sparade samtal och 5 i Adversus: 2 Calls loggas', async () => {
  const hs = fakeHs({ id: 'c1', properties: { adversus_lead_id: '7', adversus_contact_attempts: '3', email: 'linda@rusta.com' } });
  const s = stats();
  await syncLead(hs, rusta(), new Map(), s, new Map([['556280-2115', 'co1']]));
  const calls = hs.made.filter((m) => m.object === 'calls');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].properties.hs_call_direction, 'OUTBOUND');
  const upd = hs.made.find((m) => m.object === 'contacts').update;
  assert.equal(upd.adversus_contact_attempts, 5);
  assert.equal(upd.email, undefined);
});

test('bokat möte blir en deal med mötesanteckningen', async () => {
  const hs = fakeHs();
  const s = stats();
  const p = rusta({ status: 'success', resultData: [{ label: 'Beskrivning', value: 'Vill se demo' }] });
  await syncLead(hs, p, new Map(), s, new Map());
  const deal = hs.made.find((m) => m.object === 'deals');
  assert.equal(deal.properties.description, 'Vill se demo');
  assert.equal(deal.properties.adversus_lead_id, '7');
});

test('samtalets text saknar lead-ID och har kontaktens namn', async () => {
  const hs = fakeHs({ id: 'c1', properties: { adversus_lead_id: '7', adversus_contact_attempts: '4' } });
  await syncLead(hs, rusta(), new Map(), stats(), new Map([['556280-2115', 'co1']]));
  const call = hs.made.find((m) => m.object === 'calls').properties;
  assert.equal(call.hs_call_body, 'Samtal 5 av 5 till Linda Hammar.');
  assert.equal(call.hs_call_status, 'NO_ANSWER');
});

test('ingen ny deal om bolaget redan har en deal', async () => {
  const hs = fakeHs(null, true);
  const s = stats();
  const p = rusta({ status: 'success', resultData: [{ label: 'Beskrivning', value: 'x' }] });
  await syncLead(hs, p, new Map(), s, new Map([['556280-2115', 'co1']]));
  assert.equal(s.dealsCreated, 0);
});

test('dealen får ägaren som eztablisher skickade mötet till', async () => {
  const hs = fakeHs();
  const p = rusta({ status: 'success', resultData: [{ label: 'Email sent to consultant', value: 'robin@indivd.com' }] });
  await syncLead(hs, p, new Map(), stats(), new Map());
  assert.equal(hs.made.find((m) => m.object === 'deals').properties.hubspot_owner_id, '78560277');
});
