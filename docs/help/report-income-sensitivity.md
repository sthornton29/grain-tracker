---
page_route: /reports/income-sensitivity
title: Income Sensitivity
updated: 2026-09-01
keywords: sensitivity, price, yield, table, scenarios, futures, contracts, insurance, indemnity, county yield, government payments, revenue per acre, profit per acre
---
## What this page is for

Income Sensitivity answers "what happens to my income if prices or yields move?" Each crop gets a table with futures prices down the side and yields across the top; every cell is your revenue or net profit per acre in that scenario, with your locked contracts, crop insurance, and (optionally) government payments all baked in. It shows how well your marketing and insurance protect you before the season plays out.

## How to use it

Pick a crop year and scroll to a crop. The row and column closest to today's futures price and your expected yield are highlighted — that cell is "you are here." Read down for cheaper prices, left for lower yields, and watch where insurance kicks in to flatten the damage. A badge above each table says how many bushels are contracted at locked prices, or that the crop is fully price-sensitive.

## What the controls do

- **Revenue/acre | Net profit/acre** — switches what the cells show; profit subtracts your cost per acre from the Marketing assumptions.
- **Price and yield axis controls** — set the center, step, and number of steps for each axis of each crop; leave them blank for automatic values centered on your current assumptions — the assumed futures price from your marketing assumptions (falling back to today's price, then your policies' projected price) and your expected yield. An entry that does not parse reverts to the previous value.
- **Include government payments** — adds the payments expected to arrive during the crop year (the prior program year's ARC/PLC paid that fall, plus other USDA payments) as one flat dollars-per-acre amount, identical for every crop and constant across cells.
- **County yield toggle** — see below.
- **Entity filter** — narrows acres, positions, and policies; agent-held or whole-operation contracts count toward each entity by its share of the crop's planted acres.
- **Export Excel / PDF / Print** — the tables with the price axis as the first column and your active toggles noted.

## How the numbers work

- **Contracted bushels stay locked.** Cash contracts keep their cash price, HTA and basis contracts their locked legs, open hedges their trade price, realized gains counted once. The scenario price applies only to unpriced bushels, plus your assumed basis. If scenario production falls below contracted bushels, revenue is capped at production.
- **Seed contracts** follow the same rule: elected portions stay locked at their elected price, the unpriced committed share moves with the scenario price, and premiums hold at the contract's expected-outcome assumption.
- **Harvested bushels are facts.** The yield axis applies only to unharvested acres. Mid-harvest, the header shows what is already in the bin; a fully harvested crop collapses to a single actual-yield column, leaving only price risk.
- **Insurance re-runs in every cell.** Each RP, RP-HPE, and YP policy — with SCO and ECO, per irrigated/dryland practice — recomputes with the scenario price as the harvest price, shown net of premium. Once the RMA final harvest price is on file, it is used instead in every cell.
- **County yield modes.** County-based coverage (SCO, ECO, STAX, ARP, AYP, MCO) needs a county yield, estimated from your "my yield vs county" differential. **County independent** (the default) holds the county constant while your farm yield moves — a local loss the county may not share, exposing the gap where county products might not pay when you have a loss. **County moves with me** models a widespread loss: the county falls with your yield, keeping your usual relationship to it, so area coverage triggers alongside your own policies. Once the RMA final county yield is published, both modes pin to it.
- **Cotton** tables run in cents per pound (the futures convention) and pounds of lint per acre; sold and pool pounds stay locked, and in-loan pounds never fall below the banked CCC loan value.

## Common questions

- **Why doesn't the yield axis change one of my crops?** It is fully harvested — yield is settled and only price still matters.
- **Why does insurance ignore the price axis?** The RMA final harvest price is on file, so the price axis moves crop sales only.

## If something looks wrong

Check the crop's yield, cost, and basis assumptions on the Marketing Dashboard first — every cell builds on them. If county-based coverage looks off, review your county differential on the Claims Monitor. Otherwise, contact support.
