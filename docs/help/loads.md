---
page_route: /loads
title: Loads
updated: 2026-08-05
keywords: loads, load log, tickets, scale, paid, unpaid, splits, export, delete, test weight, moisture, gross, tare, net
---
## What this page is for

The load log is the master list of every load you've hauled — to a bin or to a buyer. Each row shows the date, ticket number, truck, crop, where it came from, where it went, weights, moisture, test weight, and whether the buyer has paid for it. It's the record everything else builds on: bin inventory, contract delivery, settlements, and yields all read from these loads.

## How to use it

- To record a new load by hand, use **New Load** — pick the date, truck, crop, crop year, where it came from (field or bin), where it went (bin or buyer), and enter the weights. If a load carries grain from more than one field, add a split so each field gets credit for its share.
- To enter a stack of tickets at once, use **Scan** (photograph or upload the tickets) or **Import** (upload a spreadsheet).
- Tap anywhere on a row to open that load's detail page. A small chevron on split loads expands the per-field breakdown right in the list.
- Tick the checkboxes to select loads, then export the selection or delete them in bulk.

## What the controls do

- **Search** matches ticket number, truck, crop, field, destination, contract, and date.
- **Date range, entity, county, crop year, contract** filters narrow the list. Entity and county filter by the field the load came from.
- **Column headers** sort — date, ticket, truck, crop, net, dry bushels, moisture, and test weight. Tap again to flip the direction.
- **Paid / Unpaid badges** show on buyer-delivered loads. A load is Paid when a settlement line is tied to it — by ticket number or by a manual match on the settlement screen. Loads that went to a bin get no badge; they haven't been sold.
- **Export** downloads what's currently filtered, including a payment column. You can also print or export a formatted report.
- **Delete** removes the selected loads permanently after a confirmation.

## How the numbers work

- **Net pounds = gross − tare.**
- **Wet bushels** = net pounds ÷ the crop's pounds per bushel.
- **Dry bushels** apply shrink: moisture above the crop's base moisture reduces the bushels; at or below base, wet and dry are the same. Base moisture and pounds per bushel are set per crop under Settings → Crops.

## The load detail page

The row opens a read-only, printable page for one load: identity and logistics, weights and bushels, the split breakdown, the linked contract, and payment. Payment shows one of four states — **Paid** (a settlement matched this ticket, with the settlement number, buyer, and revenue shown), **Unpaid** (delivered to a buyer, no settlement yet), **Ambiguous** (more than one load shares this ticket number, so Turnrow won't guess which one was paid — fix it with a manual match on the settlement), or **Stored in bin — not a buyer sale**. When paid, the page compares your dry bushels to the buyer's settled net bushels and flags a difference over 1%. Edit, Delete, and Print/Export buttons sit in the header.

## Common questions

- **Why does a delivered load still show Unpaid?** The settlement covering it either hasn't been entered yet, or its ticket number doesn't match. Check the ticket number on both.
- **What does the chevron on some rows mean?** That load is split across fields — tap it to see how the bushels divide.
- **Can I undo a bulk delete?** No. Deletion is permanent, which is why it asks first.
- **Where did the Edit button on each row go?** Open the load — Edit and Delete live on the detail page.

## If something looks wrong

- Missing loads: check the filters and the crop-year selection first — a stray filter hides more loads than anything else.
- Wrong dry bushels: check the load's moisture and the crop's base moisture and pounds per bushel under Settings → Crops.
- A paid load showing Unpaid: compare the ticket number on the load with the one on the settlement line.
- Still off after that: contact support.
