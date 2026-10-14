---
page_route: /reports/crop-insurance
title: Crop Insurance Production Report
updated: 2026-10-14
keywords: crop insurance, production report, insurance agent, county, practice, irrigated, dryland, certified acres, yield, breakout, APH, audit workbook, excel, formulas, load data, not included
---
## What this page is for

This report lays out your production the way your crop insurance agent needs it: by county and by practice (irrigated vs dryland). When it's time to certify production after harvest, you can hand your agent this one report instead of digging through load tickets. It shows certified acres, total production, and yield per acre for every crop, split by county and practice.

## How to use it

- The report opens on the current crop year (or the newest year with plantings the first time). Pick another **crop year** at any time — your pick is remembered.
- Narrow by **entity** if different entities carry different policies.
- Use the **crop chips** to include only certain crops. Leaving them all off means every crop shows. The chips only offer crops you actually planted in the selected year and entity.
- Export with the **Excel**, **PDF**, or **Print** buttons at the top right. They appear once the report can be generated — a year picked, no fields waiting on a breakout, and at least one sheet. PDF and Print mirror what's on screen in the three metric groups — Certified Acres, Production, and Yield/Acre — using the wording your agent's form expects ("Bu. Or Lbs."); on screen each crop's column simply says **bu** or **lbs**. **Excel is the audit workbook** (see below): the same Summary, with every number a live formula that traces back to the loads.

## What the controls do

- **Crop year** — the harvest year you're reporting.
- **Entity** — limits the report to farms owned by one entity.
- **Crop filter chips** — toggle crops in or out. This also affects which fields can hold up the report: filtering to corn means a soybean field that still needs attention won't block your corn report.
- **Enter breakouts on Yields** — a shortcut to the Yields page when the report asks you to split a field's production between irrigated and dryland acres.
- **Count anyway** — next to a field listed as still harvesting. Treats its bushels as final so it counts in the report (the same switch the Yields page offers).

## How the numbers work

- Production comes from your recorded loads, with split loads credited to the right fields. Each load's dry bushels use the crop's base moisture and pounds per bushel from Settings → Crops. A field entered from the combine monitor (Yield from Combine) uses that entry as its production, with any scale tickets from the field netted inside it. Cotton reports pounds of lint from gin receipts, plus an estimate at the resolved turnout for cotton picked but not yet ginned.
- Certified acres are the planting's irrigated and dryland acres for the year. County comes from the field, or from the farm when the field has none.
- A field planted **part irrigated and part dryland** needs its production divided between the two practices before it can appear here, because insurance treats the practices separately. The report will list the fields that need this and pause until you either enter the breakout on the Yields page or choose to count the whole field as dryland. If every load from a mixed field carries an irrigated/dryland tag, the breakout comes from the loads and nothing is asked.
- That question is only asked **once a field's harvest is complete**. A field still being harvested is **left out of the report** — its acres and its bushels — and listed under the filters, so a half-harvested field never certifies a misleading yield. Tap **Count anyway** next to it if it is actually done. A field with no loads yet keeps its acres and shows no production.
- Yield per acre is production divided by certified acres for each county and practice combination. Total rows divide total production by total acres — never an average of the yields.

## Audit workbook (Excel export)

The Excel export is built for an auditor. Every number on the Summary tab is a live formula, so anyone can click a cell and follow it back to the loads behind it.

- **Summary** — the county × practice layout per crop. Acres and production are `SUMIFS` over the Field Production tab; yield is production ÷ acres; the Total row sums the rows above.
- **Field Production** — one row per planting and practice: farm, field, FSA farm number, county, state, crop, practice, harvest status, acres, scale-ticket bushels (a `SUMIFS` over Load Data by planting key), combine-entry bushels, the entered irrigated/dryland breakout for mixed fields, the field total, the practice share, production, yield, a check cell, and the rule in plain words.
- **Load Data** — one row per load that counts (a split load gets one row per field share): date, ticket numbers, truck, farm, field, county, crop, practice tag, destination, gross/tare/net pounds, split %, net pounds applied, moisture, base moisture, pounds per bushel, wet bushels, dry bushels (the app's shrink math as an Excel formula), override flag, test weight, and the matched settlement number and buyer net bushels as cross-checks.
- **Combine Entries** (when any) — bushels from the yield monitor, the calibration adjustment, the harvest-complete flag, and how many scale-ticket bushels are netted inside the entry.
- **Gin Receipts** and **Bales** (cotton) — receipts with modules, seed cotton, bales, lint pounds and turnout; picked-but-unginned cotton is its own row marked "estimated, not ginned", never mixed silently with ginned lint.
- **Not Included** — loads for the same crop year and filters that the report leaves out, each with its reason ("harvest in progress", "no planting for this field and crop", and so on). Listed for completeness; not counted in Summary.
- **Notes** — how the workbook is built, the shrink formula in words and as Excel, the filters, the organization and the generated time, and a reconciliation block comparing Turnrow's on-screen total to the workbook's formula total per crop (OK or CHECK).

**To trace a number:** click a Summary cell and read its `SUMIFS`; the criteria name the county, state, crop and practice. Find those rows on Field Production, then follow the row's planting key to Load Data. Change a load's net pounds or moisture and every total above it recalculates.

**Blue and black:** blue cells are values straight from your Turnrow records — weights, moisture, acres, overrides, entered breakouts, combine entries, gin receipts. Black cells are formulas.

**Why bin loads aren't listed:** production is counted when grain leaves the field. A load hauled out of a bin is the same grain a second time, so listing it would double count.

## Common questions

- **Why is a field missing?** Its harvest probably isn't complete yet — it is listed under the filters as still harvesting. If it is truly done, tap Count anyway there or on the Yields page.
- **Why is the report blocked?** One or more mixed-practice fields finished harvest without a production breakout. Enter the irrigated/dryland split on the Yields page, or accept the option to roll it into dryland.
- **Can I report one crop at a time?** Yes — use the crop chips. Only the selected crops (and their fields) count.
- **Does the export match the screen?** Yes. Every column and metric group on screen appears in the PDF, and the Excel workbook's Notes tab reconciles its formula totals to the screen per crop.
- **The Notes tab says CHECK.** The workbook's formulas and the screen disagree for that crop. The usual cause is a mixed field whose entered breakout no longer adds up to its loads (its Field Production check cell will also say CHECK) — re-enter the breakout on the Yields page.

## If something looks wrong

- If acres look off, check the field's total and irrigated acres under Settings, and the planting's acres for that year.
- If production looks low, make sure all loads for the field are entered and any split loads are allocated correctly. The Not Included tab of the Excel export lists every load of the year the report left out, with the reason.
- If a county is missing, confirm the field is assigned to a county in Settings.
- If none of that explains it, contact support.
