---
page_route: /reports/government-payments
title: Government Payment Tracker
updated: 2026-10-29
keywords: government payments, ARC, PLC, payment year, program year, payment limit, MYA, base acres, USDA, seed cotton, FSA payment statement, upload statement, received, projected, variance, implied rate, higher of, 2025, payee, Martin Farm, 1099-G, calendar year, statements, upside down, share rent, producer share, landlord share, statement rate, paid less than projected
---
## What this page is for

The Payment Tracker projects your ARC/PLC and other USDA payments, records what FSA actually paid from the payment statements you upload, shows when the money arrives, and tracks each entity against its FSA payment limit. It answers four questions: how much is coming, how much has come in and how it compares, when does it land, and does any entity bump its limit.

## How to use it

- Pick a year. The **By Entity × Crop matrix** at the top shows each entity's projected payments per commodity, plus other USDA payments, with totals that reconcile in the corner.
- Below, each farm's breakdown shows the commodity, election, and projected payment, with a drill-down into the drivers.
- Check the **Payment Limit Status** table to see each entity's persons-times-limit cap and where the projections stand against it.
- Review the **MYA Prices panel** — every projection rides on these prices, and you control where they come from.
- Use the **Upload FSA payment statement** tab when a statement arrives from the county office. Drop the PDF (or photos of it); every payment block is read, checked, and shown by farm for you to confirm. Once saved, the statement's ARC/PLC amounts become the **Received** figures everywhere, and a **Statements** tab lists every statement with a link to its own page and the PDF.
- Switch **Projected | Received | Both** above the tables. The KPI strip shows projected, received, the variance in dollars and percent, the share of the projection received so far, and the date of the last statement.
- Export to **Excel** or **PDF**; the export mirrors the view you chose (projected, received or both), and once a statement is on file the Excel workbook adds Statements, Lines and Crop Amounts tabs plus a Received vs Projected tab whose Received column is a live SUMIFS over the crop amounts.

## What the controls do

- **Year basis toggle** — the default **"By payment year"** view answers "what cash arrives in year Y": ARC/PLC for program year Y−1 (which pays the following October) plus other payments received in Y. Switch to **"By program year"** to line up with FSA paperwork instead. The year you picked stays put when you switch; only the label and the framing change, and the line under the toggle says which framing you are looking at.
- **Check your setup** — when something is off in your setup (benchmarks entered under another program year, older payment entries whose year needs a look, a missing program parameter), the notices fold into one **Check your setup (N)** panel under the filters. Tap it to read them.
- **MYA Prices panel** — per commodity: an Auto/Manual toggle, inline manual entry, and a **Look up USDA prices** button that pulls real published monthly prices received by farmers. Fetched months appear beside anything you've already entered; nothing you typed is overwritten without your confirmation. A published final price locks the row. If the lookup finds nothing, an AI lookup is offered as a clearly labeled fallback.
- **ARC-CO settings** button — jumps to Settings, Government Payments with the right program year already selected.
- **Upload FSA payment statement** — the statement's header (office, payee, date, gross, deductions, net) and four checks: crop amounts add up to each block's gross, gross minus deductions equals net, the blocks add up to the statement's net, and every block on the pages was read. Lines are grouped by FSA farm; a farm number Turnrow does not have is flagged and can be matched to a farm or kept as the raw number. The payee is matched to an entity (or added as a new one). Upside-down pages from a duplex scan and blocks that run from the bottom of one page onto the next are handled for you. A statement already on file saves nothing new — each FSA Payment ID is recorded once.
- **Payee notice** — when the statement paid an entity that is not the one Turnrow has for those farms and that program year (for example, the 2025 program year paid to the entity that operated the farms in 2025), the review says so and offers one click to set that program year's payee on every farm on the statement. See Settings, Government Payments, Payee by program year.
- **Sequestration notice** — when the statement's sequester percentage differs from the program year's parameter, the review offers to update the parameter.
- **Statements tab** — every statement with its date, payee, gross and net, line count, program years and a PDF link; tap a date to open the statement's own page (lines by farm and program, crop amounts, checks, the implied rate behind each crop amount, and Delete). Below the list, **FSA payments received by calendar year** totals each payee's lines by the year the money arrived — the figure to reconcile against the 1099-G.
- **Detail** (per farm) — the calculation behind each projection (including the producer share on a share-rent farm) and, once paid, the received amount, the variance, the implied rate beside the projected rate and beside the rate FSA paid the other farms on the statements, and what the variance is attributed to.

## How the numbers work

- **Timing**: ARC/PLC for a program year is paid in October of the following year. That one rule drives the whole payment-year view — program year 2025's payment shows as 2026 cash.
- **PLC** pays the gap between the effective reference price and the MYA; **ARC-CO** pays on county revenue against its benchmark guarantee — the same math as the Decision Aid, so the two pages agree.
- **Payment limits**: each entity's cap is its number of FSA-eligible persons (set once in Settings, Entities) times the program year's per-person limit. The status table shows the multiplication and colors entities approaching or over their cap.
- **Seed cotton** is one commodity with one price: the lookup fetches the lint price (cents per pound) and the cottonseed price (dollars per ton) and blends them at configurable shares, showing you the composition before you confirm.
- Payments tied to a farm roll up through the **payee for that program year** — the entity set under Settings, Government Payments, Payee by program year, or the farm's own entity when none is set — so a program year earned under a previous operator lands on the right entity. Other payments attribute to their entity, with a "no entity" row so the totals always reconcile.
- **Producer share**: FSA pays each producer their share of a farm's payment. On a farm marked share rent under Settings, Farms, the projection is the farm's payment times your share (100% minus the landlord's percentage); cash-rent farms project the whole payment. The per-farm rows show "× 75% share" beside the base acres when a share applies.
- **Received** is the crop amount printed on the FSA payment statement for that farm and crop. Where a line is paid, the received figure replaces the projection in every total, Cash Flow (in the month of the ACH date), Revenue Projections and Income Sensitivity — nothing is counted twice. Lines not yet paid keep their projection.
- **Line status**: Paid; Not yet paid (no statement for the program year yet); Paid with no projection (a farm or crop with no base acres on file); Projected but not on any statement yet (statements came in and this line was not on them).
- **Implied rate**: for a paid PLC line, the actual divided by (1 − sequester) × 0.85 × base acres × PLC yield gives the payment rate per bushel or pound FSA actually used; for ARC-CO, the actual divided by (1 − sequester) × 0.85 × base acres gives the rate per base acre. Both sit beside the projected rate.
- **Variance cause**: the difference is attributed to the **program** when the other program paid, to the **sequester** when the statement's percentage alone explains it, to **acres / yield / share** when the farm was paid noticeably more or less than its base data would earn at the rate FSA paid the other farms on the statements (so FSA's base acres, yield or your share of that farm differ from what Turnrow has), and otherwise to the **rate** — the price or county revenue came in different from the projection. The statement rate is the rate the paid farms cluster on for that crop and program (ARC-CO within a county); with only one paid farm the test falls back to the most the program could pay.
- **Program year 2025 pays the higher of PLC and ARC-CO** on every farm and crop regardless of the election. The projection applies that rule for 2025 (the detail shows both sides and which one pays); from 2026 the election governs again.

## Common questions

- **Why do the two year views show different totals?** They frame the same payments differently — cash-arrival year vs FSA program year. Use payment year for cash planning, program year for FSA reconciliation.
- **Why did a projection change?** MYA prices update as months publish and as futures move; a confirmed final locks it down.
- **What's the amber note on an old entry?** An other-payment entry looks like it was recorded under the old year convention — open it and confirm its dates.
- **The statement paid a different entity than the report shows.** Set the program-year payee: accept the notice on the upload review, or use Settings, Government Payments, Payee by program year. The matrix, the payment limits and the entity filter follow it for that year only.
- **A farm on the statement is not in Turnrow.** Its lines save with the raw FSA number and show as "Paid with no projection"; add the farm under Settings, Farms and match the line on a later upload, or leave it.
- **I uploaded the same statement twice.** Nothing was saved the second time — every FSA Payment ID is recorded once, and the review says "already recorded".
- **A farm was paid less than projected but the rate looks right.** Open its detail: if the variance is attributed to acres / yield / share and the "paid as a share" line reads 75% or 50%, FSA paid you a share of that farm's payment. If the farm is share rent, mark it so under Settings, Farms with the landlord's percentage and the projection will follow; otherwise FSA's base acres or yield for your share of the farm differ from the base acres on file — compare them against your FSA-156EZ.

## If something looks wrong

- A benchmark-year notice in **Check your setup** means ARC-CO benchmarks exist only for other years — the notice links to Settings preset to the right year. A **flat estimate** chip on a farm's row means the same thing for that county; tap the chip for the explanation.
- If an entity's limit looks wrong, check its eligible-persons count in Settings, Entities and the per-person limit in Program Parameters.
- Anything else, contact support.
