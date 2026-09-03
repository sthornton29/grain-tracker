---
page_route: /reports/freight-math
title: Freight Math
updated: 2026-09-02
keywords: freight, hauling, trucking, miles, diesel, fuel, labor, wear, delivered, picked up, pickup, breakeven, cents per bushel, distance, custom rate, payload, buyer, bin site, wait time, unload, elevator line, destination
---
## What this page is for

What a haul really costs — and the number that settles picked-up vs delivered decisions. Put in diesel, labor, and miles, and the page answers instantly: the cost of the trip itemized (fuel, labor, wear) and totaled per load, the cost per bushel, and the decision line — **how much more a delivered contract must pay than a picked-up one to cover the haul**. Below the answer, two tables: **every saved destination costed with its own miles and wait time**, and the same math at 10/25/50/75/100 miles for quick scanning.

## Setting it up

- **Diesel $/gal · Labor $/hr · Miles (one-way)** — the three inputs. That's the whole main screen.
- **Crop** — sets the payload per load from the crop's test weight (corn about 950 bushels, soybeans and wheat about 880). Override it under ⚙ Assumptions if your trucks run different.
- **Destination** — optional: the picker lists your delivery locations grouped by buyer, each showing the saved miles from your bin site (choose which bin site when you have several). Pick one and the miles fill in — and if that location has its own wait time, the cost uses it. A location with no miles yet says so — type them under ⚙ Assumptions.
- **⚙ Assumptions** — truck mpg (6.0 loaded/empty average), average speed (45 mph), the default load/unload and wait time (0.75 hr), wear and repairs ($0.20/mi), the payload override, and the distances table with a wait time per location. All editable, saved for your operation.

## What the breakeven means

If hauling to town costs 9¢ a bushel, a delivered bid has to beat the picked-up bid by MORE than 9¢ before delivering is the better deal — otherwise you're hauling for free. The line uses **operating costs only** (fuel, labor, wear): for deciding *where* to haul, that's the right basis, because depreciation and insurance cost you the same whether the truck rolls or not. An "include ownership costs" toggle is there if you want the fully-loaded figure.

The **custom-rate equivalent** ($ per loaded mile) is a sanity check: if a hired hauler quotes less than your own number, let them haul it.

## Cost by destination

The first table under the answer lists your saved destinations, grouped by buyer, each costed at today's diesel and labor with **its own miles** (from the bin site you picked) and **its own wait time**: Miles · Wait · Cost/load · ¢/bu. The destination you picked is highlighted. A location with no miles on file shows greyed with a *set distance* link to the assumptions panel. Sitting an extra hour at a slow house at $25/hr labor is about 2¢ a bushel on a corn load — this table is where that shows up side by side.

## Wait times per location

Elevator lines vary wildly, and everyone knows which houses make you sit. The default load/unload + wait time (0.75 hr per trip) covers a normal stop; in the distances table under ⚙ Assumptions, the **Wait** column beside each location's miles lets you set that house's own hours. Leave it blank and the default applies (shown greyed in the box). Type 1.5 for the one that always backs up and every figure for that destination — the main screen when it's picked, its row in the cost-by-destination table — uses 1.5. Each entry saves as soon as you leave the box.

## Destination distances

- The table under ⚙ Assumptions is organized the way Settings → Buyers is: each **buyer** is a heading, its **delivery locations** sit beneath it, and every location has a miles box for each of your bin sites plus its wait box.
- **Type the miles you know.** Each number saves as soon as you leave the box and is marked *yours*. No address is needed — a location without an address still gets its row, with a note that typing is the way to fill it. Your number is never changed by anything else on the page.
- **Estimate missing distances (AI)** is optional. It looks up the coordinates of bin sites and delivery locations that have addresses, estimates road miles (straight-line distance plus a quarter for real roads), and shows them for review before anything is saved. It fills **only the blanks** — it never touches a number that's already there, yours or an earlier estimate. Estimates are always labeled *estimate*; type over one and it becomes yours.

## Common questions

- **Why doesn't the per-bushel number show for cotton?** Cotton hauls in pounds on module trucks, not a bushel payload — the per-load cost still works.
- **Should I include ownership costs?** For where-to-haul decisions, no — they don't change with the trip. For setting a full custom rate to charge someone else, yes.
- **The estimated miles look off.** They're straight-line × 1.25 — river crossings and detours can beat the factor. Type the real miles over it; your number sticks.
- **A location isn't in the estimate.** It has no address on file. Type its miles directly — that's all it needs.
- **I typed miles by hand — which wait time applies?** The default. A location's own wait time only applies when that destination is picked; typing miles clears the pick.
- **Does the export include the destination table?** Yes — both tables, with the wait hours each row was costed at.

## If something looks wrong

- No destinations in the picker or the destination table: add buyers and their delivery locations under Settings → Buyers.
- No miles boxes in the table: add a bin site under Settings → Bin Sites — distances are measured from there.
- The estimate finds nothing to do: every pair already has miles, or the locations have no addresses. Type the ones you need.
- The Wait boxes are greyed out and won't take a number: a database update is needed — contact support.
- Anything else: contact support.
