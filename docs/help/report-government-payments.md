---
page_route: /reports/government-payments
title: Government Payment Tracker
updated: 2026-08-05
keywords: government payments, ARC, PLC, payment year, program year, payment limit, MYA, base acres, USDA, seed cotton
---
## What this page is for

The Payment Tracker projects your ARC/PLC and other USDA payments, shows when the money actually arrives, and tracks each entity against its FSA payment limit. It answers three questions: how much is coming, when does it land, and does any entity bump its limit.

## How to use it

- Pick a year. The **By Entity × Crop matrix** at the top shows each entity's projected payments per commodity, plus other USDA payments, with totals that reconcile in the corner.
- Below, each farm's breakdown shows the commodity, election, and projected payment, with a drill-down into the drivers.
- Check the **Payment Limit Status** table to see each entity's persons-times-limit cap and where the projections stand against it.
- Review the **MYA Prices panel** — every projection rides on these prices, and you control where they come from.
- Export to **Excel** or **PDF**; the export includes the matrix, the election column, and the payment limit table.

## What the controls do

- **Year framing toggle** — the default **"By payment year"** view answers "what cash arrives in year Y": ARC/PLC for program year Y−1 (which pays the following October) plus other payments received in Y. Switch to **"By program year"** to line up with FSA paperwork instead. Switching shifts the year selector so the same pool of payments stays on screen.
- **MYA Prices panel** — per commodity: an Auto/Manual toggle, inline manual entry, and a **Look up USDA prices** button that pulls real published monthly prices received by farmers. Fetched months appear beside anything you've already entered; nothing you typed is overwritten without your confirmation. A published final price locks the row. If the lookup finds nothing, an AI lookup is offered as a clearly labeled fallback.
- **ARC-CO settings** button — jumps to Settings, Government Payments with the right program year already selected.

## How the numbers work

- **Timing**: ARC/PLC for a program year is paid in October of the following year. That one rule drives the whole payment-year view — program year 2025's payment shows as 2026 cash.
- **PLC** pays the gap between the effective reference price and the MYA; **ARC-CO** pays on county revenue against its benchmark guarantee — the same math as the Decision Aid, so the two pages agree.
- **Payment limits**: each entity's cap is its number of FSA-eligible persons (set once in Settings, Entities) times the program year's per-person limit. The status table shows the multiplication and colors entities approaching or over their cap.
- **Seed cotton** is one commodity with one price: the lookup fetches the lint price (cents per pound) and the cottonseed price (dollars per ton) and blends them at configurable shares, showing you the composition before you confirm.
- Payments tied to a farm roll up through the farm's entity; other payments attribute to their entity, with a "no entity" row so the totals always reconcile.

## Common questions

- **Why do the two year views show different totals?** They frame the same payments differently — cash-arrival year vs FSA program year. Use payment year for cash planning, program year for FSA reconciliation.
- **Why did a projection change?** MYA prices update as months publish and as futures move; a confirmed final locks it down.
- **What's the amber note on an old entry?** An other-payment entry looks like it was recorded under the old year convention — open it and confirm its dates.

## If something looks wrong

- A benchmark-year notice means ARC-CO benchmarks exist only for other years — the notice links to Settings preset to the right year.
- If an entity's limit looks wrong, check its eligible-persons count in Settings, Entities and the per-person limit in Program Parameters.
- Anything else, contact support.
