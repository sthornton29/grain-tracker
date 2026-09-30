---
page_route: /loads/scan
title: Scan tickets
updated: 2026-09-24
keywords: scan, tickets, scale ticket, photo, upload, PDF, review, check, import, CSV, spreadsheet, ticket says, needs a look, start over
---
## What this page is for

Scan tickets turns a stack of scale tickets into loads without retyping them. Take a photo (or several) or upload a PDF of the tickets, and Turnrow reads each one into a ticket you can edit. You check each one against the original, fix anything it misread, and save them all at once.

## How to use it

- Pick the **crop year** first — every load saved from this screen goes to that year.
- Tap the upload button and photograph the tickets or choose a PDF (up to 20 MB). Each ticket becomes one editable ticket on screen.
- Check each ticket against the original. On a wide screen the tickets sit in a table with the original beside them; on a phone or iPad each ticket is its own card, with the original document shown above the cards so you can scroll between them. Tickets marked **Ready** have everything they need; tickets marked **Needs a look** are missing something — the missing boxes are shaded amber.
- Fix anything by hand, remove any ticket that isn't a real one (the ✕), then tap **Save N loads**. Only Ready tickets save; anything still needing a look stays on screen so you can finish it and save again.

## What Turnrow reads from a ticket

Date, time, ticket number, truck, crop, gross, tare, net, moisture, test weight, and the from/to locations. It then matches the names it read against your own lists — trucks, crops, fields, bins, and buyers. When a name doesn't match anything you've set up, the dropdown is left blank and what it read is shown beneath it (for example, *Ticket says "Smith Farm N"*) so you can pick the right one yourself.

## What the controls do

- **From** is a field or a bin; **To** is a bin or a buyer. Tap the type, then pick from the list. The field and bin lists narrow to ones that fit the ticket's crop.
- **Contract** appears when the load goes to a buyer — attach it to a contract for that buyer, crop, and crop year, or leave it as none.
- **Start over** clears the document and every ticket on screen.
- **Bushels** shows wet and dry bushels worked out live as you edit weights and moisture.
- A tare well below the truck's usual gets a **Low tare?** tag, the same heads-up as on New Load.

## How the numbers work

If the ticket shows gross and tare but no net, net is filled in as gross minus tare — and it recalculates if you edit either weight. Dry bushels apply your crop's base moisture and pounds per bushel, the same math as everywhere else in Turnrow. The original photo or PDF is stored with the saved loads, so you can always pull up the source ticket later.

## The spreadsheet import

For tickets you already have in a spreadsheet, use Loads → **Import spreadsheet** instead. Download the template to see the expected column headings (date, ticket number, truck, crop, weights, moisture, test weight, from/to, contract number — any column order works), save your sheet as a CSV, and upload it. Trucks, crops, fields, bins, buyers, and contracts are matched by name, rows with problems are listed with the reason, and rows whose ticket number already exists are skipped so a re-upload doesn't create duplicates.

## Common questions

- **It found no tickets in my photo.** The image is likely too blurry or oddly lit. Retake it flat, well lit, and filling the frame — or enter the load by hand at New Load.
- **Do I have to fix every ticket before saving?** No. Save the Ready ones; the rest wait on screen until you finish them.
- **It read the truck as "Red KW" but that's not in my list.** Pick the right truck from the dropdown. If the truck genuinely isn't set up yet, add it under Settings → Trucks, then come back.
- **Can it read a whole settlement statement here?** No — settlement statements have their own upload on the Settlements page. This screen is for scale tickets.

## If something looks wrong

- A ticket won't turn Ready: look for amber boxes — usually a missing from/to pick or a net weight of zero — and make sure a crop year is selected at the top.
- Numbers look transposed or wrong: trust the original document, not what was read; correct the box by hand.
- Uploads failing repeatedly on clear documents: contact support.
