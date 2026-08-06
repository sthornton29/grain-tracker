---
page_route: /reports/crop-budget
title: Crop Budget Planner
updated: 2026-08-05
keywords: budget, planning, pre-season, acres, yield, cost, price, matrix, breakeven, APH, futures, sandbox
---
## What this page is for

The Crop Budget Planner is a pre-season sandbox for the question "what should I plant next year?" You build one budget per budget crop year: for each crop, a grid of acres, yield, and cost — overall plus irrigated/dryland and full-season/double-crop rows — with a price for the budget year, and underneath it a price × yield matrix showing revenue or profit per acre across a range of outcomes. Nothing you do here touches your real marketing numbers, assumptions, or actuals — it is planning only.

## How to use it

Pick the budget year in the header. Each crop you planted this year appears with a starting point already filled in: yields seeded from your APH (per practice, where your policies have it), costs from this year's cost assumptions, and price from the live budget-year new-crop futures quote. Type over any of it — the seeded values are a starting point, not a verdict. Add a crop you did not plant this year with **Add crop**; take one out with **Remove from budget**. The summary band totals the whole plan so you can compare crop mixes at the operation level.

## What the controls do

- **Budget year selector** — each budget year keeps its own budget; switch years to work on a different plan.
- **⚙ Assumptions** — the editing panel, one collapsible section per crop, with the acres/yield/cost grid. A blank breakout cell falls back to the crop's Overall row, the same convention as the Marketing Dashboard.
- **Price, edit-in-place** — each crop's price defaults to the live budget-year futures quote (marked "live" with its quote date). Typing over it switches the crop to a manual price; the ↻ button restores the live quote. Basis is its own field alongside.
- **Blended | Broken out** — Broken out shows one output section per breakout row (irrigated, dryland, and so on); Blended shows one acre-weighted section per crop.
- **Revenue | Profit** — what the matrix cells show.
- **Export Excel / PDF / Print** — the budget with the budget year, view, and quote date in the filter line.

## How the numbers work

Each row's math is straightforward: (price + basis) × yield − cost per acre, times acres for totals. Breakevens show the price or the yield at which the row covers its cost. The matrix repeats that calculation across a spread of prices and yields around your inputs, so you can see how much room a plan has before it goes under water.

Seeded values show where they came from until you edit them — APH for yields, this year's costs, the live quote for price. Once you type a number, it is yours and stays.

## Common questions

- **Does this change my real numbers?** No. The planner never writes to your marketing assumptions, contracts, or production records. It is a separate scratch pad per budget year.
- **Can I compare different plans?** Each budget year holds one budget. To compare crop mixes, adjust the acres between crops and watch the summary band, or export a copy before changing course.
- **Why is a crop's price marked manual?** You typed over the live quote. Press ↻ next to the price to go back to the live futures value.
- **Where do the starting yields come from?** Your APH by practice where your insurance records have it, otherwise your expected-yield breakouts. Double-crop rows seed from double-crop figures.

## If something looks wrong

If a crop shows no price, its budget-year futures quote was not available — type a price in the Assumptions panel, and the ↻ will pick the quote back up when it can. If seeded yields look off, check your APH entries under crop insurance and your expected yields on the Marketing Dashboard, since the seeds come from there. Otherwise, contact support.
