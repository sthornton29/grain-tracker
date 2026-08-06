---
page_route: /inventory
title: Bin Inventory
updated: 2026-08-05
keywords: bins, inventory, bushels on hand, sites, beginning inventory, empty bin, cleanout, storage
---
## What this page is for

Bin Inventory shows the dry bushels sitting in each bin right now, grouped by bin site. It's a live snapshot built from your load log: every load hauled into a bin adds, every load hauled out subtracts. Each site shows its bin count, total bushels, and a per-crop breakdown, so you can see at a glance what's on hand and where.

## How to use it

- Skim the site headers for totals, then the bin cards under each site for what's in each bin by crop.
- Use the **entity**, **site**, and **crop** dropdowns to narrow the view, then tap **Apply**.
- When you first start with Turnrow and a bin already has grain in it from before your load records begin, tap **Add beginning inventory** on that bin and enter the dry bushels (with an as-of date and a note). That grain then counts until the bin is next emptied.
- When a bin is cleaned out, tap **Empty bin**. Turnrow shows you what it thinks is in the bin, asks you to confirm, and records a cleanout adjustment that zeroes it. That keeps small leftovers from shrink and scale drift from accumulating year over year.
- **Export CSV** downloads the current view as a spreadsheet.

## What the controls do

- **Entity** shows only sites belonging to that entity; **Site** narrows to one site; **Crop** shows only that crop's rows in each bin.
- **Empty bin** doesn't delete any loads — it records an offsetting adjustment dated today, so your load history stays intact.
- **Add beginning inventory** takes dry bushels, an optional moisture, an as-of date, and a note. Bins carrying an active beginning inventory show it called out on the card, and the card breaks the total into load-backed bushels and beginning bushels so you know how much is measured versus carried in.

## How the numbers work

Each bin's balance per crop is: bushels delivered to the bin, minus bushels hauled out of the bin, plus any beginning inventory, minus any empty-bin cleanouts. All quantities are dry bushels — each load's net weight converted at the crop's pounds per bushel with shrink applied for moisture above the crop's base. Loads from any crop year count; this page shows what's physically in the bin today, not one season's production.

## Common questions

- **Why doesn't the bin match what I think is in it?** Usually a load is missing (a haul out that never got entered) or a load's to/from bin is wrong. The balance is only as good as the load log.
- **A bin shows a small negative or leftover number after I hauled it all out.** That's normal drift from shrink and scale differences. Tap Empty bin to zero it.
- **What are "Unsited bins"?** Bins that haven't been assigned to a bin site. They're flagged in red so you can fix them under Settings — assign each bin to a site and they'll file under the right header. They also won't appear when you filter by entity or site until they're assigned.
- **Does emptying a bin affect my yields or loads?** No. It only adjusts the inventory balance. Loads, yields, and contracts are untouched.
- **Can I correct a beginning inventory I entered wrong?** Enter the bin's true state by emptying it and re-adding the correct beginning inventory, or contact support to remove the bad entry.

## If something looks wrong

- Check the filters first — an entity or crop filter hides bins and rows.
- Compare the bin's loads on the Loads page (filter by the bin) against your own records; a wrong to-bin or from-bin on one load is the most common cause.
- Make sure every bin is assigned to a site and each site to the right entity.
- If the balance still won't reconcile, contact support.
