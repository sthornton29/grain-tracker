---
page_route: /reports/dryer-math
title: Grain Dryer Math
updated: 2026-09-02
keywords: dryer, drying, propane, LP, natural gas, moisture, shrink, overdrying, cost per point, bushel point, calibrate, haul wet, discount schedule, assumptions, weight loss, depreciation, ownership cost, total drying cost
---
## What this page is for

What it costs to take a point of moisture out — and what it costs to take out one too many. Three inputs and the table answers: **Crop · Fuel · Fuel price**. The table is two columns — **Moisture** and **Total drying cost per bushel** — for every incoming moisture from bone-dry to 28%. Above base, the total is fuel, fan power, and dryer depreciation. Rows below base show the price of overdrying in red. It's a calculator, not a record book: nothing here tracks loads.

## Setting it up

- **Crop** — sets the base moisture from the crop's own standard (the same base the rest of Turnrow shrinks to).
- **Fuel** — propane or natural gas, with its price. If a saved dryer is selected, its fuel applies automatically.
- Everything else lives under **⚙ Assumptions**: your dryer (a saved one, a catalog model, or a standard 0.018 gal-LP-equivalent per bushel-point), the electric rate, the **depreciation** figure, the calibrate-from-records tool, and the grain price. The grain price only matters for the rows *below* base (overdrying) — it defaults to today's futures quote for the crop's reference contract, and you can type over it any time. The line under the inputs always says which dryer, depreciation figure, and grain price are in play.

## Reading the table

- **Rows above base** are incoming wet grain dried to base. The single figure is the **total drying cost** per bushel: fuel + fan electricity + depreciation. Hover a figure and it shows the breakdown.
- **The base row** is the stop line.
- **Rows below base** are the price of **overdrying**: every half-point past base gives away sellable grain *and* burns fuel removing water nobody pays for. These are the only rows that need a grain price. Hover the red figure for the split.

## Dryer depreciation

A dryer costs money to own, and that cost belongs in the price of drying: **≈ dryer investment ÷ useful life ÷ bushels dried per year** — for example $300,000 ÷ 15 years ÷ 500,000 bushels ≈ 4¢ a bushel, which is the starting figure. It's applied **flat to every bushel that goes through the dryer**, not per point: a bushel that lost two points and one that lost ten carry the same 4¢. Under ⚙ Assumptions you can type your own figure or fill in the three numbers and let the page work it out. Want full ownership costing? Raise the figure to fold in repairs and interest. The figure saves for your operation.

## Why shrink isn't a drying cost

The water above base moisture is unsellable either way. Haul it to town wet and the buyer's shrink table takes it off the ticket. Dry it yourself and it goes up the stack. You end up with the same dry bushels in both cases, so drying didn't cost you that weight — it was never yours to sell. What drying *does* cost you is the fuel, the fan, and the dryer. Below base it's a different story: that weight is real grain you could have sold, which is why the overdrying rows count it.

## Dry it or haul it wet

An optional comparison at the bottom (collapsed until you open it): pick a buyer whose discount schedule is on file and every wet row shows their moisture dock or drying charge beside your drying cost, with the call — *Dry it* or *Haul it wet* — and the savings. It's apples to apples: their shrink comes off whether you dry or haul, so it cancels out and only their charge and your cost remain.

**Depreciation in the comparison** is a checkbox there, on by default. If you own the dryer, its depreciation is spent whether or not this particular load runs through it — so for the marginal call on one load you may prefer to untick it and compare fuel and fan alone. Left on, the comparison prices your full cost of drying. Schedules live with the buyer under Settings → Buyers; you can also upload one right there in the section. Ask Turnrow can quote the same schedules in plain words.

## Calibrating from your records

The honest consumption number is yours, not a brochure's: in ⚙ Assumptions, enter last season's total gallons (or ccf), bushels dried, and average points removed, and the page computes **your** fuel per bushel-point — then offers to save it to the selected dryer. One season of records beats any preset.

## Common questions

- **Where did the fuel and per-point columns go?** Into the hover on each total and the note under the table. The table itself is two columns so it reads at a glance.
- **Where do the catalog numbers come from?** Typical figures by dryer type (cross-flow, mixed-flow, tower, heat recovery). They're starting points, labeled as such — calibrate with your records.
- **Why does hauling wet sometimes win?** A buyer's drying charge can be less than your cost, especially on a cheap sheet or for a point or two. The comparison uses their posted sheet — and whether depreciation is in your side is your choice.
- **Is depreciation charged on the overdrying rows too?** No. Those rows are the extra cost of going past base — lost grain and wasted fuel. The bushel already carried its depreciation reaching base.
- **Does this change any of my data?** No. Only saved dryers, a calibration you choose to save, and the depreciation setting persist — the rest is session inputs.

## If something looks wrong

- The rows below base say to enter a grain price: there's no live quote — enter one under ⚙ Assumptions. The rows above base don't need it.
- No buyers in the compare list: no discount schedule on file for this crop yet — upload one in the comparison section or on Settings → Buyers.
- The depreciation box is greyed out and won't save: a database update is needed — contact support. The table still uses the 4¢ default.
- Numbers that don't square with your fuel bills: calibrate from records; the presets are estimates. Still off after that: contact support.
