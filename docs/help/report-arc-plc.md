---
page_route: /reports/arc-plc-decision-aid
title: ARC/PLC Decision Aid
updated: 2026-10-28
keywords: ARC, PLC, ARC-CO, election, base acres, MYA, reference price, benchmark, FSA, SCO, decision aid, what-if
---
## What this page is for

Every year you elect ARC or PLC for each farm and covered commodity at the FSA office. This page does the homework: it projects what PLC and ARC-CO would each pay on your farms at current price expectations, compares them side by side, and lets you record your elections. The export is the page you bring to the FSA office.

## How to use it

- Start with the **Program Comparison by Crop** at the top. For each commodity it shows your base acres, the projected totals under all-PLC and all-ARC-CO, the difference per base acre, and a verdict: **Favors PLC**, **Favors ARC-CO**, **Toss-up** when the two are within a couple dollars per base acre, or **Neither pays** when both come out at $0 at today's price — tap it to see the price each program would need. Further right sit the price inputs behind the numbers: the resolved MYA price, the effective reference price, the PLC payment-rate spread, and **ARC-CO pays below**, the marketing-year price under which ARC-CO starts paying on your most exposed farm at your county yield expectation.
- A farm that one side cannot figure (no county benchmark row, or no price yet) is left out of that side's total and the verdict, and the row says so: **n farms not counted** next to the ARC-CO total, and **(n of m farms)** next to the verdict. One missing county row never blanks a whole crop.
- **Before months are published, type USDA's projection as the WASDE midpoint** (Details under each commodity): the WASDE season-average price for grains and oilseeds, and FSA's projected marketing-year average for seed cotton and peanuts. Early in the marketing year the futures-implied blend can sit far from USDA's number, and that gap alone can flip a verdict.
- Use the **All PLC** or **All ARC-CO** buttons to set every farm's election for a commodity at once. You'll see a list of the farms that would change before anything is saved, and individual farms stay editable afterward.
- Below the summary, each farm × commodity row shows both projections, the drivers behind them, and **Elect PLC / Elect ARC-CO** buttons to record the choice per farm. Open **drivers** on a row to see the arithmetic for both programs and **What it would take** — the marketing-year price below which each program starts paying for that farm.
- Drag the **What-If MYA slider** to see how both programs respond if the marketing-year price comes in higher or lower — it moves PLC and ARC-CO together.
- Export to **PDF** or **Excel** when you're ready to talk to FSA.

## What the controls do

- **Program year selector** — everything on this page is keyed to the FSA program year.
- **MYA Prices panel** — shows the price driving each commodity's projection, with its status (estimated, manual, final, or WASDE-based), a USDA lookup for real published monthly prices, and manual entry.
- **County Yield Expectation** — your expected county yield for ARC-CO, entered as a percent of benchmark or an absolute yield, per commodity and county. This is separate from the crop insurance county assumption.
- **Election buttons** — record PLC or ARC-CO per farm × commodity, or in bulk per commodity.

## How the numbers work

- **PLC** pays when the MYA falls below the effective reference price: the spread, times the farm's PLC yield, times base acres, times the payment factor, less sequestration.
- **ARC-CO** pays on county revenue: a guarantee built from the benchmark price and benchmark county yield, compared against actual county revenue, capped at a percentage of benchmark revenue.
- Counties without benchmark data fall back to a flat per-acre estimate, marked with a **"flat est."** chip. A row with no number says why: **needs the marketing-year price** (set the price in the MYA panel), **no county benchmark row** (add the county under Settings, Government Payments, ARC-CO Benchmarks — the FSA lookup fills it from FSA's published workbook), or **farm has no county** (set it under Settings, Farms).
- ARC-CO uses the **county** yield for the practice FSA assigns (many counties have separate irrigated and non-irrigated benchmarks). The benchmark row you enter is one practice; your FSA office can tell you which applies to each farm.
- The Payment Tracker uses the identical math, so the two pages always agree.
- **SCO note**: for 2025 and later crop years, SCO can be purchased regardless of your ARC/PLC election, with an 80 percent premium subsidy. For 2025 only, FSA automatically paid the higher of ARC or PLC per farm and commodity.
- **2026 and later need a real election.** The 2026 election and enrollment window is September 16 to December 11, 2026. Every producer with a base-acre interest on a farm must agree, commodity by commodity. A farm with no 2026 election is defaulted to its 2025 election and receives no 2026 payment. The 2026 election carries through 2031 unless you change it in a later year, and base acres added for 2026 are part of it.

## Common questions

- **These are projections, right?** Yes. FSA determines final payments after the marketing year ends. The verdicts move as MYA expectations move.
- **Why does one farm differ from the summary verdict?** The summary sums all farms; an individual farm's county benchmark or PLC yield can tip it the other way.
- **Both programs show $0 — which do I pick?** Neither pays at today's price, so compare the trigger prices: PLC pays once the price drops below the effective reference price, ARC-CO once county revenue drops below its guarantee. If you expect a strong county yield, ARC-CO needs a much lower price before it pays, and PLC is the better price floor. If you expect a poor county yield, ARC-CO can pay when PLC does not.

## If something looks wrong

- A "flat est." chip or "no county benchmark row" means benchmark data is missing — add it in Settings, Government Payments.
- A canola, sunflower or sesame price that looks fifty times too big was saved in dollars per bushel; look the price up again and it is stored per pound.
- A notice about benchmark years means your benchmarks are entered under a different program year; the notice links you to the right spot.
- Anything else, contact support.
