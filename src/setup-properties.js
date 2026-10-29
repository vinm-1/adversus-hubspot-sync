// Skapar Adversus-fälten i HubSpot. Körs en gång, och är säker att köra igen.
import { HubSpot } from './hubspot.js';

const GROUP = { name: 'adversus', label: 'Adversus (eztablisher)' };

const text = (name, label) => ({ name, label, type: 'string', fieldType: 'text' });
const num = (name, label) => ({ name, label, type: 'number', fieldType: 'number' });
const time = (name, label) => ({ name, label, type: 'datetime', fieldType: 'date' });

const PROPS = {
  contacts: [
    text('adversus_lead_id', 'Adversus: lead-ID'),
    num('adversus_contact_attempts', 'Adversus: antal samtal'),
    text('adversus_status', 'Adversus: status'),
    text('adversus_last_result', 'Adversus: senaste utfall'),
    time('adversus_last_contacted', 'Adversus: senast ringd'),
    time('adversus_next_contact', 'Adversus: nästa samtal'),
  ],
  companies: [
    num('adversus_contact_attempts', 'Adversus: antal samtal (alla kontakter)'),
    time('adversus_created_at', 'Adversus: skapad av synken'),
  ],
  deals: [text('adversus_lead_id', 'Adversus: lead-ID')],
};

const hs = new HubSpot();
for (const [object, props] of Object.entries(PROPS)) {
  try {
    await hs.call('POST', `/crm/v3/properties/${object}/groups`, GROUP);
    console.log(`Grupp skapad på ${object}`);
  } catch (e) {
    if (!/409/.test(e.message)) throw e;
  }
  for (const p of props) {
    try {
      await hs.call('POST', `/crm/v3/properties/${object}`, { ...p, groupName: GROUP.name });
      console.log(`Skapat ${object}.${p.name}`);
    } catch (e) {
      if (/409/.test(e.message)) console.log(`Finns redan: ${object}.${p.name}`);
      else throw e;
    }
  }
}
