---
page_route: /yields
title: Yields
updated: 2026-08-05
keywords: yields, bushels per acre, field, farm, entity, variety, landowner, irrigated, dryland, harvest, allocation, season, export
---
## What this page is for

Yields turns your load log into bushels per acre. The same production can be viewed five ways — by field, by farm, by entity, by variety, or by landowner — for any season. It's where you compare fields, settle up with landowners, and see how irrigated ground did against dryland.

## How to use it

- Pick a view from the dropdown: **By field**, **By farm**, **By entity**, **By variety**, or **By landowner**.
- Narrow with the season, crop, farm, entity, and county filters. In the by-field view you can also filter to irrigated or dryland ground. Your filter choices are remembered, so the page comes back the way you left it.
- Toggle between **Total** and **Irrigated / Dryland breakdown** to split the yield columns by practice.
- Export any view to a spreadsheet or a formatted report — the export carries exactly the columns you're showing on screen.

## What the controls do

- **Harvest status.** A field that hasn't been harvested, or is only partway through, is left out of the yield math — a half-harvested field would drag every average down. In-progress fields are labeled so you can see they're pending. If a field really is done but Turnrow can't tell (say the last loads went straight to town under a different crop year), tap **Count anyway** on that field to include it; tapping again puts it back to automatic.
- **Allocate irr/dry.** A field with both irrigated and dryland acres has one pile of bushels but two practices. Once its harvest is complete, an **Allocate irr/dry** button lets you split the field's dry bushels between the two — type one side and the other side fills in so the split always totals the field's bushels. Until you allocate, the field counts in the overall total but sits out of the irrigated and dryland columns.
- **Allocate bushels (varieties).** A planting with a single variety credits all its bushels to that variety automatically. A planting with two or more varieties shows in the variety view only after you allocate its bushels among them — the page lists the plantings that still need allocation once their harvest is complete.
- **By landowner** groups production by the landowner on each farm, split-aware, for rent conversations and year-end summaries.

## How the numbers work

- **Yield = dry bushels ÷ planted acres.** Bushels come from your loads (shrunk to dry at each crop's base moisture), matched to a planting by field, crop, and crop year. Acres come from the planting.
- In the breakdown, a field that's all irrigated or all dryland reports its whole yield under that practice; mixed fields use your allocation.
- Farm, entity, and variety views are the same math rolled up — the totals foot back to the by-field view under the same filters.

## Common questions

- **Why is a harvested field missing from the averages?** Turnrow still sees it as unharvested or in progress. Check that its loads carry the right field, crop, and crop year — or use Count anyway.
- **Why is the irrigated column blank for a field I know is irrigated?** It's a mixed field without an allocation yet. Allocate irr/dry once it's finished.
- **My yield looks too low.** Usually acres: check the planting's acres, and check for loads recorded against the wrong field or year.
- **Do bin loads count?** Yes. Any load leaving the field counts toward that field's production, whether it went to a bin or to town.
- **A variety I planted isn't in the variety view.** Its planting has multiple varieties and hasn't been allocated, or the variety was never recorded on the planting under Settings → Plantings.

## If something looks wrong

- Check the season and filters first — last visit's filters are remembered and are the usual culprit.
- Compare the field's loads (Loads page, filtered to the field and year) against the bushels shown.
- Verify planted acres and varieties on the planting.
- If the views won't foot after that, contact support.
