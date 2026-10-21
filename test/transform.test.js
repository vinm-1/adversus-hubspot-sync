import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrgnr, normalizePhone, normalizeEmail, splitName, skipReason,
  parseLead, companyAttempts, fillBlanks, newCalls, clean, companyDomain, nameVariants, resultSummary, callStatus,
} from '../src/transform.js';

// Påhittade leads med samma form som Adversus svar.
const lead = (over = {}, master = {}, result = {}) => ({
  id: 1, status: 'automaticRedial', active: true, contactAttempts: 3,
  lastModifiedTime: '2026-10-20T10:00:00Z', nextContactTime: '2026-10-21T10:00:00Z',
  masterData: Object.entries(master).map(([label, value], i) => ({ id: i, label, value })),
  resultData: Object.entries(result).map(([label, value], i) => ({ id: i, label, value })),
  ...over,
});

test('org.nr normaliseras och skräp blir null', () => {
  assert.equal(normalizeOrgnr('556126-6494'), '556126-6494');
  assert.equal(normalizeOrgnr('5560830084'), '556083-0084');
  assert.equal(normalizeOrgnr('Ej hittad'), null);
  assert.equal(normalizeOrgnr('13 82 46 06'), null);
});

test('telefonnummer blir E.164', () => {
  assert.equal(normalizePhone('46727084110'), '+46727084110');
  assert.equal(normalizePhone('070-7135445'), '+46707135445');
  assert.equal(normalizePhone('+46 70 559 26 31'), '+46705592631');
  assert.equal(normalizePhone('08-641 74 40'), '+4686417440');
  assert.equal(normalizePhone('+45 30 29 94 33'), '+4530299433');
  assert.equal(normalizePhone('+33 1 40 29 10 46,+33 7 82 59 52 93'), '+33140291046');
  assert.equal(normalizePhone(''), null);
});

test('e-post: första adressen, gemener, ogiltiga bort', () => {
  assert.equal(normalizeEmail('Jesper.Utengren@vasakronan.se'), 'jesper.utengren@vasakronan.se');
  assert.equal(normalizeEmail('a@x.se,b@x.se'), 'a@x.se');
  assert.equal(normalizeEmail('401'), null);
  assert.equal(normalizeEmail(''), null);
});

test('platshållare räknas som tomt', () => {
  for (const v of ['-', '.', ',,,,', 'x', '?', 'e', 'Ej hittad']) assert.equal(clean(v), null);
  assert.equal(clean('VD'), 'VD');
});

test('namn delas, LinkedIn-länk i namnfältet ignoreras', () => {
  assert.deepEqual(splitName('Lars Rosén'), { firstname: 'Lars', lastname: 'Rosén' });
  assert.deepEqual(splitName('https://se.linkedin.com/in/x'), { firstname: null, lastname: null });
});

test('testleads, inaktiva, dubbletter och tomma hoppas över', () => {
  assert.equal(skipReason(lead({ active: false }, { Företagsnamn: 'Riktigt AB' })), 'inaktivt');
  assert.equal(skipReason(lead({}, { Företagsnamn: 'TEST101' })), 'testlead');
  assert.equal(skipReason(lead({}, { Företagsnamn: 'Eztablisher' })), 'testlead');
  assert.equal(
    skipReason(lead({ status: 'unqualified' }, { Företagsnamn: 'Jysk AB' }, { 'Kommentar - Unqualified': 'Dubblett' })),
    'dubblett',
  );
  assert.equal(skipReason(lead({}, {})), 'tomt lead');
  assert.equal(skipReason(lead({}, { Företagsnamn: 'Stadium' })), null);
});

test('parseLead plockar ut bolag, kontakt och utfall', () => {
  const p = parseLead(lead(
    { id: 42, status: 'success' },
    {
      Företagsnamn: 'Rusta', Organisationsnr: '556280-2115', Kontaktperson: 'Linda Hammar',
      Befattning: 'CMO', Email: 'Linda@rusta.com', 'Direkt nummer': '+46 70 290 42 55',
    },
    { Beskrivning: 'Bra samtal', 'Anledning - Inte intresserad': 'Nöjd' },
  ));
  assert.equal(p.leadId, '42');
  assert.equal(p.statusLabel, 'Bokat möte');
  assert.equal(p.company.orgnr, '556280-2115');
  assert.equal(p.contact.email, 'linda@rusta.com');
  assert.equal(p.contact.mobilephone, '+46702904255');
  assert.equal(p.meetingNote, 'Bra samtal');
  assert.equal(p.result, 'Nöjd');
});

test('samtal summeras per bolag via org.nr i båda formaten', () => {
  const a = parseLead(lead({ contactAttempts: 2 }, { Företagsnamn: 'Axfood', Organisationsnr: '556542-0824' }));
  const b = parseLead(lead({ contactAttempts: 5 }, { Företagsnamn: 'Axfood AB', Organisationsnr: '5565420824' }));
  assert.equal(companyAttempts([a, b]).get('556542-0824'), 7);
});

test('fillBlanks skriver aldrig över befintliga värden', () => {
  assert.deepEqual(
    fillBlanks({ email: 'gammal@x.se', phone: '' }, { email: 'ny@x.se', phone: '+46700000000', jobtitle: null }),
    { phone: '+46700000000' },
  );
});

test('nya samtal räknas som skillnad, första synken loggar inga', () => {
  assert.equal(newCalls(null, 12), 0);
  assert.equal(newCalls('3', 5), 2);
  assert.equal(newCalls('5', 5), 0);
  assert.equal(newCalls('7', 5), 0);
});

test('domän från URL eller kontaktens e-post, men inte gmail', () => {
  const p = (url, email) => ({ company: { domain: url }, contact: { email } });
  assert.equal(companyDomain(p(null, 'pete@bang-olufsen.com')), 'bang-olufsen.com');
  assert.equal(companyDomain(p('www.Gant.se', 'x@gant.com')), 'gant.se');
  assert.equal(companyDomain(p(null, 'x@gmail.com')), null);
});

test('namnvarianter utan parentes', () => {
  assert.ok(nameVariants('DOZ Apotek (Admenta)').includes('DOZ Apotek'));
  assert.ok(nameVariants('Bang & Olufsen').includes('Bang Olufsen'));
});

test('utfallet blir läsbar svenska', () => {
  const l = lead({}, {}, {
    'Anledning - Inte intresserad': 'Nöjd med befintlig lösning',
    'Kommentar - Inte intresserad': 'mäter redan',
    'Lämplig återkoppling': '2026-07-23T16:30:00+02:00',
  });
  assert.equal(resultSummary(l), 'Nöjd med befintlig lösning. Kommentar: mäter redan. Återkoppling: 23 juli 2026');
  assert.equal(resultSummary(lead()), null);
});

test('samtalsstatus: obesvarat, misslyckat eller genomfört', () => {
  assert.equal(callStatus('automaticRedial'), 'NO_ANSWER');
  assert.equal(callStatus('invalid'), 'FAILED');
  assert.equal(callStatus('success'), 'COMPLETED');
  assert.equal(callStatus('privateRedial'), 'COMPLETED');
});
