---
page_route: /loads
title: Loads
updated: 2026-09-24
keywords: loads, load log, tickets, scale, paid, unpaid, splits, export, delete, test weight, moisture, gross, tare, net, irrigated, dryland, practice, combine, yield monitor, no scales, truck, hauler, pickup contract, buyer's truck, add truck, rename truck, edit truck, wrong date, yesterday's date, defaults, low tare, tare warning, use last tare, usual tare, empty weight, field search, find a field, farm, search fields, contract progress, remaining bushels, over delivery, ticket photo, attach photo, weak signal, no service, save anyway, check this load, swapped weights, unsaved changes, leave without saving, filters, csv, spreadsheet export
---
## What this page is for

The load log is the master list of every load you've hauled — to a bin or to a buyer. Each row shows the date, ticket number, truck, crop, where it came from, where it went, weights, moisture, test weight, and whether the buyer has paid for it. It's the record everything else builds on: bin inventory, contract delivery, settlements, and yields all read from these loads.

## How to use it

- To record a new load by hand, use **New Load** — pick the date, truck and ticket number (the first things on the paper ticket), crop, crop year, where it came from (field or bin), where it went (bin or buyer), and enter the weights. If a load carries grain from more than one field, add a split so each field gets credit for its share.
- **New Load starts where YOU left off.** The form pre-fills the date, crop, crop year, From, and To from the last load **you** entered — whether that was field-to-bin, field-to-buyer, or bin-to-buyer — so a string of loads only needs weights and a ticket number. Two people entering different load types at the same time each get their own pre-fills; only when you haven't entered any loads yet does the form borrow the operation's last load. Every pre-fill can be changed. When the pre-filled date isn't today (say you're entering last night's tickets the next morning), a small note by the date says so — e.g. "Defaulted to 8/14 (your last load's date) — not today" — so nothing quietly lands on the wrong day. Change the date and the note goes away; each saved load becomes the starting point for the next.
- **Finding a field is a search, not a scroll.** Tap the field box and a search opens with the box right at the top — type a few letters of the field **or the farm** ("saun" finds everything on Big Saunders; a farm name narrows to just that farm's fields). Fields stay grouped by farm so two farms' "Field 12"s can't be mixed up. The same search is on split-load lines and on Yield from Combine.
- **Save & New is the harvest workhorse.** It saves the load and immediately gives you a fresh form for the next one — date, crop, From/To, and contract carried over; weights and ticket cleared — with a green "Saved — ticket 1234" confirmation in the bar at the bottom of the screen, where it stays in view however far you've scrolled. **The truck starts empty on purpose:** during harvest, back-to-back loads usually come in on different trucks, and a quietly carried-over truck puts loads on the wrong one. The cursor lands on the Truck box so it's the next thing you pick — the "Use last tare" shortcut is right there once you do. Use plain **Save** when you're done and want to go back to the load log.
- **Net is worked out for you.** Once gross and tare are in, Net fills in as gross minus tare and stays put — tap the small **edit** beside it if the ticket shows a different net. Dry bushels are worked out from net, moisture, and the crop's settings; if you ever need to enter dry bushels straight off the ticket instead, tap **Override dry bushels…** under the bushel figures.
- **Turnrow checks the load before it saves.** If something looks off — gross smaller than tare, no net weight, no truck picked, a moisture or test weight outside the usual range, a net heavier than a truck can haul — a "Check this load" box lists what it noticed and asks **Save anyway** or **Go back**. It's a heads-up, not a stop; a net weight below zero is the one thing it won't save.
- **Weak signal in the field?** If a save hangs for more than about fifteen seconds, the form gives the buttons back and says there's no connection right now. Nothing you typed is lost — wait for a bar or two and tap Save again. A load never saves twice from a retry, even if the first attempt actually got through and only the reply was lost.
- **Snap the ticket while you're at it.** On the New Load form, **Take ticket photo** (or **Add ticket photo** on a computer) puts a photo of the scale ticket in a tray under the form; when the load saves, the photo is attached to it. You can add several, remove one, and the tray works the same through Save & New. Attachments can also be added later from the load's page.
- **Leaving with unsaved typing?** Cancel (or closing the tab) asks "Leave without saving this load?" first, so a stray tap can't throw away a half-entered ticket.
- **The contract tracker keeps count as you go.** When a contract is picked, the delivered/remaining bar under it counts every saved load — including the ones you just entered with Save & New — so the remaining figure is right after each save, and the "over by" note shows on the very load that goes past the contracted bushels.
- **Irrigated or dryland?** When the load's field has both irrigated and dryland acres, an optional Irrigated/Dryland choice appears (on New Load, Edit, ticket scanning, and on each line of a split load). Tag it if you know which ground the load came off — skip it if you don't. Fields that are all one practice never ask; Turnrow already knows. If you tag every load on a mixed field, the Yields page splits that field's bushels between irrigated and dryland automatically, so you won't be asked to allocate after harvest.
- To enter a stack of tickets at once, use **Scan tickets** (photograph or upload the tickets) or **Import spreadsheet**.
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
- **Filters** — date range, entity, county, crop year, crop, and contract — narrow the list as soon as you change them. On a phone or an iPad held upright they tuck behind a **Filters** button that shows how many are set; **Clear filters** puts everything back. Entity and county filter by the field the load came from; the **Crop** filter matches a split load if any of its crops match, and it is remembered the next time you open the page. The active filters are named at the top of every export, and exports, bulk selection and delete all work on the filtered list.
- **Column headers** sort — date, ticket, truck, crop, net, dry bushels, moisture, and test weight. Tap again to flip the direction. On a narrow screen the wet bushels, moisture, and test weight columns step aside so the rest fits; they're all still on the load's page and in every export.
- **Paid / Unpaid badges** show on buyer-delivered loads. A load is Paid when a settlement line is tied to it — by ticket number or by a manual match on the settlement screen. Loads that went to a bin get no badge; they haven't been sold.
- **Export** — Excel, PDF, CSV, or Print — downloads what's currently filtered, including a payment column and each split load's field breakdown. Selected loads export the same way from the selection bar.
- **Delete** removes the selected loads permanently after a confirmation.
- **Nothing showing?** If you have no loads at all yet, the page points you to New Load, Scan tickets, and Import. If loads exist but none match, it says so and offers to clear the filters.

## Tracking harvest without scales

- No scale tickets for a field? Use **Yield from combine** (next to New Load) to record the field's production straight off the combine monitor — as total dry bushels or as yield per acre (Turnrow multiplies by the field's planted acres). One entry per field per crop per year; entering it again revises it.
- **The adjustment.** If your yield maps run consistently high or low against real weights, set a ± bushels-per-acre adjustment on the entry — the math shows live ("Combine says 228.0 bu/ac − 3.0 adjustment = 225.0 bu/ac · 1,321 ac → 297,225 bu"). Turnrow remembers the adjustment per crop and pre-fills it on your next combine entry; clear it to stop.
- **Weighed loads still count — once.** Any loads you did weigh from that field (sold to town, hauled on a scale) keep their full identity for contracts, settlements, and the load log, and are automatically netted out of the combine total — whether they were entered before or after the combine entry. If you picked a destination bin, only the netted remainder shows in that bin.
- If your weighed loads ever add up to MORE than the combine entry, Turnrow warns you on the entry and on the Yields page — check the entry or the adjustment.

## Tare weights: the warning and the shortcut

- **"Tare … is well below this truck's usual …"** Turnrow learns each truck's normal empty weight from its past loads (the middle value of its tares, once the truck has at least three loads with a tare). If the tare you enter is half or less of that usual figure, a note appears under the Tare field — on New Load, Edit, and on each ticket of a scan. It's a heads-up, not a stop: a typo or a mis-read scan on the tare makes the net weight (and the bushels, and what the buyer owes) look bigger than it is. Check the ticket; if the low number is real — a trailer dropped, a different tractor — just save. The note disappears as soon as the value is corrected, and saved loads that would have tripped it show a small **low tare?** tag in the load log so an old mistake is easy to find.
- **Use last tare.** Once a truck is picked on New Load, a **Use last tare: 31,220 · 9/23** button appears under the Tare field — that truck's tare from its most recent load, with the date. One tap fills it in; you can still change it. It works for your trucks and hauler trucks alike, and stays out of the way when the truck has no earlier loads. It never fills in on its own: weighing the empty truck is the accurate number, and the shortcut is for when you know the truck hasn't changed.

## How the numbers work

- **Net pounds = gross − tare.**
- **Wet bushels** = net pounds ÷ the crop's pounds per bushel.
- **Dry bushels** apply shrink: moisture above the crop's base moisture reduces the bushels; at or below base, wet and dry are the same. Base moisture and pounds per bushel are set per crop under Settings → Crops. Bushels show as whole numbers everywhere on screen.

## The load detail page

The row opens a read-only, printable page for one load: identity and logistics, weights and bushels, the split breakdown, the linked contract, payment, and the attached photos or PDFs. Payment shows one of four states — **Paid** (a settlement matched this ticket, with the settlement number, buyer, and revenue shown), **Unpaid** (delivered to a buyer, no settlement yet), **Ambiguous** (more than one load shares this ticket number, so Turnrow won't guess which one was paid — fix it with a manual match on the settlement), or **Stored in bin — not a buyer sale**. When paid, the page compares your dry bushels to the buyer's settled net bushels and flags a difference over 1%. Edit, Delete, and Print/Export buttons sit in the header.

## Common questions

- **Why does a delivered load still show Unpaid?** The settlement covering it either hasn't been entered yet, or its ticket number doesn't match. Check the ticket number on both.
- **What does the chevron on some rows mean?** That load is split across fields — tap it to see how the bushels divide.
- **It asked me to "check this load" — did it save?** Not yet. Look over the list, then tap **Save anyway** to save it as entered, or **Go back** to fix it first.
- **Can I undo a bulk delete?** No. Deletion is permanent, which is why it asks first.
- **Where did the Edit button on each row go?** Open the load — Edit and Delete live on the detail page.

## If something looks wrong

- Missing loads: check the filters and the crop-year selection first — a stray filter hides more loads than anything else. The **Clear filters** button resets them all.
- Wrong dry bushels: check the load's moisture and the crop's base moisture and pounds per bushel under Settings → Crops.
- A paid load showing Unpaid: compare the ticket number on the load with the one on the settlement line.
- A ticket photo didn't attach: the load itself saved. Open it from the list and attach the photo there.
- Still off after that: contact support.
