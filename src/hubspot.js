import { request } from './http.js';

const BASE = 'https://api.hubapi.com';

// HubSpot-definierade associationstyper (v4).
export const ASSOC = {
  contactToCompany: 1,
  callToContact: 194,
  callToCompany: 182,
  dealToContact: 3,
  dealToCompany: 5,
};

export class HubSpot {
  constructor(token = process.env.HUBSPOT_TOKEN, { dryRun = false, log = console.log } = {}) {
    if (!token) throw new Error('HUBSPOT_TOKEN måste vara satt');
    this.token = token;
    this.dryRun = dryRun;
    this.log = log;
    this.fakeId = 0;
  }

  call(method, path, body) {
    return request(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  // Läsningar körs även i torrkörning, skrivningar loggas bara.
  async write(desc, method, path, body) {
    if (this.dryRun) {
      this.log(`[TORRKÖRNING] ${desc}`, JSON.stringify(body?.properties ?? body ?? {}));
      return { id: `dry-${++this.fakeId}` };
    }
    return this.call(method, path, body);
  }

  async searchOne(object, filterGroups, properties) {
    const res = await this.call('POST', `/crm/v3/objects/${object}/search`, {
      filterGroups,
      properties,
      limit: 1,
    });
    return res.results?.[0] ?? null;
  }

  // organisation_number är text, organization_number är ett nummerfält (bara siffror).
  findCompany({ orgnrVariants, name, names = [], domain }, properties) {
    const groups = [];
    if (orgnrVariants.length) {
      groups.push({ filters: [{ propertyName: 'organisation_number', operator: 'IN', values: orgnrVariants }] });
      const digits = orgnrVariants.find((v) => /^\d+$/.test(v));
      if (digits) groups.push({ filters: [{ propertyName: 'organization_number', operator: 'EQ', value: digits }] });
    }
    // Namnet söks alltid som reserv: org.nr i Adversus är ibland fel eller saknas i HubSpot.
    if (domain) groups.push({ filters: [{ propertyName: 'domain', operator: 'EQ', value: domain }] });
    const allNames = names.length ? names : name ? [name] : [];
    if (allNames.length) groups.push({ filters: [{ propertyName: 'name', operator: 'IN', values: allNames }] });
    return groups.length ? this.searchOne('companies', groups, properties) : null;
  }

  findContact({ leadId, email, phone }, properties) {
    const groups = [{ filters: [{ propertyName: 'adversus_lead_id', operator: 'EQ', value: leadId }] }];
    if (email) groups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] });
    if (phone) groups.push({ filters: [{ propertyName: 'mobilephone', operator: 'EQ', value: phone }] });
    return this.searchOne('contacts', groups, properties);
  }

  findDeal(leadId) {
    return this.searchOne(
      'deals',
      [{ filters: [{ propertyName: 'adversus_lead_id', operator: 'EQ', value: leadId }] }],
      ['dealname'],
    );
  }

  // Finns det en deal på bolaget skapad de senaste 6 månaderna (oavsett källa)?
  // Äldre deals räknas inte: ett nytt bokat möte är då en ny affärsmöjlighet.
  companyHasDeal(companyId, now = Date.now()) {
    const since = new Date(now - 182 * 24 * 3600 * 1000).toISOString();
    return this.searchOne(
      'deals',
      [{
        filters: [
          { propertyName: 'associations.company', operator: 'EQ', value: String(companyId) },
          { propertyName: 'createdate', operator: 'GTE', value: since },
        ],
      }],
      ['dealname'],
    );
  }

  // HubSpot-ägare utifrån e-post, t.ex. säljaren eztablisher skickade mötet till.
  async ownerIdByEmail(email) {
    if (!email) return null;
    this.owners ??= new Map();
    if (!this.owners.has(email)) {
      const res = await this.call('GET', `/crm/v3/owners?email=${encodeURIComponent(email)}&limit=1`);
      this.owners.set(email, res.results?.[0]?.id ?? null);
    }
    return this.owners.get(email);
  }

  create(object, properties, associations = []) {
    return this.write(`skapa ${object}`, 'POST', `/crm/v3/objects/${object}`, { properties, associations });
  }

  update(object, id, properties) {
    if (!Object.keys(properties).length) return null;
    return this.write(`uppdatera ${object} ${id}`, 'PATCH', `/crm/v3/objects/${object}/${id}`, { properties });
  }

  associate(from, fromId, to, toId, typeId) {
    return this.write(
      `koppla ${from} ${fromId} -> ${to} ${toId}`,
      'PUT',
      `/crm/v4/objects/${from}/${fromId}/associations/${to}/${toId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
    );
  }
}

export function assoc(id, typeId) {
  return { to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] };
}
