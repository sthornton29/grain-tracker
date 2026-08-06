---
page_route: /loads/scan
title: Scan Tickets
updated: 2026-08-05
keywords: scan, tickets, scale ticket, photo, upload, PDF, AI, review, import, CSV, spreadsheet
---
## What this page is for

Scan Tickets turns a stack of scale tickets into loads without retyping them. Take a photo (or several) or upload a PDF of the tickets, and Turnrow reads each one into an editable row. You review the rows against the original document side by side, fix anything it misread, and save them all at once.

## How to use it

- Pick the **crop year** first — every load saved from this screen goes to that year.
- Tap the upload button and photograph the tickets or choose a PDF (up to 20 MB). Each ticket becomes one row.
- Review each row next to the source preview. Rows marked **Ready** have everything they need; rows marked **Needs Review** are missing something — the missing cells are shaded amber.
- Fix fields by hand where needed, delete any row that isn't a real ticket, then tap **Save All Loads**. Only Ready rows save; anything still needing review stays on screen so you can finish it and save again.

## What Turnrow reads from a ticket

Date, time, ticket number, truck, crop, gross, tare, net, moisture, test weight, and the from/to locations. It then matches the names it read against your own lists — trucks, crops, fields, bins, and buyers. When a name doesn't match anything you've set up, the dropdown is left blank and the raw text it read is shown beneath it (for example, AI: "Smith Farm N") so you can pick the right one yourself.

## What the controls do

- **From** is a field or a bin; **To** is a bin or a buyer. Tap the type, then pick from the list. The field and bin lists narrow to ones that fit the row's crop.
- **Contract** appears when the load goes to a buyer — attach it to a contract for that buyer, crop, and crop year, or leave it as none.
- **Discard & Start Over** clears the document and all rows.
- The **Bushels** column shows wet and dry bushels calculated live as you edit weights and moisture.

## How the numbers work

If the ticket shows gross and tare but no net, net is filled in as gross minus tare — and it recalculates if you edit either weight. Dry bushels apply your crop's base moisture and pounds per bushel, the same math as everywhere else in Turnrow. The original photo or PDF is stored with the saved loads, so you can always pull up the source ticket later.

## The spreadsheet import

For tickets you already have in a spreadsheet, use Loads → Import instead. Download the template to see the expected column headings (date, ticket number, truck, crop, weights, moisture, test weight, from/to, contract number — any column order works). Trucks, crops, fields, bins, buyers, and contracts are matched by name, rows with problems are listed with the reason, and rows whose ticket number already exists are skipped so a re-upload doesn't create duplicates.

## Common questions

- **It found no tickets in my photo.** The image is likely too blurry or oddly lit. Retake it flat, well lit, and filling the frame — or enter the load manually at New Load.
- **Do I have to fix every row before saving?** No. Save the Ready rows; the rest wait on screen until you finish them.
- **It read the truck as "Red KW" but that's not in my list.** Pick the right truck from the dropdown. If the truck genuinely isn't set up yet, add it under Settings → Trucks, then come back.
- **Can it read a whole settlement statement here?** No — settlement statements have their own upload on the Settlements page. This screen is for scale tickets.

## If something looks wrong

- A row won't turn Ready: look for amber cells — usually a missing from/to pick or a net weight of zero — and make sure a crop year is selected at the top.
- Numbers look transposed or wrong: trust the source preview, not the extraction; correct the cell by hand.
- Uploads failing repeatedly on clear documents: contact support.
