---
page_route: /loads
title: Loads
updated: 2026-08-15
keywords: loads, load log, tickets, scale, paid, unpaid, splits, export, delete, test weight, moisture, gross, tare, net, irrigated, dryland, practice, combine, yield monitor, no scales, truck, hauler, pickup contract, buyer's truck, add truck, rename truck, edit truck, wrong date, yesterday's date, defaults
---
## What this page is for

The load log is the master list of every load you've hauled — to a bin or to a buyer. Each row shows the date, ticket number, truck, crop, where it came from, where it went, weights, moisture, test weight, and whether the buyer has paid for it. It's the record everything else builds on: bin inventory, contract delivery, settlements, and yields all read from these loads.

## How to use it

- To record a new load by hand, use **New Load** — pick the date, truck, crop, crop year, where it came from (field or bin), where it went (bin or buyer), and enter the weights. If a load carries grain from more than one field, add a split so each field gets credit for its share.
- **New Load starts where you left off.** The form pre-fills the date, crop, crop year, From, and To from the last load you entered — whether that was field-to-bin, field-to-buyer, or bin-to-buyer — so a string of loads only needs weights and a ticket number. Every pre-fill can be changed. When the pre-filled date isn't today (say you're entering last night's tickets the next morning), a small note by the date says so — e.g. "Defaulted to 8/14 (your last load's date) — not today" — so nothing quietly lands on the wrong day. Change the date and the note goes away; each saved load becomes the starting point for the next.
- **Irrigated or dryland?** When the load's field has both irrigated and dryland acres, an optional Irrigated/Dryland choice appears (on New Load, Edit, ticket scanning, and on each line of a split load). Tag it if you know which ground the load came off — skip it if you don't. Fields that are all one practice never ask; Turnrow already knows. If you tag every load on a mixed field, the Yields page splits that field's bushels between irrigated and dryland automatically, so you won't be asked to allocate after harvest.
- To enter a stack of tickets at once, use **Scan** (photograph or upload the tickets) or **Import** (upload a spreadsheet).
- **A truck that isn't in the list?** Pick **+ Add truck…** right in the Truck dropdown — it saves to your truck list (the same one under Settings → Trucks) and is selected for this load.
- **A truck named wrong?** Tap the small ✎ next to the Truck dropdown to fix the name right there (works for hauler trucks on pickup loads too, and under Settings → Trucks). Renaming won't change past loads — they keep the truck name as it was entered; the new name applies to the picker and to loads you enter from now on.

## Pickup trucks vs your trucks

- When the load's contract is a **pickup** contract (the buyer's trucks load at your farm), the Truck field changes: type the hauler's truck as written on the ticket, or pick one you've saved before under **Hauler trucks**. Tick **Save this truck for future pickup loads** and it'll be in the list next time.
- The rule is simple: a truck saved on a pickup load is a **hauler truck** (someone else's — a buyer's or hired hauler's); a truck saved anywhere else is **yours**. The two lists never mix, so your own truck list stays clean.
- Hauling a pickup load yourself anyway? Your own trucks are still in the dropdown, under **Your trucks**.
- In the load log and reports, hauler trucks show with a small **hauler** tag so you can tell them apart at a glance. Saved hauler trucks can be renamed or removed under Settings → Trucks (**Hauler Trucks**) — loads already entered keep the name as it was written.
- Tap anywhere on a row to open that load's detail page. A small chevron on split loads expands the per-field breakdown right in the list.
- Tick the checkboxes to select loads, then export the selection or delete them in bulk.

## What the controls do

- **Search** matches ticket number, truck, crop, field, destination, contract, and date.
- **Date range, entity, county, crop year, contract** filters narrow the list. Entity and county filter by the field the load came from.
- **Column headers** sort — date, ticket, truck, crop, net, dry bushels, moisture, and test weight. Tap again to flip the direction.
- **Paid / Unpaid badges** show on buyer-delivered loads. A load is Paid when a settlement line is tied to it — by ticket number or by a manual match on the settlement screen. Loads that went to a bin get no badge; they haven't been sold.
- **Export** downloads what's currently filtered, including a payment column. You can also print or export a formatted report.
- **Delete** removes the selected loads permanently after a confirmation.

## Tracking harvest without scales

- No scale tickets for a field? Use **Yield from Combine** (next to New Load) to record the field's production straight off the combine monitor — as total dry bushels or as yield per acre (Turnrow multiplies by the field's planted acres). One entry per field per crop per year; entering it again revises it.
- **The adjustment.** If your yield maps run consistently high or low against real weights, set a ± bushels-per-acre adjustment on the entry — the math shows live ("Combine says 228.0 bu/ac − 3.0 adjustment = 225.0 bu/ac · 1,321 ac → 297,225 bu"). Turnrow remembers the adjustment per crop and pre-fills it on your next combine entry; clear it to stop.
- **Weighed loads still count — once.** Any loads you did weigh from that field (sold to town, hauled on a scale) keep their full identity for contracts, settlements, and the load log, and are automatically netted out of the combine total — whether they were entered before or after the combine entry. If you picked a destination bin, only the netted remainder shows in that bin.
- If your weighed loads ever add up to MORE than the combine entry, Turnrow warns you on the entry and on the Yields page — check the entry or the adjustment.
- Whichever way you entered a field last, the Loads page makes that button the prominent one next time. Both are always available.

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
