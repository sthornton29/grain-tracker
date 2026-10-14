---
page_route: /reports/crop-insurance
title: Crop Insurance Production Report
updated: 2026-10-14
keywords: crop insurance, production report, insurance agent, county, practice, irrigated, dryland, certified acres, yield, breakout, APH, audit workbook, excel, formulas, load data, balanced to settlements, production basis, settled bushels, factor
---
## What this page is for

This report lays out your production the way your crop insurance agent needs it: by county and by practice (irrigated vs dryland). When it's time to certify production after harvest, you can hand your agent this one report instead of digging through load tickets. It shows certified acres, total production, and yield per acre for every crop, split by county and practice.

## How to use it

- The report opens on the current crop year (or the newest year with plantings the first time). Pick another **crop year** at any time — your pick is remembered.
- Narrow by **entity** if different entities carry different policies.
- Choose the **production basis**: **Measured (scale tickets)**, the default, or **Balanced to settlements** (see below). The choice is remembered like the other filters.
- Use the **crop chips** to include only certain crops. Leaving them all off means every crop shows. The chips only offer crops you actually planted in the selected year and entity.
- Export with the **Excel**, **PDF**, or **Print** buttons at the top right. They appear once the report can be generated — a year picked, no fields waiting on a breakout, and at least one sheet. PDF and Print mirror what's on screen in the three metric groups — Certified Acres, Production, and Yield/Acre — using the wording your agent's form expects ("Bu. Or Lbs."), and name the production basis in the filters line; when balanced, the PDF also prints the reconciliation. **Excel is the audit workbook** (see below): the same Summary, with every number a live formula that traces back to the loads.

## What the controls do

- **Crop year** — the harvest year you're reporting.
- **Entity** — limits the report to farms owned by one entity.
- **Production basis** — measured scale-ticket bushels, or production balanced so the bushels paid for match your records.
- **Crop filter chips** — toggle crops in or out. This also affects which fields can hold up the report: filtering to corn means a soybean field that still needs attention won't block your corn report.
- **Enter breakouts on Yields** — a shortcut to the Yields page when the report asks you to split a field's production between irrigated and dryland acres.
- **Count anyway** — next to a field listed as still harvesting. Treats its bushels as final so it counts in the report (the same switch the Yields page offers).

## How the numbers work

- Production comes from your recorded loads, with split loads credited to the right fields. Each load's dry bushels use the crop's base moisture and pounds per bushel from Settings → Crops. A field entered from the combine monitor (Yield from Combine) uses that entry as its production, with any scale tickets from the field netted inside it. Cotton reports pounds of lint from gin receipts, plus an estimate at the resolved turnout for cotton picked but not yet ginned.
- Certified acres are the planting's irrigated and dryland acres for the year. County comes from the field, or from the farm when the field has none.
- A field planted **part irrigated and part dryland** needs its production divided between the two practices before it can appear here, because insurance treats the practices separately. The report will list the fields that need this and pause until you either enter the breakout on the Yields page or choose to count the whole field as dryland. If every load from a mixed field carries an irrigated/dryland tag, the breakout comes from the loads and nothing is asked.
- That question is only asked **once a field's harvest is complete**. A field still being harvested is **left out of the report** — its acres and its bushels — and listed under the filters, so a half-harvested field never certifies a misleading yield. Tap **Count anyway** next to it if it is actually done. A field with no loads yet keeps its acres and shows no production.
- Any load of the crop year the report leaves out is listed under the filters with its reason and a link — a load hauled in a different calendar year than its crop year (it is credited to that year's planting of the field), a load from a field with no planting for the crop and year, a load with no crop year, a load with no bushels. Nothing is hidden.
- Yield per acre is production divided by certified acres for each county and practice combination. Total rows divide total production by total acres — never an average of the yields.

## Balanced to settlements

An auditor compares the production you report to the bushels the buyers paid for. Scale-ticket dry bushels never match buyer net bushels exactly — buyers apply their own shrink, foreign material and dockage. **Balanced to settlements** adjusts production so the bushels paid for match your records.

For each grain crop and crop year, across every entity (settlements and bins mix entities' grain):

- **Settled (paid)** — the buyer's net bushels on every saved settlement line whose matched load is this crop and year. Field-direct and bin-out loads both count; each line counts once.
- **Delivered, not settled** — your dry bushels on loads delivered to a buyer with no settlement line yet, price-later deliveries included.
- **Still in bins** — the book inventory for the crop year: loads hauled into bins minus loads hauled out, plus combine remainders posted to a bin. Measure your bins to support farm-stored production.
- **Balanced total** = settled + delivered not settled + still in bins. **Factor** = balanced total ÷ measured production. Every field's balanced production is its measured production × the factor. An entity filter still uses the crop-wide factor.

When nothing is unsettled and the bins are empty, the balanced total is exactly the bushels paid, and the balanced production sums to it. The panel under the filters shows each piece, the number of settlements and unsettled loads (with links), and the factor both ways (0.9838 and −1.62%). A factor more than 5% from 1 is shown in amber: check for a missing settlement or load. Settlement lines that aren't matched to a load have no crop and can't count; the panel says how many and links to Settlements so you can match them. Loads from fields still being harvested enter no side of the balance.

Balancing is a report option only. Yields, Marketing, the Claims Monitor and the partner API keep measured production. Cotton is never balanced — it already reports the gin's lint.

## Audit workbook (Excel export)

The Excel export is built for an auditor. Every number on the Summary tab is a live formula, so anyone can click a cell and follow it back to the loads behind it. The workbook opens on Summary with a title block (organization, report, crop year, crops, entity, production basis, generated time), a KPI strip, a Contents line linking every tab, and the county × practice table.

- **Summary** — the county × practice layout per crop. Acres and production are `SUMIFS` over the Field Production tab; yield is production ÷ acres; the Total row sums the rows above. When balanced, the Production and Yield groups read the balanced figures and the measured figures stay visible as their own group.
- **Settlement Balance** (balanced only) — the reconciliation as live formulas: settled sums the Settlements tab, delivered-not-settled sums the Unsettled Deliveries tab, still-in-bins is a blue input with its source, then the balanced total, the factor and a check. When nothing is unsettled and the bins are empty, a second check reads "Production equals bushels paid".
- **Field Production** — one row per planting and practice: farm, field, FSA farm number, county, state, crop, crop year, practice, harvest status, acres, scale-ticket bushels (a `SUMIFS` over Load Data matching the row's own Farm, Field, Crop and Crop Year), combine-entry bushels, the entered irrigated/dryland breakout for mixed fields, the field total, the practice share, measured production and yield, balanced production and yield when balanced, a check cell, and the rule in plain words. The field name links to its first load.
- **Load Data** — one row per load that counts (a split load gets one row per field share), sorted so each field's loads sit together: date, ticket numbers, truck, farm, field, county, crop, practice tag, destination, gross/tare/net pounds, split %, net pounds applied, moisture, base moisture, pounds per bushel, wet bushels, dry bushels (the app's shrink math as an Excel formula), override flag, test weight, and the matched settlement number and buyer net bushels as cross-checks.
- **Combine Entries** (when any) — bushels from the yield monitor, the calibration adjustment, the harvest-complete flag, and how many scale-ticket bushels are netted inside the entry.
- **Gin Receipts** and **Bales** (cotton) — receipts with modules, seed cotton, bales, lint pounds and turnout; picked-but-unginned cotton is its own row marked "estimated, not ginned", never mixed silently with ginned lint.
- **Settlements** and **Unsettled Deliveries** (balanced only) — every counted settlement line (settlement, date, buyer, ticket, load, source field or bin, net bushels in blue) and every delivered load with no settlement yet.
- **Notes** — how the workbook is built, the shrink formula in words and as Excel, the balance rule when balanced, the filters, the organization and the generated time, and a reconciliation block comparing Turnrow's on-screen total to the workbook's formula total per crop (OK or CHECK).

**To trace a number:** click a Summary cell and read its `SUMIFS`; the criteria name the county, state, crop and practice. Find those rows on Field Production, then click the field name to jump to its loads on Load Data (or match Farm + Field + Crop + Crop Year). Change a load's net pounds or moisture and every total above it recalculates. Two plantings that would read alike (same farm, field, crop and year) get the field name disambiguated — "North 40 (2)" — on every tab, and Notes says so.

**Blue and black:** blue cells are values straight from your Turnrow records — weights, moisture, acres, overrides, entered breakouts, combine entries, gin receipts, settlement lines. Black cells are formulas. Check cells show green for OK and red for CHECK. The Notes tab ends with a column guide explaining every column on every tab.

**Why bin loads aren't listed:** production is counted when grain leaves the field. A load hauled out of a bin is the same grain a second time, so listing it would double count. (Bin-out loads do appear on the Settlements tab when balanced, because the buyer paid for them.)

## Common questions

- **Why is a field missing?** Its harvest probably isn't complete yet — it is listed under the filters as still harvesting. If it is truly done, tap Count anyway there or on the Yields page.
- **Why is the report blocked?** One or more mixed-practice fields finished harvest without a production breakout. Enter the irrigated/dryland split on the Yields page, or accept the option to roll it into dryland.
- **Can I report one crop at a time?** Yes — use the crop chips. Only the selected crops (and their fields) count.
- **Does the export match the screen?** Yes. Every column and metric group on screen appears in the PDF, and the Excel workbook's Notes tab reconciles its formula totals to the screen per crop.
- **The balanced factor looks wrong.** Check the panel: an unmatched settlement line can't count until it is matched to its load, and a delivery with no settlement yet counts at your own dry bushels until the settlement arrives. A factor more than 5% from 1 usually means a settlement or a load is missing.
- **The Notes tab says CHECK.** The workbook's formulas and the screen disagree for that crop. The usual cause is a mixed field whose entered breakout no longer adds up to its loads (its Field Production check cell will also say CHECK) — re-enter the breakout on the Yields page.

## If something looks wrong

- If acres look off, check the field's total and irrigated acres under Settings, and the planting's acres for that year.
- If production looks low, make sure all loads for the field are entered and any split loads are allocated correctly. The notice under the filters lists every load of the year the report left out, with the reason.
- If a county is missing, confirm the field is assigned to a county in Settings.
- If none of that explains it, contact support.
