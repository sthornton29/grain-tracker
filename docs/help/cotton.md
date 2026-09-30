---
page_route: /cotton
title: Cotton — Loads, Gin Receipts, Bales & Grades
updated: 2026-09-30
keywords: cotton, seed cotton, module, rolls, round modules, turn on cotton, gin, gin receipt, statement of ginning, bales, HVI, classing, PBI, turnout, yard inventory, gin operator
---
## What this page is for

The Cotton tab is where seed cotton gets tracked from the field to the classed bale. It has three pages in the left sidebar: **Seed Cotton Loads** (module and weight tickets coming off the field), **Gin Receipts** (the gin's Statements of Ginning), and **Bales & Grades** (every bale with its HVI classing). A user with the **gin operator role** sees only these intake pages — nothing else in the operation.

## How to use it

- **Seed Cotton Loads**: record each module or trailer load in pounds of seed cotton. Enter loads manually (the form remembers your crop year, and net weight fills in from gross minus tare), or use the **Upload a module list** card — a photo or PDF of the gin's module list becomes editable rows, one load per page, with the farm matched by FSA number first and producer name second. Review, correct anything, and save the batch. Each load also carries its **rolls** — the number of round modules on it — typed on the form, read from the module list when the ticket prints it (editable on the review rows), or tapped in later on the load list; the list totals rolls for the year and the Yard Inventory line shows how many rolls are still waiting. The **Yard Inventory** section shows pounds delivered that aren't on any gin receipt yet — your cotton sitting on the yard waiting to be ginned.
- **Gin Receipts**: when the gin sends a Statement of Ginning, enter it here — several can apply to one field. Manual entry works, but the **Upload a Statement of Ginning** card reads the whole document: modules, seed cotton pounds, bales, lint pounds, cottonseed pounds, turnout, the load table, and the full bale list across every page. The review screen matches the receipt to your farm and field, matches its load lines to your recorded loads by load number (you can create a missing load right there), and flags any difference between the gin's stated bale count and the bales actually captured. Nothing saves until you confirm.
- **Bales & Grades**: import your classing data as a CSV file. Rows are matched to bales by **PBI number** (leading zeros don't matter), net weights are cross-checked against the receipt, and rows that don't match a bale are held visibly so you can resolve them after later receipts arrive.

## What the controls do

- **Upload buttons** — every AI upload lands on a review table first; you always confirm before anything is saved.
- **Create missing load** — on gin receipt review, adds a load line the gin has that you never recorded, carrying the rolls count from the statement's load table.
- **Rolls** — tap the number in the Rolls column of the load list to change it; Enter saves, Escape cancels.
- **Yard Inventory** — delivered pounds minus ginned pounds, by field.

## How the numbers work

- Cotton weights are plain pounds — no moisture or shrink math like grain.
- **Turnout** is lint pounds divided by seed cotton pounds, from the gin receipt.
- Lint yield per acre is the field's bale net weights (from its receipts) divided by planted acres; the app also shows seed cotton pounds per acre alongside.
- Each bale's loan value in cents per pound comes from its classing data and feeds the Bale Quality report and CCC loan figures on the Marketing page.

## Common questions

- **Why can't the gin operator see Marketing?** The Marketing page is owner-only by design — gin logins get the three intake pages and nothing more.
- **Why don't I see the Cotton tab at all?** Cotton is turned off for your operation. An owner can turn it on under Settings → Organization; the tab appears after the next page load.
- **Why is there no entity box on the load form?** A gin login doesn't pick entities — the entity comes from the farm you choose. Owners see the entity box only when the operation has more than one entity.
- **A classing row didn't match a bale.** Its receipt may not be entered yet — unmatched rows wait visibly and can be matched later.

## If something looks wrong

- Bale-count mismatch flags on a receipt mean the stated total and the captured bale list disagree — recheck the document pages.
- If a load won't match, compare load numbers between the module list and the receipt; each load number is unique within a crop year.
- Anything else, contact support.
