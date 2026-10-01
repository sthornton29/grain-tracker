---
page_route: /cotton
title: Cotton — Loads, Gin Receipts, Bales & Grades
updated: 2026-10-01
keywords: cotton, seed cotton, module, rolls, rounds, number of rounds, handwritten rolls, busted roll, sequence mark, round modules, pounds per roll, average per roll, load detail, ticket photo, module ticket, sort, select, delete loads, export loads, duplicate load, scanned twice, already saved, update available, duplicate bale, PBI repeated, turn on cotton, gin, gin receipt, statement of ginning, bales, HVI, classing, PBI, turnout, yard inventory, gin operator
---
## What this page is for

The Cotton tab is where seed cotton gets tracked from the field to the classed bale. It has three pages in the left sidebar: **Seed Cotton Loads** (module and weight tickets coming off the field), **Gin Receipts** (the gin's Statements of Ginning), and **Bales & Grades** (every bale with its HVI classing). A user with the **gin operator role** sees only these intake pages — nothing else in the operation.

## How to use it

- **Seed Cotton Loads**: record each module or trailer load in pounds of seed cotton. Enter loads manually (the form remembers your crop year, and net weight fills in from gross minus tare), or use the **Upload a module list** card — a photo or PDF of the gin's module list becomes editable rows, one load per page, with the farm matched by FSA number first and producer name second. Review, correct anything, and save the batch. Each load also carries its **rolls** — the number of round modules on it — typed on the form, read from the module list under whatever label the gin prints (Number of Rounds, Rounds, Rolls, Round Modules, Modules), or tapped in later on the load list. **Handwriting is kept apart from print**: when someone wrote a different count on the ticket ("3 Rolls", "Busted Roll, 3 Rolls on TRK #21"), the review row shows the printed count with an amber "handwritten: 3 rolls (…)" chip and a one-tap **Use 3**; the note is saved with the load. Turnrow never picks one over the other for you. A circled or hash-numbered figure in the corner (28, #41) is the farm's own module sequence, shown as a mark and never counted as rolls. The cards at the top total the year's loads, pounds, rolls, and the **average pounds per roll** (total pounds on the loads that have a roll count, divided by their rolls), and the Yard Inventory card shows how many rolls are still waiting. Every load keeps its own **ticket**: the module-list upload stores each page with the load it came from (one load per page — if the page count doesn't match the loads read, every load gets the whole document), the hand-entry form takes a photo or PDF, and a ticket can be added or replaced on the load's page later. The **Yard Inventory** section shows pounds delivered that aren't on any gin receipt yet — your cotton sitting on the yard waiting to be ginned.
- **Gin Receipts**: when the gin sends a Statement of Ginning, enter it here — several can apply to one field. Manual entry works, but the **Upload a Statement of Ginning** card reads the whole document: modules, seed cotton pounds, bales, lint pounds, cottonseed pounds, turnout, the load table, and the full bale list across every page. The review screen matches the receipt to your farm and field, matches its load lines to your recorded loads by load number (you can create a missing load right there), and flags any difference between the gin's stated bale count and the bales actually captured. Nothing saves until you confirm.
- **Bales & Grades**: import your classing data as a CSV file. Rows are matched to bales by **PBI number** (leading zeros don't matter), a PBI repeated in the file is kept once and named, net weights are cross-checked against the receipt, and rows that don't match a bale are held visibly so you can resolve them after later receipts arrive.

## What the controls do

- **Upload buttons** — every AI upload lands on a review table first; you always confirm before anything is saved.
- **Create missing load** — on gin receipt review, adds a load line the gin has that you never recorded, carrying the rolls count from the statement's load table.
- **Rolls** — tap the number in the Rolls column of the load list to change it; Enter saves, Escape cancels.
- **Duplicates are caught before they save.** In a scan, the same load number on two pages (leading zeros ignored) becomes one review row with an "appears twice in this scan (pages 2 and 7)" chip — the first page is its ticket, the second rides along — and two pages that disagree on weight turn red for a look. Against what is already saved, a row is **Already saved** (unticked, with a link), **Update available** (the scan has different weights, dates or rolls — the changes are listed, ticked to apply), or new; the footer counts "X already saved · Y updates · Z new" and only new numbers insert. On the hand-entry form, typing a saved load number shows "Load 031627 is already saved (9/29, 29,860 lbs). Open it?" and the save is blocked unless you tick **Update that load**. On a gin receipt, a bale number repeated in the list or already on another receipt this crop year is named and left out by default (tick to keep), and a receipt number already saved is **Already saved** or **Update available** — nothing is ever saved twice.
- **The load list** works like the grain Loads page: search (load number, truck, farm, field, gin), filters for farm, field, gin, status (on the yard / ginned), and delivered dates; tap a column heading to sort (load numbers sort naturally, blanks stay last); tick loads to export the selection or **Delete selected** — loads already on a gin receipt are never deleted, the confirmation says how many will be kept. **Export** (Excel, PDF, CSV, print) covers the filtered list with the rolls and pounds-per-roll totals.
- **Tap a load** to open its own page: logistics, weights, rolls and pounds per roll, the gin receipt it landed on, notes, and the scanned ticket for that load (view, replace, remove). **Edit** changes any field in place; **Delete** removes it unless it is on a receipt; **Export / Print** makes a one-page record.
- **Yard Inventory** — delivered pounds minus ginned pounds, by field, with the rolls still waiting.

## How the numbers work

- Cotton weights are plain pounds — no moisture or shrink math like grain.
- **Turnout** is lint pounds divided by seed cotton pounds, from the gin receipt.
- Lint yield per acre is the field's bale net weights (from its receipts) divided by planted acres; the app also shows seed cotton pounds per acre alongside.
- Each bale's loan value in cents per pound comes from its classing data and feeds the Bale Quality report and CCC loan figures on the Marketing page.

## Common questions

- **Why is the average per roll blank?** No load in that crop year has a roll count yet. Add rolls on the loads (tap the Rolls figure in the list) and the average appears; loads without a count are left out of the average, and the card says how many.
- **A load shows the whole module list instead of its own page.** The upload read a different number of loads than the document has pages, so it couldn't tell which page was which. Open the load and use **Replace** on the ticket to attach the right page.
- **Why can't the gin operator see Marketing?** The Marketing page is owner-only by design — gin logins get the three intake pages and nothing more.
- **Why don't I see the Cotton tab at all?** Cotton is turned off for your operation. An owner can turn it on under Settings → Organization; the tab appears after the next page load.
- **Why is there no entity box on the load form?** A gin login doesn't pick entities — the entity comes from the farm you choose. Owners see the entity box only when the operation has more than one entity.
- **A classing row didn't match a bale.** Its receipt may not be entered yet — unmatched rows wait visibly and can be matched later.

## If something looks wrong

- Bale-count mismatch flags on a receipt mean the stated total and the captured bale list disagree — recheck the document pages.
- If a load won't match, compare load numbers between the module list and the receipt; each load number is unique within a crop year.
- Anything else, contact support.
