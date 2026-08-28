---
page_route: /settlements
title: Settlements
updated: 2026-08-28
keywords: settlements, settlement statement, buyer, paid, unpaid, reconcile, ticket, PDF, upload, revenue, discounts, itemized, drying, test weight, shrink, price per bushel, edit, delete
---
## What this page is for

Settlements is where buyer settlement statements live — the paperwork that says which loads a buyer paid for, at what bushels and dollars. Entering settlements is what turns a load's badge from Unpaid to Paid, and it's how Turnrow catches loads the buyer shorted, missed, or never paid.

## How to use it

- The list shows each settlement with its buyer, date, line count, how many lines are still unmatched to loads, net bushels, and net revenue — plus a link to the original document. Tap any row to open the settlement's own page.
- To enter one, tap New Settlement. Three ways to get the lines in:
- **Upload the statement** — a PDF or a photo. Turnrow reads the settlement number, date, buyer, and every line (ticket number, net bushels, gross revenue, discounts) into editable rows for you to review before saving. It also itemizes each deduction the statement shows — drying, test weight, dockage, and the rest — into its own discount lines, however the buyer formats them (named charges, footnote codes, or a combined "less discounts" total, which stays labeled as written rather than being guessed into a category). A deduction taken as **weight** instead of dollars — pay bushels quietly reduced below gross — is captured as a weight line; Turnrow values it from your own load reconciliation so it's never counted twice. A warning shows if the itemized dollar lines don't add up to the statement's discount total.
- **Upload a spreadsheet** — columns for ticket number, net bushels, gross revenue, and discounts (a template is downloadable).
- **Type the rows** by hand.
- As you review, each line shows whether its ticket number matches one of your loads. Save, and the settlement is recorded with its lines tied to loads.
- Open a settlement anytime to see its reconciliation page.

## The settlement detail page

Open a settlement and everything about it is on one page: the header (editable with **Edit**; **Delete** removes the settlement and its lines after a confirmation, sending its loads back to Unpaid), the original document, gross/discounts/net totals, and the sections below.

**The Discounts block** shows every deduction as its own line — the type, the statement's own wording, the dollars, and what it works out to in cents per settled bushel — then walks the price: gross $/bu, less discounts ¢/bu, equals net $/bu. It also shows the **weight deduction beyond standard shrink**: the buyer's pay bushels compared against your FSA-standard dry bushels, priced out — a real cost the price discounts never show. Statements entered by hand, or ones the upload couldn't fully itemize, can have discount lines added or corrected right here; these lines feed the Buyer Discount Comparison report.

Three sections do the reconciling:

- **Matched loads** — lines tied to a load, showing your dry bushels beside the buyer's net bushels. A difference over 1% is flagged so you can see where their scale or grading disagrees with yours.
- **Unmatched lines** — settlement lines Turnrow couldn't tie to a load. Two kinds: **Ambiguous** (the ticket number matches more than one of your loads, so it needs you to pick) and no match at all (you may never have entered that load). Each unmatched line has a dropdown to match it to the right load by hand.
- **Missing loads** — loads you delivered to this buyer in the contract's delivery window that appear on no settlement yet. These are the loads you haven't been paid for.

Matches are remembered: once a line is tied to a load — automatically by ticket or by your manual pick — that load shows Paid everywhere in Turnrow.

## How the numbers work

- **Net revenue** = gross revenue − discounts, per line; the settlement totals sum its lines.
- Matching goes by ticket number. A ticket that matches exactly one load ties automatically; shared ticket numbers wait for a manual pick rather than guessing.
- The paid/unpaid badge on the Loads page comes straight from this matching — a load is Paid when a settlement line is tied to it.

## Common questions

- **The upload read my statement wrong.** Fix any cell in the review rows before saving — nothing is recorded until you save. The original document stays attached either way.
- **Why is a line Ambiguous?** Two or more of your loads share that ticket number. Pick the right load from the line's dropdown; consider correcting the duplicate ticket on the loads themselves.
- **A load shows Unpaid but I have the check.** The settlement covering it hasn't been entered, or its line didn't match — check the ticket numbers on both sides, or match it by hand on the settlement page.
- **Their bushels don't match mine.** Small differences are normal (their shrink and dockage math). The page flags anything over 1% so you can decide whether to call the elevator.
- **Can I attach the original statement?** Yes — uploading the PDF or photos stores it with the settlement, viewable from the list and the detail page.

## If something looks wrong

- Unmatched lines piling up: compare ticket numbers character for character — a leading zero or a typo on either side breaks the match.
- Missing-loads section lists a load you know was paid: it's probably on a settlement you haven't entered yet.
- Totals that won't reconcile after that: contact support.
