---
page_route: /loads/scan
title: Scan tickets
updated: 2026-10-05
keywords: scan, tickets, scale ticket, photo, upload, PDF, review, check, import, CSV, spreadsheet, ticket says, needs a look, start over, crop from field, planting, double-crop, wheat, soybeans, year not on ticket, date
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

**The date.** Turnrow reads the date exactly as the scale printed it. Many tickets print only the month and day — "10/03" — with no year. When that happens, Turnrow uses the current year and says so under the date box: *Year not on ticket, assumed 2026.* (A ticket dated a few days ahead of today still counts as this year; one that would land more than a week in the future is taken as last year — a 12/30 ticket scanned on January 3 goes to December.) A year that is printed on the ticket is used as printed. A date that can't be read, or isn't a real date, leaves the box blank and the ticket **Needs a look** so you can type it.

**The crop.** When the ticket names the crop and the field you're hauling from is planted to it, that's the crop — the note under the box reads *from ticket, matches field*. When the ticket doesn't name a crop, Turnrow fills it in from the field's planting for that crop year — *from field (2026 planting)*. A field that grew wheat and then double-crop soybeans is decided by the ticket's date: loads dated through the end of July go to the wheat, loads from August 1 on go to the soybeans, with a one-tap **Switch to Wheat** (or Soybean) right there if a ticket falls the other way. If the ticket names one crop but the field is planted to another — *Ticket says Corn, but Wheeler Grove is planted to Soybean in 2026* — Turnrow keeps the ticket's crop, marks the ticket Needs a look, and offers a **Use Soybean** button; the paper is evidence, so it never gets overwritten quietly. A field with no planting that year, a field planted only to cotton (cotton goes through Seed Cotton Loads), or a field planted to two fall crops is left for you to choose, with the field's crops as quick picks. Once you pick a crop yourself, nothing changes it — not a different field, a different date, or a different crop year. Loads coming from a bin aren't affected by any of this.

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
- **The crop box filled in with soybeans but the ticket was wheat.** The field grew both this year and the ticket's date decided. Tap **Switch to Wheat** under the crop box — or check the date, since a wrong year on the date moves the load to the other crop too.
- **Why does the date say "assumed 2026"?** The ticket printed only the month and day. Turnrow filled in the year; change the date if that's not right.
- **Can it read a whole settlement statement here?** No — settlement statements have their own upload on the Settlements page. This screen is for scale tickets.

## If something looks wrong

- A ticket won't turn Ready: look for amber boxes — usually a missing from/to pick or a net weight of zero — and make sure a crop year is selected at the top.
- Numbers look transposed or wrong: trust the original document, not what was read; correct the box by hand.
- Uploads failing repeatedly on clear documents: contact support.
