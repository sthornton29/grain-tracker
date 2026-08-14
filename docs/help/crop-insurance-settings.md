---
page_route: /settings/crop-insurance
title: Crop Insurance Settings
updated: 2026-08-14
keywords: crop insurance, policy, MPCI, RP, YP, ARP, AYP, SCO, ECO, STAX, MCO, APH, projected price, coverage check, practice, county yield, attestation
---
## What this page is for

This is where your crop insurance policies live. Enter each policy once — plan type, coverage, APH, acres, premium — and the Claims Monitor, Income Sensitivity, and Cash Flow reports estimate from them all season. The page also holds your projected prices, your county yield assumptions, and a Coverage Check that reconciles insured acres against planted acres.

## How to use it

- Add policies by hand or with the **AI policy upload** — a photo or PDF of your schedule of insurance becomes editable rows, one per crop, county, and practice.
- Each policy line carries plan type (RP, RP-HPE, YP, or the county-based ARP/AYP), the **practice** (irrigated or dryland — the same crop, county, and year can carry one of each), coverage level, unit structure, APH yield, projected price, insured acres, premium, and policy number.
- Add **SCO, ECO, STAX, or MCO** endorsements on the policy form. STAX carries its cotton coverage band and protection factor; MCO carries its margin band and expected margin. For ARP/AYP the form shows the expected county yield or revenue and protection factor, and notes that your farm yield isn't used.
- Every policy belongs to **one entity**. Single-entity operations assign automatically; multi-entity operations pick the insured entity on upload or entry.
- Run the **Coverage Check** to compare insured acres against planted acres by entity, crop, county, and practice.

## What the controls do

- **AI policy upload** — extracted rows are compared against what's already entered: identical policies show as "Already exists", changed ones show a field-by-field difference and update the existing policy in place (never duplicated), and only new combinations are added. You can tick the "covers all planted acres" attestation per row before saving.
- **Price discovery (RMA)** — a status line per crop and state showing each price's discovery window, where it stands (not started, in discovery, final), the current value, and the volatility factor. Turnrow pulls these straight from RMA's published price-discovery data, keyed by the states your policies sit in — the windows genuinely differ by state and crop, so a Georgia window isn't an Illinois window. Values refresh on their own (daily while a window is open); the ↻ refreshes on demand.
- **Projected prices** — the RMA projected price per crop and year, used to value guarantees. Once a state's discovery window closes, RMA's published projected price fills in automatically (marked RMA); typing a price yourself overrides it, and your manual entry always wins.
- **County yield assumptions** — the "my yield vs county" differential per crop, county, and year: how much your yields run above the county average, in the crop's own unit. Estimated county yield equals your yield basis minus this differential, and it drives every county-triggered endorsement. This is separate from the ARC-CO expectation on the government pages. Values save when you leave the field.
- **Coverage Check** — flags combinations with no policy, more planted than insured, or more insured than planted. Ticking **"covers all planted acres"** on a policy marks its combination Covered and quiets the acre-mismatch flag — but a combination with no policy at all is always flagged.
- **Stacking warnings** — appear above the list when endorsement combinations need agent review (for example ECO with STAX). Warnings only; nothing is blocked.

## How the numbers work

- APH, coverage level, projected price, and acres entered here are exactly what the Claims Monitor multiplies through — a wrong APH here means a wrong estimate everywhere.
- Cotton insurance prices are **dollars per pound** (for example 0.68), not cents. Entering cents produces absurdly large estimated indemnities, and the Claims Monitor will flag it.

## Common questions

- **Small acre differences keep getting flagged.** The Coverage Check tolerates small differences; anything larger needs either corrected acres or the covers-all-planted attestation once your agent confirms.
- **Why did my upload say "Update available"?** A policy with the same entity, crop, county, year, practice, and plan already exists with different values — review the differences and confirm.

## If something looks wrong

- If the Claims Monitor looks off, check this page first: APH, coverage level, practice, prices, and entity assignment.
- If a policy vanished from a report, confirm its crop year and entity.
- Anything else, contact support.
