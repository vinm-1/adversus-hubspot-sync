# Adversus till HubSpot

Synkar eztablishers prospektering i Adversus till Indivds HubSpot, var 30:e minut på vardagar.

## Vad som synkas
- **Bolag**: matchas på org.nr (`organization_number` eller `organisation_number`), annars skapas de. Fältet *Adversus: antal samtal (alla kontakter)* visar summan av samtal på bolaget.
- **Kontakter**: matchas på Adversus lead-ID, e-post eller mobilnummer. Adversus fyller **bara i tomma fält**. Fälten *Adversus: …* (antal samtal, status, senaste utfall, senast ringd, nästa samtal) uppdateras alltid.
- **Samtal**: ett HubSpot-*Call* per nytt samtal sedan förra körningen, kopplat till kontakt och bolag. Första synken loggar inga gamla samtal, eftersom Adversus inte ger datum per samtal, bara totalen.
- **Bokade möten** (status `success`): en deal med eztablishers mötesanteckning. Skapas en gång per lead.
- **Hoppas över**: testleads, inaktiva leads, leads markerade som dubblett och tomma leads.

## Installation (en gång)
1. **Settings → Secrets and variables → Actions → New repository secret**:
   - `ADVERSUS_USER`: API-användaren från Adversus
   - `ADVERSUS_PASSWORD`: lösenordet
   - `HUBSPOT_TOKEN`: token från en HubSpot Private App med scopes `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read/write`, `crm.schemas.contacts.write`, `crm.schemas.companies.write`, `crm.schemas.deals.write`
   - Valfri *variable* `HUBSPOT_CALL_OWNER_ID`: HubSpot-ägaren som samtalen ska stå på
2. **Actions → Adversus till HubSpot → Run workflow**: kryssa i *setup* och *dry run*, sätt limit 5. Läs loggen.
3. Kör igen utan *dry run* med limit 5. Granska de 5 bolagen i HubSpot.
4. Är allt rätt sköter schemat resten.

## Lokalt
```
npm test
DRY_RUN=true LIMIT=5 ADVERSUS_USER=… ADVERSUS_PASSWORD=… HUBSPOT_TOKEN=… npm run sync
```

## Kända osäkerheter
- Sidindelningen i Adversus API (`page`/`pageSize`) är inte bekräftad mot deras dokumentation. Koden stoppar säkert, men kontrollera i första körningens logg att antalet leads stämmer.
- Associationstyperna för Call och Deal är HubSpots standard-ID:n (194/182, 3/5).
