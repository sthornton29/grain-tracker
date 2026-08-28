---
page_route: /reports/dryer-math
title: Grain Dryer Math
updated: 2026-08-28
keywords: dryer, drying, propane, LP, natural gas, moisture, shrink, overdrying, cost per point, bushel point, calibrate, haul wet, discount schedule
---
## What this page is for

What it costs to take a point of moisture out — and what it costs to take out one too many. Pick your dryer, put in fuel and grain prices, and the table answers, per bushel, for every incoming moisture from bone-dry to 28%: the fuel to dry it to base, the weight that drying shrinks away, and — when you point it at a buyer's discount schedule — whether drying it yourself beats hauling it wet. It's a calculator, not a record book: nothing here tracks loads.

## Setting it up

- **Dryer** — pick one of your saved dryers, a catalog model (GSI, Sukup, Brock, Mathews Company, NECO, Grain Handler, Zimmerman, Farm Fans/GT — each with a *typical* consumption estimate by dryer type), or type one-off numbers. Catalog presets are estimates only; your records beat them (see calibrating, below). "Save these settings as a dryer" keeps a setup for next time.
- **Crop** — sets the base moisture from the crop's own standard (the same base the rest of Turnrow shrinks to).
- **Fuel** — propane in $/gal or natural gas in $/ccf; the page remembers your prices. LP and NG presets convert by energy content, so a catalog model works on either fuel.
- **Grain price** — defaults to today's futures quote for the crop's reference contract; type over it any time. It's what values the shrink.
- **Compare against buyer** — pick a buyer whose discount schedule is on file (uploaded here or on the buyer's card in Settings → Buyers) and every wet row shows their dock beside your drying cost.

## Reading the table

- **Rows above base** are incoming wet grain dried to base: fuel $/bu, the cost per point, the **shrink** (the physical water weight, valued at the grain price — shown separately because it's a real cost whether or not you think of it that way), and the total. With a buyer selected, the **Cheaper** column calls it: *Dry it* or *Haul it wet*, with the savings.
- **The base row** is the stop line.
- **Rows below base** are the price of **overdrying**: every half-point past base gives away sellable weight *and* burns fuel removing water nobody pays for. That combined number is why stopping at base instead of a point and a half low is worth real money on a big crop.

## Calibrating from your records

The honest consumption number is yours, not a brochure's: enter last season's total gallons (or ccf), bushels dried, and average points removed, and the page computes **your** fuel per bushel-point — then offers to save it to the selected dryer. One season of records beats any preset.

## Common questions

- **Where do the catalog numbers come from?** Typical figures by dryer type (cross-flow, mixed-flow, tower, heat recovery). They're starting points, labeled as such — calibrate with your records.
- **Why does hauling wet sometimes win?** A buyer's drying charge can be less than your fuel plus shrink, especially for a point or two. The comparison uses their posted sheet — if their actual settlements run above their sheet, the Buyer Discount Comparison report's audit will say so.
- **Does this change any of my data?** No. Only saved dryers (and a calibration you choose to save) persist — the rest is session inputs.

## If something looks wrong

- No grain price showing: there may be no live quote — type a price in.
- No buyers in the compare list: no discount schedule on file for this crop yet — upload one below or on Settings → Buyers.
- Numbers that don't square with your fuel bills: calibrate from records; the presets are estimates. Still off after that: contact support.
