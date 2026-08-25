---
page_route: /yields
title: Yields
updated: 2026-08-25
keywords: yields, bushels per acre, field, farm, entity, variety, landowner, irrigated, dryland, harvest, allocation, load tags, practice, season, export, detail, loads, tickets, moisture, test weight, split load, drill down, combine, yield monitor, no scales
---
## What this page is for

Yields turns your load log into bushels per acre. The same production can be viewed five ways — by field, by farm, by entity, by variety, or by landowner — for any season. It's where you compare fields, settle up with landowners, and see how irrigated ground did against dryland.

## How to use it

- Pick a view from the dropdown: **By field**, **By farm**, **By entity**, **By variety**, or **By landowner**.
- Narrow with the season, crop, farm, entity, and county filters. In the by-field view you can also filter to irrigated or dryland ground. Your filter choices are remembered, so the page comes back the way you left it.
- Toggle between **Total** and **Irrigated / Dryland breakdown** to split the yield columns by practice.
- **Tap any row to open its detail.** A field row shows the loads behind its yield; a farm, entity, or landowner row shows its totals plus a field-by-field breakdown, and each field there opens further into its loads — two taps from a landowner to a scale ticket.
- Export any view to a spreadsheet or a formatted report — the export carries exactly the columns you're showing on screen, and when a row's detail is open the export adds a Load Detail sheet for it.

## Reading the table

- Each view lists **Yield (bu/ac)** right after the acres, with **Dry bu** last — so the number you're usually after is visible without scrolling sideways on a phone or iPad.

## What the controls do

- **Harvest status.** A field that hasn't been harvested, or is only partway through, is left out of the yield math — a half-harvested field would drag every average down. In-progress fields are labeled so you can see they're pending. If a field really is done but Turnrow can't tell (say the last loads went straight to town under a different crop year), tap **Count anyway** on that field. Turnrow asks you to confirm, then treats the field as finished — it looks like every other completed field and its bushels go into the averages. Open the field's detail and tap **Undo** to put it back to automatic. A field whose yield runs well below the crop's average is what earns an in-progress label, and the label is deliberately sticky: cutting a few loads, moving to another field for a while, and coming back later is normal, so loads landing on other fields never mark this one finished. A low field only counts once you tap **Count anyway** or mark the crop's harvest complete — or after about ten days pass with nothing more hauled from it, which means the combine clearly isn't coming back. A field yielding in line with the rest of the crop is never held back. If a field truly finished with a poor yield — a real crop failure — Turnrow can't tell that apart from a field you'll come back to, so use **Count anyway** to put its number in the averages.
- **Allocate irr/dry.** A field with both irrigated and dryland acres has one pile of bushels but two practices. There are two ways to split it. The easy way: tag each load Irrigated or Dryland as you enter it — when every load on the field carries a tag, the split comes straight from the loads (the row shows **From load tags ✓**) and you're never asked to allocate. Otherwise, once the field's harvest is complete, an **Allocate irr/dry** button lets you split the field's dry bushels between the two — type one side and the other side fills in so the split always totals the field's bushels. If some loads are tagged, the allocation opens pre-filled from those tags so you only complete the remainder. A manual allocation, once saved, stays in charge even if load tags change later — clear it to go back to using the tags. Until the field is split one way or the other, it counts in the overall total but sits out of the irrigated and dryland columns.
- **Allocate bushels (varieties).** A planting with a single variety credits all its bushels to that variety automatically. A planting with two or more varieties shows in the variety view only after you allocate its bushels among them — the page lists the plantings that still need allocation once their harvest is complete.
- **By landowner** groups production by the landowner on each farm, split-aware, for rent conversations and year-end summaries.
- **Row detail.** The detail's summary line shows load count, total pounds, wet and dry bushels, the average moisture and test weight (weighted by each load's pounds, so an 80,000-lb pair at 16.0 and 18.0 moisture averages by weight — not a simple midpoint), the first-to-last load dates, and how the bushels split between bins and buyers. The load list carries date, ticket, truck, weights, moisture, test weight, and destination; a load split across fields shows just this field's share with a badge like "split — 14,200 of 34,300 lbs". Fields flagged in-progress carry the same flag on their detail, so the list always matches the number above it; a field you counted as finished shows a small note there with the Undo. Cotton fields show gin receipts, bales, turnout, and loan values in pounds instead of grain loads.

## Tracking harvest without scales

- A field entered with **Yield from Combine** (on the Loads page) shows here exactly like a weighed field — its production is the combine entry's adjusted total, and the row works in every view, filter, and export.
- Its detail opens with a labeled **Combine entry** line above any weighed loads, showing the adjusted total and the netting: weighed loads are subtracted from the combine figure, and the remainder is what sits in storage (in the destination bin, if one was picked). The weighed loads keep their own rows — tickets, weights, destinations — they're just never counted twice.
- The entry's **"Harvest complete"** checkbox decides whether the field counts now: checked, the field is done and its yield is in the averages; unchecked, it shows as in progress until you finish it.
- If the weighed loads from a field total more than its combine entry, the detail shows a warning instead of quietly hiding the difference — check the entry or its adjustment.
- Mixed irrigated/dryland fields entered by combine allocate the same way as everyone else: enter the split on the combine entry if the monitor shows it, or use **Allocate irr/dry** here after harvest.

## How the numbers work

- **Yield = dry bushels ÷ planted acres.** Bushels come from your loads (shrunk to dry at each crop's base moisture) — or from the field's combine entry where you used one — matched to a planting by field, crop, and crop year. Acres come from the planting.
- In the breakdown, a field that's all irrigated or all dryland reports its whole yield under that practice; mixed fields use the split from their load tags or your manual allocation — every report (insurance, claims, per-practice yields) reads the same split either way.
- Farm, entity, and variety views are the same math rolled up — the totals foot back to the by-field view under the same filters.

## Common questions

- **Why is a harvested field missing from the averages?** Turnrow still sees it as unharvested or in progress. Check that its loads carry the right field, crop, and crop year — or use Count anyway.
- **Why is the irrigated column blank for a field I know is irrigated?** It's a mixed field without a complete split yet. Tag its remaining loads Irrigated/Dryland, or Allocate irr/dry once it's finished.
- **My yield looks too low.** Usually acres: check the planting's acres, and check for loads recorded against the wrong field or year.
- **Do bin loads count?** Yes. Any load leaving the field counts toward that field's production, whether it went to a bin or to town.
- **A variety I planted isn't in the variety view.** Its planting has multiple varieties and hasn't been allocated, or the variety was never recorded on the planting under Settings → Plantings.

## If something looks wrong

- Check the season and filters first — last visit's filters are remembered and are the usual culprit.
- Compare the field's loads (Loads page, filtered to the field and year) against the bushels shown.
- Verify planted acres and varieties on the planting.
- If the views won't foot after that, contact support.
