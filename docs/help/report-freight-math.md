---
page_route: /reports/freight-math
title: Freight Math
updated: 2026-09-01
keywords: freight, hauling, trucking, miles, diesel, fuel, labor, wear, delivered, picked up, pickup, breakeven, cents per bushel, distance, custom rate, payload
---
## What this page is for

What a haul really costs — and the number that settles picked-up vs delivered decisions. Put in diesel, labor, and miles, and the page answers instantly: the cost of the trip itemized (fuel, labor, wear) and totaled per load, the cost per bushel, and the decision line — **how much more a delivered contract must pay than a picked-up one to cover the haul**. A small table shows the same at 10/25/50/75/100 miles for quick scanning.

## Setting it up

- **Diesel $/gal · Labor $/hr · Miles (one-way)** — the three inputs. That's the whole main screen.
- **Crop** — sets the payload per load from the crop's test weight (corn about 950 bushels, soybeans and wheat about 880). Override it under ⚙ Assumptions if your trucks run different.
- **Destination** — optional: pick a delivery location and the miles fill in from your saved distances (choose which bin site when you have several). No distances yet? Estimate them under ⚙ Assumptions.
- **⚙ Assumptions** — truck mpg (6.0 loaded/empty average), average speed (45 mph), load/unload and wait time (0.75 hr), wear and repairs ($0.20/mi), and the payload override. All editable, saved for your operation.

## What the breakeven means

If hauling to town costs 9¢ a bushel, a delivered bid has to beat the picked-up bid by MORE than 9¢ before delivering is the better deal — otherwise you're hauling for free. The line uses **operating costs only** (fuel, labor, wear): for deciding *where* to haul, that's the right basis, because depreciation and insurance cost you the same whether the truck rolls or not. An "include ownership costs" toggle is there if you want the fully-loaded figure.

The **custom-rate equivalent** ($ per loaded mile) is a sanity check: if a hired hauler quotes less than your own number, let them haul it.

## Destination distances

- **Estimate missing distances (AI)** looks up the coordinates of your bin sites and delivery locations from their addresses, then estimates road miles (straight-line distance plus a quarter for real roads). You review every number before anything is saved, and they're always labeled *estimate*.
- **Correct any estimate** in the distances table — type the real miles and save. Your number is marked *yours* and a re-estimate will never overwrite it.
- Distances need addresses: add them under Settings → Bin Sites and Settings → Buyers (delivery locations).

## Common questions

- **Why doesn't the per-bushel number show for cotton?** Cotton hauls in pounds on module trucks, not a bushel payload — the per-load cost still works.
- **Should I include ownership costs?** For where-to-haul decisions, no — they don't change with the trip. For setting a full custom rate to charge someone else, yes.
- **The estimated miles look off.** They're straight-line × 1.25 — river crossings and detours can beat the factor. Type the real miles; your correction sticks.

## If something looks wrong

- No destinations in the picker: add delivery locations with addresses under Settings → Buyers.
- Estimates won't run: bin sites and delivery locations both need addresses on file.
- Anything else: contact support.
