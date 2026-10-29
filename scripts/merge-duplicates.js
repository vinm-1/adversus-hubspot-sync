// Engångsjobb 2026-10-29: slår ihop dubbletter som synken skapade vid första importen.
// Primär = Victors/Robins befintliga post (behålls). Sekundär = Adversus-posten (försvinner in i primär).
// Före sammanslagningen kopieras Adversus-ID och org.nr till primär posten om de saknas där,
// så att synken känner igen posten efteråt och inte skapar en ny.
import { HubSpot } from '../src/hubspot.js';

const DEALS = [
  // [primär (din), sekundär (Adversus)]
  ['66277504073', '66493410938', 'Lager 157'],
  ['66021714087', '66494333037', 'J. Lindeberg'],
  ['65740003345', '66487533359', 'Motonet'],
  ['65740003964', '66483622474', 'Scorett'],
  ['65740001075', '66493571595', 'Ur & Penn'],
  ['65887331703', '66506107967', 'Bilbolaget Nord'],
  ['65887331329', '66498825577', 'Haglöfs'],
  ['65739999794', '66516322587', 'John Henric'],
  ['59277610656', '66501626149', 'Pondus'],
];
const COMPANIES = [
  ['5226173017', '59710072355', 'Lager 157'],
  ['48255920975', '59697251502', 'Shoeby B.V.'],
  ['55554331243', '59711309647', 'Fenix Outdoor'],
  ['22324746345', '59717459587', 'Folkpool AB'],
  ['33005532588', '59708059778', 'Lundbergs handskar o väskor AB'],
  ['39847223653', '59698033791', 'Bilia'],
  // Osäkra, godkända av Victor 2026-10-29. Vid flera kandidater väljs den äldsta.
  ['25776040843', '59726249567', 'Dahl Sverige AB/AO GG Carat'],
  ['43314014329', '59724547214', 'Gant AB'],
  ['15626944024', '59727639329', 'Pandora'],
  ['33233597321', '59696785497', 'Pilgrim A/S'],
  ['17717361331', '59761810748', 'R A Motor Stockholm AB'],
];

const dryRun = process.env.DRY_RUN !== 'false';
const hs = new HubSpot();
const get = (type, id, props) => hs.call('GET', `/crm/v3/objects/${type}/${id}?properties=${props.join(',')}`);
const blank = (v) => v == null || String(v).trim() === '';
let errors = 0;

async function mergeAll(type, pairs, carry) {
  for (const [primary, secondary, label] of pairs) {
    try {
      const [p, s] = await Promise.all([get(type, primary, ['name', 'dealname', ...carry]), get(type, secondary, ['name', 'dealname', ...carry])]);
      const copy = Object.fromEntries(carry.filter((k) => blank(p.properties[k]) && !blank(s.properties[k])).map((k) => [k, s.properties[k]]));
      const pn = p.properties.dealname ?? p.properties.name;
      const sn = s.properties.dealname ?? s.properties.name;
      console.log(`${dryRun ? '[TORRKÖRNING] ' : ''}${type}: "${sn}" (${secondary}) -> "${pn}" (${primary})${Object.keys(copy).length ? ` + kopierar ${JSON.stringify(copy)}` : ''}`);
      if (dryRun) continue;
      if (Object.keys(copy).length) await hs.call('PATCH', `/crm/v3/objects/${type}/${primary}`, { properties: copy });
      await hs.call('POST', `/crm/v3/objects/${type}/merge`, { primaryObjectId: primary, objectIdToMerge: secondary });
    } catch (e) {
      errors++;
      console.log(`FEL ${type} ${label}: ${e.message.slice(0, 300)}`);
    }
  }
}

await mergeAll('deals', DEALS, ['adversus_lead_id']);
await mergeAll('companies', COMPANIES, ['organisation_number', 'organization_number', 'adversus_contact_attempts']);
console.log(errors ? `Klart med ${errors} fel` : 'Klart utan fel');
if (errors) process.exitCode = 1;
