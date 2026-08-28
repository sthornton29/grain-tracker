---
page_route: /reports/buyer-discounts
title: Buyer Discount Comparison
updated: 2026-08-28
keywords: buyer, discounts, comparison, moisture, drying, test weight, shrink, dockage, discount schedule, cents per bushel, audit, quality adjusted
---
## What this page is for

Every buyer takes something off your check — drying, test weight, dockage, and the weight their scale shrinks away. This report puts your buyers side by side, in cents per bushel, so you can see what each one really costs to sell to. The idea is simple: same crop, same year, similar grain — so a pattern where one buyer consistently deducts more is the buyer, not the grain.

## How to use it

Pick a crop year (required) and, if you like, a single crop. Four sections build on each other:

- **Actual discounts by buyer** — one row per buyer per crop: how many settlements, how many bushels, the total discounts in ¢/bu, that total broken out by type (moisture/drying, test weight, damage, foreign material/dockage, other), the weight taken beyond standard shrink, and the gross-to-net price. Buyers are ranked by total cost per bushel, and each buyer's costliest deduction type is highlighted. Tap a buyer's row to see the settlements behind it.
- **Quality-adjusted** — the honest layer. Raw averages can just mean you hauled wetter grain to one buyer, so this table divides each buyer's moisture/drying charges by how many points over base your grain actually ran, and their test-weight charges by how many pounds light it was. That gives a charge **per point** and **per pound** — like for like. Each buyer's average moisture and test weight sit beside the rates so you can judge whether two buyers really saw similar grain; when they did, the report says it plainly ("Buyer A charged 2.1¢ per point of moisture; Buyer B charged 3.4¢ on similar grain").
- **Published discount schedules** — upload each buyer's posted discount sheet (see below) and this table lines their rules up per factor: the pre-season "who's punitive on test weight this year" view.
- **Expected vs actual** — for each settlement, the buyer's own published rules are applied to your matched loads' known moisture and test weight, and the result is compared to what they actually charged. A red flag means the charge ran materially above their own sheet — worth a phone call. Schedules carry effective dates, and the check always uses the schedule that was in force on the settlement date.

## Uploading a discount schedule

Use **Upload discount schedule (AI)** at the bottom of this report (or on Settings → Buyers). Take a photo or upload the buyer's discount sheet; Turnrow reads the rules — where charges start, the rate per point or the bracket scale, rejection points — and shows them for review. Pick the buyer, crop, and effective date, then confirm. Nothing is saved until you confirm, and the sheet's own text stays attached to the record. When a buyer posts a new sheet mid-season, upload it too — the effective dates keep both in play, each applied to its own dates.

## How the numbers work

- All ¢/bu figures divide by the buyer's **settled (pay) bushels**.
- **Total disc ¢/bu** comes from the settlement lines' discount totals — the per-type columns come from the itemized discount lines on each settlement (entered by the AI upload or by hand on the settlement's page). A buyer marked "partly itemized" has settlements without that breakdown, so their per-type columns understate.
- **Excess shrink** is the gap between your FSA-standard dry bushels and the bushels the buyer paid on, priced at that settlement's own price. It's a real cost the price discounts never show — a buyer with mild discounts but a hungry scale shows up here.
- **Total cost ¢/bu** = price discounts + excess shrink; the ranking uses it.
- Settlements join a crop and crop year through their matched loads, so a settlement with no matched loads doesn't appear.

For **read-only users**, the report covers the settlements whose matched loads belong to your granted entities.

## Common questions

- **A buyer's per-type columns are empty but their total isn't.** Their settlements haven't been itemized. Open a settlement, and add its deduction lines in the Discounts section — the columns fill in.
- **Why is a buyer missing?** None of their settlements' lines matched to loads in the selected crop year. Match the lines on the settlement's page first.
- **The quality-adjusted table says it needs more data.** It can only rate buyers from itemized settlements whose matched loads carry moisture or test-weight readings — those come from your scale tickets on the Loads page.
- **The audit flagged a settlement — now what?** Open it, look at the flagged factor's expected vs charged figures, and check the original statement against the buyer's sheet. Flags are a reason to ask, not proof of a mistake — a load's grade sheet may show damage yours doesn't.

## If something looks wrong

- Rates that look extreme usually trace to one small settlement — tap the buyer's row and check the settlements behind it.
- If a schedule's rules read wrong, delete it on Settings → Buyers and re-upload, correcting the rules on the review screen before confirming.
- Numbers that won't reconcile after that: contact support.
