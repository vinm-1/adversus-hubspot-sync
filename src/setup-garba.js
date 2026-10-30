// Skapar Garba-fälten på bolag i HubSpot. Säker att köra igen.
// Health-fälten hamnar i samma grupp som Njord Score ("Score"), resten i en egen Garba-grupp.
import { HubSpot } from './hubspot.js';

const text = (name, label) => ({ name, label, type: 'string', fieldType: 'textarea' });
const GARBA = { name: 'garba', label: 'Garba' };

const hs = new HubSpot();
const scoreGroup = (await hs.call('GET', '/crm/v3/properties/companies/njord_score')).groupName;
console.log(`Score-gruppen heter: ${scoreGroup}`);

try {
  await hs.call('POST', '/crm/v3/properties/companies/groups', GARBA);
  console.log('Grupp skapad: Garba');
} catch (e) {
  if (!/409/.test(e.message)) throw e;
}

const PROPS = [
  { name: 'garba_health_score', label: 'Garba Health Score', type: 'number', fieldType: 'number', groupName: scoreGroup },
  {
    name: 'garba_health_band', label: 'Garba Health Band', type: 'enumeration', fieldType: 'select', groupName: scoreGroup,
    options: ['Healthy', 'Developing', 'At risk'].map((l, i) => ({ label: l, value: l, displayOrder: i })),
  },
  { ...text('garba_health_reasoning', 'Garba Health Motivering'), groupName: scoreGroup },
  { ...text('garba_situation', 'Garba Situation'), groupName: GARBA.name },
  { ...text('garba_pain', 'Garba Pain'), groupName: GARBA.name },
  { ...text('garba_impact', 'Garba Impact'), groupName: GARBA.name },
  { ...text('garba_critical_event', 'Garba Critical Event'), groupName: GARBA.name },
  { ...text('garba_decision', 'Garba Decision'), groupName: GARBA.name },
  { ...text('garba_next_step', 'Garba Nästa steg'), groupName: GARBA.name },
  { name: 'garba_updated_at', label: 'Garba Senast uppdaterad', type: 'datetime', fieldType: 'date', groupName: GARBA.name },
];

for (const p of PROPS) {
  try {
    await hs.call('POST', '/crm/v3/properties/companies', p);
    console.log(`Skapat ${p.name} i ${p.groupName}`);
  } catch (e) {
    if (/409/.test(e.message)) console.log(`Finns redan: ${p.name}`);
    else throw e;
  }
}
