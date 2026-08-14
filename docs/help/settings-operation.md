---
page_route: /settings
title: Operation Settings
updated: 2026-08-14
keywords: settings, entities, marketing agent, farms, FSA number, fields, crops, plantings, varieties, bins, capacity, trucks, hauler trucks, buyers, landowners, share rent, physical sales complete, import, blank columns, double-crop
---
## What this page is for

Settings is the hub where your operation's structure lives — the entities, farms, fields, crops, and people everything else hangs on. Get these right once and the rest of the app mostly fills itself in.

## How to use it

Work top-down the first time: entities, then farms, then fields, then crops and plantings. After that you'll only visit to add a field, a truck, or a new crop year's plantings.

## Setting up from your paperwork

Every setup page here has an **Upload (AI)** card, and the top of Settings has an **Upload any document (AI)** card that takes anything — leases, FSA farm records, plat maps, acreage reports, plain lists. One upload reads the whole document and sorts what it finds into the right places (a lease fills in the landowner, the farm, and the share terms together), grouped for your review — nothing saves until you check it. See the Uploading Documents topic for the full picture.

## Spreadsheet imports: blanks are fine

In every spreadsheet import here, **a blank cell in an optional column never fails the row** — only each import's starred required columns can. Leave what you don't track blank: a blank share-rent cell simply means not share rent, a blank percentage stays empty, a blank landowner leaves the farm unlinked. You can also leave whole optional columns out of the file.

## What the controls do

- **Entities** — your legal entities and the counties they operate in, plus each entity's FSA eligible-persons count for payment limits (set once; the total ARC/PLC cap is persons times the program year's per-person limit). An entity can also be marked a **marketing agent**: one entity that holds the contracts and hedge account on behalf of the whole operation. In entity-filtered reports, the agent's marketing flows down to each farming entity by that entity's share of the crop's planted acres — so income lands where the grain was grown. A farming entity that markets in its own name keeps those contracts whole.
- **Farms** — each farm's entity, county, **FSA number**, and landowner, plus the **share-rent flag and landlord share percentage** that drive the Share Rent Report. The spreadsheet import takes all of it — entity and landowner match by name against what already exists, counties match by **name plus two-letter state** together — the state column is required whenever a county is given, and "Lawrence County" or plain "Lawrence" both match — and share rent comes in as yes/no with the landlord percent. If your operation has one entity, Turnrow fills it in for you: the entity dropdown disappears from the farm form and the spreadsheet can leave the entity column out entirely. Deleting a farm removes its fields too.
- **Fields** — total and irrigated acres (dryland is derived), county, and each field's plantings. Import by CSV or by **AI upload** of a document. A farm filter narrows long lists.
- **Crops** — each crop's base moisture and pounds per bushel (the standards dry-bushel math uses), its **harvest category** (fall or spring — spring-harvest crops like wheat are what make a later planting count as double-crop), and the double-crop designation. This page also holds **"Physical Sales Complete for the Year?"**: when a crop year's grain or cotton is fully sold, mark it here — shrink and small leftovers mean the sold-versus-production numbers rarely land on exactly zero, so this checkbox is how you tell Turnrow the year's selling is truly finished. The same checkboxes sit at the bottom of the Marketing Dashboard, so you can flip it from either place.
- **Plantings** — what's planted where, per field, crop, and season, with one or more varieties per planting. Import by CSV or **AI upload**; both recognize variety-name spellings that differ only by brand prefix and ask you whether to link or keep them separate, so "DG 3644" and "Dyna-Gro 3644" don't become two varieties. Two things worth knowing: **acres default to the whole field** — leave planted acres blank (in the spreadsheet or on the form) and the field's full acres fill in, shown as "from field acres" so you can override it; and **one row per crop** — a field that grew wheat and then double-crop soybeans is two rows for the same field and season year, and both may claim the field's full acres. That overlap is normal; the form points it out as information, not a conflict.
- **Varieties** — every variety with usage counts, inline rename (renaming onto an existing spelling merges them), and a find-similar tool for cleaning up duplicates pair by pair.
- **Bins & Sites** — your storage sites and bins, with current bushels on hand per bin. Add a site's bins right on the same form (type the names, comma-separated), or bring bins in from a spreadsheet — each row names the bin, its site, and optionally the crop it holds and its capacity. Each bin also takes an optional **Capacity (bu)**: set it and Bin Inventory shows a percent-full bar for that bin (bin-to-bin grain transfers are recorded there too).
- **Trucks** — the truck list the load form offers. You can also add a truck without leaving the load form (**+ Add truck…** in its Truck dropdown). Below your own trucks sits the separate **Hauler Trucks** list — buyers' and hired haulers' trucks saved from pickup-contract loads. The two lists never mix; renaming or deleting a hauler truck doesn't change loads already entered.
- **Buyers** — buyers and their delivery locations, used by contracts and settlements. The spreadsheet import takes one row per buyer with all their delivery locations in one cell, separated by semicolons, each with an optional address after an @ sign — re-importing adds new locations to a buyer without touching the rest.
- **Landowners** — names and contact details, linked to farms for the landowner reports. Spreadsheet import with a downloadable template — bring landowners in before farms so the farms import can match their names.

## Common questions

- **What does deleting cascade to?** Deleting a farm deletes its fields; deleting a field deletes its plantings. The app confirms first.
- **Do I have to use the marketing-agent entity?** No — it's for operations where one entity does the selling for several farming entities. Skip it if each entity markets its own grain.
- **Why does "Physical Sales Complete" matter?** Some year-end checks compare what you produced with what you sold; this flag tells them to stop expecting more sales.

## If something looks wrong

- If reports group things oddly, check the farm's entity, county, and landowner assignments — most report groupings come straight from here.
- If dryland acres look wrong on a field, remember they're total acres minus irrigated acres.
- Anything else, contact support.
