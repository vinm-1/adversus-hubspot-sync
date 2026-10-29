# Adversus till HubSpot

Synkar eztablishers prospektering i Adversus till Indivds HubSpot, en gång i timmen på vardagar.

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
   - `HUBSPOT_TOKEN`: token från en HubSpot Private App med scopes `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`, `crm.objects.deals.read/write`, `crm.schemas.contacts.write`, `crm.schemas.companies.write`, `crm.schemas.deals.write`, `crm.objects.owners.read`
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

## Adversus i Claude (custom connector)
`supabase/functions/adversus-mcp` är en koppling (remote MCP-server) som låter Claude läsa Adversus live:
verktygen `sok_leads`, `hamta_lead` och `statistik`. Den är skrivskyddad och cachar svaren i 15 minuter, så att
Adversus timgräns räcker även för synken.

**Inloggning:** OAuth med PKCE. När du lägger till kopplingen i Claude frågar webbläsaren efter
`CONNECTOR_PASSWORD` i webbläsarens inloggningsruta (användarnamn spelar ingen roll). Byter du lösenordet loggas alla befintliga anslutningar ut.

**Installation (en gång):**
1. GitHub → Settings → Secrets and variables → Actions → Secrets:
   - `SUPABASE_ACCESS_TOKEN`: supabase.com → Account → Access Tokens
   - `CONNECTOR_PASSWORD`: ett långt lösenord du väljer
2. Workflowet hittar Supabase-projektet `indivd-integrations`, eller skapar det i Stockholm om det saknas.
3. Actions → *Deploya Adversus-kopplingen till Claude* → Run workflow.
4. Claude → Settings → Connectors → Add custom connector → URL:en från körningens sammanfattning.

**Håll vaket:** `keepalive.yml` anropar Supabase-projektet en gång om dagen, så att gratisprojektet inte pausas.
Är projektet ändå pausat misslyckas jobbet, och GitHub mejlar dig med en länk för att starta det igen.
