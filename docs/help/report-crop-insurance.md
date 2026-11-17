---
page_route: /reports/crop-insurance
title: Crop Insurance Production Report
updated: 2026-11-17
keywords: crop insurance, production report, insurance agent, county, practice, irrigated, dryland, certified acres, yield, breakout, APH, excel, workbook, farm, FSA farm number, county sheets, formulas, load data, balanced to settlements, production basis, settled bushels, factor
---
## What this page is for

This report lays out your production the way your crop insurance agent needs it: by county and by practice (irrigated vs dryland). When it's time to certify production after harvest, you can hand your agent this one report instead of digging through load tickets. It shows certified acres, total production, and yield per acre for every crop, split by county and practice.

## How to use it

- The report opens on the current crop year (or the newest year with plantings the first time). Pick another **crop year** at any time — your pick is remembered.
- Narrow by **entity** if different entities carry different policies.
- Choose the **production basis**: **Measured (scale tickets)**, the default, or **Balanced to settlements** (see below). The choice is remembered like the other filters.
- Use the **crop chips** to include only certain crops. Leaving them all off means every crop shows. The chips only offer crops you actually planted in the selected year and entity.
- Export with the **Excel**, **PDF**, or **Print** buttons at the top right. They appear once the report can be generated — a year picked, no fields waiting on a breakout, and at least one sheet. Every format opens on what you see on screen: the **Summary**, then one page per county and practice listing each farm with its FSA farm number, in the same three groups — Certified Acres, Production, and Yield per Acre — with the unit beside each crop (bu, lbs). The production basis is named at the top; when balanced, the PDF also prints the reconciliation. **The Excel file adds the records behind the report** on the tabs that follow (see below), with every number a live formula that traces back to the loads.

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

## The Excel workbook

The Excel file is laid out for the person you send it to. It opens on the same report you see on screen, and the records behind it sit on the tabs that follow.

**The report (green tabs):**

- **Summary** — one line per county and practice, with certified acres, production and yield per acre for each crop, and a Total row. When balanced, the Production and Yield groups show the balanced figures and the measured figures stay beside them. Under the table is a list of every other tab, each a link.
- **One tab per county and practice** (for example, "Lawrence County Irrigated") — each farm with its FSA farm number, and its certified acres, production and yield for the crops grown there, with a Total row that matches the Summary line. Two farms that share a name in the same county appear as one row with both FSA numbers.

**The records behind it:**

- **Settlement Balance** (balanced only) — settled, delivered-not-settled and still-in-bins, the balanced total, the factor, and a check.
- **Field Production** — one row per field and practice: farm, field, FSA farm number, county, crop, acres, where the production came from (scale tickets, the combine monitor, or gin receipts), how it was split between practices, production and yield, and the rule in plain words. A field name is a link to its loads.
- **Load Data** — one row per load that counts (a split load gets one row per field share): date, ticket numbers, truck, farm, field, destination, gross / tare / net pounds, moisture, and the shrink to dry bushels. Each row has an **Open** link to the load in Turnrow.
- **Combine Entries** (when any) — bushels from the yield monitor and the calibration adjustment.
- **Gin Receipts** and **Bales** (cotton) — receipts with modules, seed cotton, bales, lint pounds and turnout; cotton picked but not yet ginned is its own row marked "estimated, not ginned".
- **Settlements** and **Unsettled Deliveries** (balanced only) — every settlement line counted, and every delivered load with no settlement yet.
- **Notes** — how the numbers are worked out, a guide to every column, and a check that the workbook's totals equal the totals on your screen (OK or CHECK).

**Finding your way around:** on every tab the column headings stay in place as you scroll down, and the columns that name the row (county and practice, farm and field, date and ticket) stay in place as you scroll right. Every tab has a **← Summary** link at the top left. The detail tabs have filter buttons on their headings so you can narrow to one farm or one field.

**To trace a number:** click a cell on the Summary or a county tab and read its formula; it names the farm, county, crop and practice it adds up. Find those rows on Field Production, then click the field name to jump to its loads on Load Data. Change a load's net pounds or moisture and every total above it recalculates.

**Blue and black:** blue numbers are values straight from your Turnrow records — weights, moisture, acres, entered breakouts, combine entries, gin receipts, settlement lines. Black numbers are formulas. Check cells show green for OK and red for CHECK.

**Why bin loads aren't listed:** production is counted when grain leaves the field. A load hauled out of a bin is the same grain a second time, so listing it would double count. (Bin-out loads do appear on the Settlements tab when balanced, because the buyer paid for them.)

## Common questions

- **Why is a field missing?** Its harvest probably isn't complete yet — it is listed under the filters as still harvesting. If it is truly done, tap Count anyway there or on the Yields page.
- **Why is the report blocked?** One or more mixed-practice fields finished harvest without a production breakout. Enter the irrigated/dryland split on the Yields page, or accept the option to roll it into dryland.
- **Can I report one crop at a time?** Yes — use the crop chips. Only the selected crops (and their fields) count.
- **Does the export match the screen?** Yes. The PDF and the first tabs of the Excel file show the same Summary and the same county-by-practice farm pages as the screen, and the Excel file's Notes tab checks its totals against the screen for each crop.
- **Which tabs does my agent need?** The green ones: Summary and the county tabs. The rest are there if an adjuster asks to see the fields and scale tickets behind a number.
- **The balanced factor looks wrong.** Check the panel: an unmatched settlement line can't count until it is matched to its load, and a delivery with no settlement yet counts at your own dry bushels until the settlement arrives. A factor more than 5% from 1 usually means a settlement or a load is missing.
- **The Notes tab says CHECK.** The workbook's formulas and the screen disagree for that crop. The usual cause is a mixed field whose entered breakout no longer adds up to its loads (its Field Production check cell will also say CHECK) — re-enter the breakout on the Yields page.

## If something looks wrong

- If acres look off, check the field's total and irrigated acres under Settings, and the planting's acres for that year.
- If production looks low, make sure all loads for the field are entered and any split loads are allocated correctly. The notice under the filters lists every load of the year the report left out, with the reason.
- If a county is missing, confirm the field is assigned to a county in Settings.
- If none of that explains it, contact support.
