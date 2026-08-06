---
page_route: /inventory
title: Bin Inventory
updated: 2026-08-06
keywords: bins, inventory, bushels on hand, sites, beginning inventory, empty bin, cleanout, storage, capacity, percent full, transfer, wet bin, dry bin, drying
---
## What this page is for

Bin Inventory shows the dry bushels sitting in each bin right now, grouped by bin site. It's a live snapshot built from your load log: every load hauled into a bin adds, every load hauled out subtracts, and bin-to-bin transfers move grain between bins. Each site shows its bin count, total bushels, and a per-crop breakdown, so you can see at a glance what's on hand and where.

## How to use it

- Skim the site headers for totals, then the bin cards under each site for what's in each bin by crop.
- Use the **entity**, **site**, and **crop** dropdowns to narrow the view, then tap **Apply**.
- Bins with a capacity set (under Settings → Bin Sites & Bins) show a **percent-full bar**: green when there's room, amber above about 90%, and red at or over capacity. Since inventory is an estimate, an over-full bin shows ">100%" rather than pretending it stopped at the brim. Bins without a capacity just show their bushels, same as always.
- Site headers roll capacity up too: the bar compares the grain in that site's capacity-rated bins against their combined capacity. If some bins at the site have no capacity set, a note says they're left out of the percentage.
- **Transfer grain** records grain moved from one bin to another — for example, out of a wet bin into a dry bin after drying. Pick the from bin, to bin, crop, and date, then either type the bushels or estimate them from run time.
- When you first start with Turnrow and a bin already has grain in it from before your load records begin, tap **Add beginning inventory** on that bin and enter the dry bushels (with an as-of date and a note). That grain then counts until the bin is next emptied.
- When a bin is cleaned out, tap **Empty bin**. Turnrow shows you what it thinks is in the bin, asks you to confirm, and records a cleanout adjustment that zeroes it. That keeps small leftovers from shrink and scale drift from accumulating year over year.
- **Export CSV** downloads the current view as a spreadsheet, including each bin's capacity and percent full.

## Transferring grain between bins

- Tap **Transfer grain** at the top of the page (or on a bin's card to start from that bin). The crop defaults to whatever the from-bin holds the most of, and the date defaults to today.
- **Two ways to enter the amount:** type the bushels directly, or switch to **Estimate from run time** and enter your auger or leg's throughput (bushels per hour) and how long it ran. Turnrow multiplies them — 850 bu/hr for 2.5 hours is 2,125 bu — and drops the result into the bushels box, where you can still adjust it. Turnrow remembers the last throughput you used so you don't retype it.
- If you transfer more than the from-bin shows on hand, Turnrow warns you but lets you continue — bin inventory is an estimate, and you may know better than the math. If you see that warning often, a load or transfer is probably missing.
- Each bin's card lists its transfers under **Transfers** — tap to expand. Estimated transfers show the throughput and hours behind the number. You can edit or delete a transfer there; both bins recalculate automatically.
- Transfers only move grain between bins. They never change yields, production, contract deliveries, or marketing numbers — those all come from loads.

## What the controls do

- **Entity** shows only sites belonging to that entity; **Site** narrows to one site; **Crop** shows only that crop's rows in each bin.
- **Empty bin** doesn't delete any loads — it records an offsetting adjustment dated today, so your load history stays intact.
- **Add beginning inventory** takes dry bushels, an optional moisture, an as-of date, and a note. Bins carrying an active beginning inventory show it called out on the card, and the card breaks the total into load-backed bushels, transfers, and beginning bushels so you know how much is measured versus carried in.

## How the numbers work

Each bin's balance per crop is: bushels delivered to the bin, minus bushels hauled out of the bin, plus any beginning inventory, minus any empty-bin cleanouts, plus transfers in, minus transfers out. All quantities are dry bushels — each load's net weight converted at the crop's pounds per bushel with shrink applied for moisture above the crop's base. Loads from any crop year count; this page shows what's physically in the bin today, not one season's production.

Because transfers are recorded in dry bushels on both ends, moving grain from a wet bin to a dry bin doesn't change your total inventory — the drying shrink was already taken out when the wet loads were converted to dry bushels coming in. A transfer just changes where the grain sits.

## Common questions

- **Why doesn't the bin match what I think is in it?** Usually a load is missing (a haul out that never got entered), a load's to/from bin is wrong, or a bin-to-bin move never got recorded as a transfer. The balance is only as good as the log.
- **A bin shows a small negative or leftover number after I hauled it all out.** That's normal drift from shrink and scale differences. Tap Empty bin to zero it.
- **A bin shows more than 100% full.** The bar is comparing estimated bushels against the capacity you entered. Either the capacity is set low, or a haul-out or transfer out is missing. It's shown as ">100%" on purpose so you can spot it.
- **What are "Unsited bins"?** Bins that haven't been assigned to a bin site. They're flagged in red so you can fix them under Settings — assign each bin to a site and they'll file under the right header. They also won't appear when you filter by entity or site until they're assigned.
- **Does emptying a bin or transferring grain affect my yields or loads?** No. Both only adjust where inventory sits. Loads, yields, and contracts are untouched.
- **Where do I set a bin's capacity?** Settings → Bin Sites & Bins — edit the bin and fill in **Capacity (bu)**. It's optional; the spreadsheet import has a capacity column too.
- **Can I correct a beginning inventory I entered wrong?** Enter the bin's true state by emptying it and re-adding the correct beginning inventory, or contact support to remove the bad entry.

## If something looks wrong

- Check the filters first — an entity or crop filter hides bins and rows.
- Compare the bin's loads on the Loads page (filter by the bin) against your own records; a wrong to-bin or from-bin on one load is the most common cause.
- Expand the bin's **Transfers** list — a duplicate or misdirected transfer shows up there and can be edited or deleted on the spot.
- Make sure every bin is assigned to a site and each site to the right entity.
- If the balance still won't reconcile, contact support.
