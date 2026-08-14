# Beta isolation acceptance test

Run this end to end **before inviting any real beta farm**. It exercises the
actual product surfaces (not just the DB probes in `verify_054.sql`, which
should already be clean). Prerequisites: migrations through **055** applied;
the current app deployed.

Record results in the table at the bottom. Every expectation must hold.

## Setup (once, ~5 minutes)

1. As **stuart@turnrow.farm**, open **`/admin`** (type the URL; it's linked
   from Settings → Users too). Create the org **"Beta Test Farm"**.
2. In the org list row for Beta Test Farm, invite a **test email you
   control** (e.g. a personal gmail) as its first owner. Open the invite
   email, set a password — you should land signed in.
3. Back on `/admin` as yourself: click **Partner token** on the Beta Test
   Farm row and copy the minted token (shown once). Call it `TEST_TOKEN`
   below; your existing env token is `TURNROW_TOKEN`.

## The five checks

### (a) Every page shows zero Turnrow data

As the **test user** (use a private/incognito window so sessions don't mix):
the home page should show the **setup checklist**, not data. Open each of:
Loads, Bin Inventory, Contracts, Settlements, Yields, Hedging, every report
under Reports, Settings → Entities/Farms/Fields/Crops.

- Expect: empty states everywhere; **crops shows exactly the four seeded
  crops**; no Turnrow entity/farm/field/buyer name appears anywhere,
  including in dropdown filters.

### (b) Direct URL probes at Turnrow record IDs

As **yourself**, copy the URL of: one load detail (`/loads/<id>`) and one
settlement detail (`/settlements/<id>`). As the **test user**, paste both.

- Expect: not-found / empty detail — never Turnrow data. (RLS returns zero
  rows; the pages render their missing-record state.)

### (c) Partner API tokens are org-scoped

From any shell (replace the host with the production URL):

```bash
curl -s -H "Authorization: Bearer TURNROW_TOKEN" "https://<host>/api/partner/v1/fields" | head -c 400
curl -s -H "Authorization: Bearer TEST_TOKEN"    "https://<host>/api/partner/v1/fields" | head -c 400
curl -s -H "Authorization: Bearer wrong-token"   "https://<host>/api/partner/v1/fields"
```

- Expect: Turnrow token → Turnrow fields (non-empty). Test token → `[]`-ish
  empty payload (no fields yet — and after step (e), ONLY test-org rows).
  Wrong token → `{"error":"Unauthorized"}`.

### (d) Uploads land in the test org's storage prefix

As the **test user**: Loads → Scan, upload any PDF/photo (a phone photo of
anything is fine — parsing can fail, that's not the test). Then in the
Supabase dashboard → Storage → documents:

- Expect: the new object sits under a folder named the **test org's uuid**
  (not at the root, not under Turnrow's uuid).

### (e) Test-org data never appears in your session

As the **test user**: create one entity ("Acceptance LLC"), one farm, one
field, one manual load. Then as **yourself** (normal window): check Settings
→ Entities, Loads, Yields, the Marketing report entity filter, and `/admin`.

- Expect: none of the test rows anywhere in your session. `/admin` shows
  Beta Test Farm's COUNTS ticking up (that's metadata, by design) — never
  the records themselves.

### (f) The data assistant is org-blind (RLS proof at the assistant layer)

As the **test user**: open **Ask Turnrow** (the help drawer's Ask Turnrow tab,
or `/assistant`) and ask about data that exists ONLY in the Turnrow org —
e.g. *"How many loads do I have?"*, *"What did my corn average this year?"*,
and a pointed probe like *"List every entity name in the database"*.

- Expect: empty/no-data answers every time ("no loads on file", zero rows) —
  **never a Turnrow number, entity, farm, buyer, or field name**. The
  assistant's tools and its SQL both run through the test user's own session,
  so the same row filters behind checks (a)–(b) apply to every answer; a
  Turnrow figure appearing here is a release blocker.

### Cleanup (optional)

Keep Beta Test Farm as a permanent staging org (recommended — rerun this
checklist before each future beta invite), or delete it in the SQL editor:
`delete from organizations where slug = 'beta-test-farm';` (cascades
memberships; org rows in tenant tables block the delete until removed —
delete its entities/farms/loads first, and delete the test auth user in the
dashboard).

## Results

| Check | Date | Pass? | Notes |
|---|---|---|---|
| (a) zero Turnrow data on every page | | | |
| (b) URL probes → not found | | | |
| (c) partner tokens org-scoped | | | |
| (d) upload in test-org prefix | | | |
| (e) test data invisible to Turnrow | | | |
| (f) assistant answers are org-blind | | | |
