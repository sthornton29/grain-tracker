---
page_route: /reports/season
title: Season Summary
updated: 2026-10-05
keywords: season, acres, yield, bushels, irrigated, dryland, double crop, double-crop, full-season, harvest, cotton, lint
---
## What this page is for

The Season Summary is the one-table answer to "what did we plant and what did it make?" For a chosen crop year it shows every crop with its acres — full-season, double-crop, total, irrigated, and dryland — plus total dry bushels and yield per acre, with a grand total row at the bottom. Headline tiles above the table show total acres (with the irrigated and dryland split underneath), dry bushels from finished fields, the weighted yield across those fields, and the share of acres harvested so far.

## How to use it

The report opens on the current crop year; pick another at the top. If you run more than one entity, use the entity filter to narrow the report to one of them — acres, production, and yield then reflect that entity's fields only. Leave it on all entities for the whole operation. Both filters are remembered between visits.

When harvest is running, check back as loads come in: the production and yield columns build up as fields finish.

## What the controls do

- **Crop year** — chooses the crop year the whole page reports on.
- **Entity filter** — narrows acres and production to the fields belonging to that entity's farms.
- **Export Excel / Export PDF / Print** — exports the table exactly as shown, with the season and entity named in the header.

## How the numbers work

- **Acres** count every planted field, split into full-season and double-crop, and into irrigated and dryland where you have entered that breakout. A field is double-crop when its crop is marked Double-crop under Settings → Crops and the same field grew a spring-harvest crop (wheat, canola) that year.
- **Full-season and double-crop rows.** A crop grown both ways in the year gets two indented rows under its line — **Full-season** and **Double-crop** — each with its acres, bushels, and yield. They always add up to the crop's row exactly; nothing is estimated. The export carries the same sub-rows.
- **Dry bushels** come from your recorded loads, adjusted to each crop's base moisture — the same dry-bushel rules used everywhere else in Turnrow.
- **Yield per acre** divides production by the acres of fields that are actually finished. Fields that are unharvested or still in progress are left out of both production and yield, so a half-picked field never drags the average down. Their acres still show in the acreage columns. The **% harvested** tile is finished acres over all planted acres; the **weighted yield** tile is grain bushels over finished grain acres.
- **Average yields** for recent seasons appear in the header strip, computed the same way.
- **Cotton** rows keep their acres in this table, but production and yield for cotton are measured in pounds of lint, not bushels — the row points you to the Cotton section below, which lists every cotton field for the year: seed cotton pounds and pounds per acre, lint pounds and pounds per acre (marked **est.** while the cotton is picked but not ginned, at the turnout shown in the section header), turnout, bales, and the field’s harvest status (from its seed cotton loads, the same rules as grain) beside its ginning status (on yard / partly ginned / ginned). Tap a row for its loads and gin receipts.

## Common questions

- **Why is my yield higher than I expected mid-harvest?** Only finished fields count toward yield. If your best ground came off first, the early average reflects that and will settle as the rest is harvested.
- **Why does a crop show acres but no bushels?** Either no loads are recorded for it yet, or its fields are still marked in progress. Cotton crops intentionally show no bushels — see the Cotton section instead, where a picked field shows its seed cotton right away and its lint as an estimate until the gin receipt comes in.
- **Why don't the irrigated and dryland columns add up to total acres?** Those columns only fill in where you have recorded the irrigated/dryland breakout on the field or planting. A dash means no breakout was entered.
- **Does the entity filter change yields?** It changes which fields are included. Yields are then computed from that entity's fields alone, so they can differ from the whole-operation figure.

## If something looks wrong

If production looks low, check the Loads page for missing or misdated loads — a load recorded under the wrong crop year will not appear here. If a field you know is finished still is not counting, its harvest status may need updating on the Yields page, where you can also force a field to be included. If numbers still do not add up after checking loads and field status, contact support.
