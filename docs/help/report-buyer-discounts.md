---
page_route: /reports/buyer-discounts
title: Buyer Discount Comparison
updated: 2026-08-28
keywords: buyer, discounts, comparison, lost revenue, moisture, drying, test weight, shrink, dockage, discount schedule, cents per bushel, contracted bushels, audit, quality adjusted
---
## What this page is for

Every buyer takes something off what you gross — but they don't take it the same way. One prints drying charges in dollars, another quietly pays you on fewer bushels than your scale says, a third does both. This report puts them all on one honest yardstick: **lost revenue from discounting, in cents per bushel**, by buyer, crop, and crop year. Price discounts count as the dollars taken off the check; volume cuts count as the bushels paid below your FSA-standard dry bushels, valued at that settlement's own price. One number, every mechanism.

## The lead number: lost ¢ per contracted bushel

When a settlement's loads deliver against a contract, the fairest denominator is the **contract's bushels** — that's the deal you priced, and it's what the discounting eroded. The lead column divides each buyer's lost dollars by their contracts' bushels (weighted across contracts); rank 1 is the cheapest buyer to sell to. Beside it, **lost ¢ per settled bushel** covers every settlement — and stands in (marked *spot/unlinked*) for buyers whose settlements have no contract behind them.

The category columns split the loss by type — moisture/drying, test weight, damage, FM/dockage, other, and **weight deduction** (pay-bushels taken beyond standard shrink that the statement didn't break out). The costliest type per buyer is highlighted. Tap a buyer's row to open its contracts, and each contract's settlements underneath.

## The other sections

- **Quality-adjusted detail** (collapsed by default) — corrects for the grain each buyer actually saw: their moisture/drying charges per point over base, their test-weight charges per pound light, with each buyer's average moisture and test weight shown so you can judge whether two buyers really got similar grain.
- **Published discount schedules** — each buyer's posted sheet side by side per factor. Schedules live with the buyer on Settings → Buyers (crop, effective date, the original document attached).
- **Expected vs actual** — the buyer's own published rules applied to your matched loads' known moisture and test weight, next to what they actually charged. A red flag means the charge ran materially above their own sheet — worth a phone call. Schedules carry effective dates, and the check always uses the sheet in force on the settlement date.

## How the numbers work

- **Lost revenue** = itemized price discounts (dollars off the check) **plus** the gap between your FSA-standard dry bushels and the buyer's pay bushels, valued at that settlement's own prices. When a statement itemizes its weight deductions (shrink pounds, FM weight), those lines say *which column* the gap lands in — the dollars are never counted twice.
- Settlements join a crop, crop year, and contract through their **matched loads** — a settlement with no matched loads doesn't appear. A buyer who paid on *more* bushels than standard shrink shows a negative (green) weight deduction.
- Category columns come from the itemized discount lines on each settlement (the AI upload fills them; you can add or fix them on the settlement's page). Un-itemized settlements still count in the totals, with their volume gap under Weight deduction.

For **read-only users**, the report covers the settlements whose matched loads belong to your granted entities.

## You can also just ask

The **Ask Turnrow** assistant answers from this same data: "What will [buyer] dock me for 17% corn?" reads the buyer's stored schedule (the app does the tier math, not the assistant), and "Who was cheapest on light test weight last year?" reads the settlement actuals behind this report.

## Common questions

- **Why does the lead column show an asterisk for a buyer?** Their settlements aren't linked to any contract — the settled-bushel figure stands in, and the row is marked spot/unlinked.
- **A buyer looks cheap here but their check always feels light.** Check their Weight deduction column — volume-style discounting never shows up as a price discount, but it shows up here.
- **Why is a buyer's moisture/drying column empty but their total isn't?** Their settlements aren't itemized. Open one and add its deduction lines in the Discounts section.
- **The audit flagged a settlement — now what?** Open it and compare the flagged factor's expected vs charged figures against the original statement. Flags are a reason to ask, not proof of a mistake.

## If something looks wrong

- A number that looks extreme usually traces to one small settlement — open the buyer's drill-down and check the settlements behind it.
- If a schedule's rules read wrong, delete it on the buyer's card (Settings → Buyers) and re-upload, correcting the rules on the review screen before confirming.
- Numbers that won't reconcile after that: contact support.
