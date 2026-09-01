---
page_route: /reports/dryer-math
title: Grain Dryer Math
updated: 2026-09-01
keywords: dryer, drying, propane, LP, natural gas, moisture, shrink, overdrying, cost per point, bushel point, calibrate, haul wet, discount schedule, assumptions
---
## What this page is for

What it costs to take a point of moisture out — and what it costs to take out one too many. Three inputs and the table answers: **Crop · Fuel · Fuel price**. For every incoming moisture from bone-dry to 28% you get the fuel to dry it to base, the weight that drying shrinks away, and the total drying cost per bushel. Rows below base show the price of overdrying in red. It's a calculator, not a record book: nothing here tracks loads.

## Setting it up

- **Crop** — sets the base moisture from the crop's own standard (the same base the rest of Turnrow shrinks to).
- **Fuel** — propane or natural gas, with its price. If a saved dryer is selected, its fuel applies automatically.
- Everything else lives under **⚙ Assumptions**: your dryer (a saved one, a catalog model, or a standard 0.018 gal-LP-equivalent per bushel-point), the grain price (defaults to today's futures quote for the crop's reference contract — type over it any time), the electric rate, and the calibrate-from-records tool. The line under the inputs always says which dryer and grain price are in play.

## Reading the table

- **Rows above base** are incoming wet grain dried to base: fuel $/bu, the cost per point, the **shrink** (the physical water weight, valued at the grain price — a real cost whether or not you think of it that way), and the total.
- **The base row** is the stop line.
- **Rows below base** are the price of **overdrying**: every half-point past base gives away sellable weight *and* burns fuel removing water nobody pays for.

## Dry it or haul it wet

An optional comparison at the bottom (collapsed until you open it): pick a buyer whose discount schedule is on file and every wet row shows their dock beside your drying cost, with the call — *Dry it* or *Haul it wet* — and the savings. Schedules live with the buyer under Settings → Buyers; you can also upload one right there in the section. Ask Turnrow can quote the same schedules in plain words.

## Calibrating from your records

The honest consumption number is yours, not a brochure's: in ⚙ Assumptions, enter last season's total gallons (or ccf), bushels dried, and average points removed, and the page computes **your** fuel per bushel-point — then offers to save it to the selected dryer. One season of records beats any preset.

## Common questions

- **Where do the catalog numbers come from?** Typical figures by dryer type (cross-flow, mixed-flow, tower, heat recovery). They're starting points, labeled as such — calibrate with your records.
- **Why does hauling wet sometimes win?** A buyer's drying charge can be less than your fuel plus shrink, especially for a point or two. The comparison uses their posted sheet.
- **Does this change any of my data?** No. Only saved dryers (and a calibration you choose to save) persist — the rest is session inputs.

## If something looks wrong

- No grain price showing: there may be no live quote — enter one under ⚙ Assumptions.
- No buyers in the compare list: no discount schedule on file for this crop yet — upload one in the comparison section or on Settings → Buyers.
- Numbers that don't square with your fuel bills: calibrate from records; the presets are estimates. Still off after that: contact support.
