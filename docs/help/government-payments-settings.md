---
page_route: /settings/government-payments
title: Government Payments Settings
updated: 2026-08-13
keywords: base acres, PLC yield, elections, MYA, WASDE, benchmark, ARC-CO, program year, payment limit, sequestration, FSA import
---
## What this page is for

This page holds the data that drives every ARC/PLC projection: your farms' base acres and elections, MYA prices, ARC-CO benchmarks, and the program-year parameters. The Decision Aid and Payment Tracker compute from what you enter here.

## How to use it

- Pick the **Program year** at the top — everything on this page is keyed to it, and links from the reports arrive with the right year already selected.
- Load **base acres** fastest with the FSA form import: upload your FSA base-acres document and the app extracts each farm's commodities, base acres, and PLC yields into a review table. FSA paperwork often repeats a farm and commodity across tracts and pages; duplicate lines are combined at review with a note showing what was merged. You confirm before anything saves. If the document names a farm that isn't in Turnrow yet, the review offers to **create that farm** right there — check the box and its base acres save with it (finish its county and entity later under Settings → Farms).
- Enter or look up **MYA prices** per commodity and month. The **USDA lookup** pulls real published prices received by farmers; fetched months appear beside anything you typed, and already-entered months start unchecked so nothing is overwritten without your say-so. A WASDE midpoint can stand in before months publish, and a published final locks the row. If the lookup comes up empty, an AI lookup is offered as a clearly labeled fallback.
- Enter **ARC-CO benchmarks** — the FSA benchmark price and county yield per commodity and county. The county picker starts with your own counties and can open to any state and county.
- Review **Program Parameters** per year: the SCO trigger, the per-person payment limit, the sequestration percentage, and payment factors.

## What the controls do

- **FSA lookup** (on a benchmark row) — reads the county benchmark yield straight from FSA's published "ARC-County Benchmark Yields and Revenues" workbook, with an irrigated/non-irrigated choice when the county publishes both. If nothing is found, you can borrow from a nearby county in the same state or a prior year — borrowed values save to your own county's row with the borrowing noted, and amber chips show before you confirm.
- **Payment limits** — shown read-only here. The eligible-persons count is set per entity under Settings, Entities; the cap is persons times the per-person limit for the program year.
- **ARC flat rates** — a fallback flat per-acre estimate used only for counties without benchmark data; reports label it "flat est.".

## How the numbers work

- PLC projections need the MYA and each farm's base acres and PLC yield. ARC-CO projections additionally need the benchmark price and county yield for the farm's county and this program year.
- Base acres pay independent of what you plant; unassigned base carries no payment.
- The MYA precedence everywhere is: published final, then your manual entry, then the WASDE midpoint, then the running estimate.

## Common questions

- **Which year do I enter benchmarks under?** The program year the reports are computing. If a report warns that benchmarks exist only for other years, use its link — it lands here preset to the right one.
- **My county's name exists in two states.** Benchmarks are stored against the specific county and state ("County, ST"), so pick carefully in the county picker.
- **The FSA import shows a merged line — is that right?** Yes — the same farm and commodity appeared on multiple lines of the document, and they were summed with an acre-weighted PLC yield. Expand the note to see the pieces.

## If something looks wrong

- If a projection seems off, check the MYA row's status chip — an estimate behaves differently than a final.
- If ARC-CO shows a flat estimate, that county and program year has no benchmark row yet.
- Anything else, contact support.
