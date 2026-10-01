# Turnrow capabilities digest

Generated 2026-10-01 · version 0.1.0 · build 4cdd322. Compiled from docs/help — regenerate with `npm run help:build`.

# What Turnrow does NOT do

Turnrow tracks grain and cotton from the field through storage, contracts, settlements, hedging records, crop insurance, and government programs. It deliberately does not do the following — if someone asks, say so plainly and don't improvise a workaround:

- **No accounting or taxes.** Turnrow is not a bookkeeping system. It projects revenue and profit for planning, but it does not produce a P&L, balance sheet, or anything for a tax return.
- **No marketing advice.** Turnrow records your contracts and hedges and shows your position. It never recommends when or what to sell.
- **No agronomy.** No seed, chemical, or fertility recommendations; no scouting or spray records.
- **No field maps or GPS.** Fields are records with acres, not drawn boundaries. No equipment or planter/yield-monitor connections.
- **No weather.**
- **No bank or brokerage connections.** Brokerage statements and buyer settlements come in as uploads you review — nothing links to an account automatically.
- **No payroll, HR, or equipment maintenance tracking.**
- **No app-store app.** Turnrow runs in the browser and can be added to a phone or iPad home screen from the browser's share/menu button (Safari shows a one-time hint on the sign-in and home pages).
- **No automatic price alerts or texts.** Market prices appear on-screen when pages load.
- **No offline use.** Turnrow needs a connection to load pages; with no signal it shows an offline page and asks you to reconnect. Nothing typed on a page is kept across a reload.
- **US grain and cotton, US dollars, US programs only.**
- **No self-serve signup.** New farms and new users join by invitation — an owner adds people under Settings → Users.

# Ask Turnrow  (page: /assistant)

## What this is for

Ask Turnrow answers questions about **your own account's numbers** in plain English — "What's my average corn price this year?", "Which field yielded best?", "What's sitting in the bins?". It reads the same data your reports do, so its answers match what the report pages show. It also answers how-do-I questions about using Turnrow, and keeps the two kinds of answers clearly separate.

## How to use it

- Open the **?** in the top bar and pick the **Ask Turnrow** tab, or open the full page from that tab.
- Type a question, or tap one of the suggested starters. Answers stream in; while it's checking your records you'll see what it's looking at ("Checking your yields…").
- Every data answer notes it came **from your Turnrow data as of that moment**, with links to the report where you can verify the same number.
- If your question could mean two things ("how much corn do I have" — in the bins? unsold? total production?), it asks which you mean instead of guessing.

## What it can answer

**Anything in your Turnrow records.** Every part of the app is open to it — it never tells you something "isn't available through the assistant" or sends you to a page instead of answering. If nothing matches, it says exactly what it looked for ("no cotton contracts found for that buyer in 2026") and offers the nearest thing it did find. The only other "can't" is a role limit on your own account, which it says plainly.

What it covers, module by module:

- **Marketing** — average prices, contracted and unpriced bushels, blended revenue, cost and profit per crop.
- **Yields** — by field, farm, entity, landowner or crop, including combine-monitor entries and how they reconcile with weighed loads.
- **Contracts** — grain contract delivery progress, prices and status; **seed production contracts** with their pricing elections, the expected price walk, and payments.
- **Cotton** — sales contracts (bales committed, delivered and remaining, pricing status), pools and their payments, CCC loans, LDPs, the bale disposition board, gin receipts, bales, classing grades, and lint per acre.
- **Settlements** — each statement's bushels, gross, net and average price, with every itemized discount in dollars and cents per bushel.
- **Hedging** — open and closed positions, rolls and effective prices, and the full history trail.
- **Bins** — what is on hand, bin-to-bin transfers, adjustments.
- **Loads** — recent loads with weights, moisture and bushels; buyer discount schedules and what each buyer's discounting really cost.
- **Insurance and government** — policy estimates, ARC/PLC and other payment projections.
- **Leases and rent** — lease terms and recorded rent settlements per landowner; **budgets** — crop budget scenarios with revenue, profit and breakevens; dryer and freight settings.
- **Cash flow**, entities, farms, fields, landowners, buyers, users and settings.

It always shows units and the crop year it used, and it never makes up a number: if the data isn't there, it says so.

## How answers are laid out

Both assistants — Ask Turnrow and the how-to chat in the Help drawer — write their answers in a readable layout rather than a wall of text.

- Several rows of numbers (per field, per crop, per contract) come as a **table** with the units in the column headings and the total on the last row.
- Steps come as a **numbered list**; short sets of things as bullets. The headline number is in **bold** in the first sentence.
- Any link in an answer opens in a new tab, so the conversation stays where it is.
- Answers appear as they are written, so a table may fill in row by row for a second or two.

## Who can see what

- The assistant only ever sees **your account's own records** — that separation is enforced by the database itself, not by the assistant's good manners. Nothing you ask or see is visible to any other operation.
- Each user's answers follow their own role: a viewer's assistant sees only their granted entities; an agronomist's only yield data.

## Common questions

- **Where do I find it?** Press the **?** button on any page and open the **Ask** tab — **My numbers** is Ask Turnrow on your own data; **How Turnrow works** answers questions about using Turnrow from these help guides. The full-page version is at Ask Turnrow from the home page.
- **Is this the same as the help chat?** My numbers answers questions about *your data*; How Turnrow works answers questions about *using Turnrow*. Ask Turnrow can handle both, and labels which is which.
- **It once told me some data wasn't available through the assistant.** That should no longer happen — every module is reachable, and an answer that tries to send you to a page instead of answering is caught and re-asked before you see it. If you still get one, contact support with the question you asked.
- **Why does it say a year I didn't ask about?** If you don't name a crop year it uses your most recent one with data — and tells you which.
- **It says it hit a lookup limit.** One question gets a handful of data checks; ask a follow-up and it keeps digging.
- **How many questions can I ask?** There's an hourly cap to keep things snappy — if you hit it, give it a little while.

## If something looks wrong

- If a number surprises you, open the linked report — that page is the source of truth, and the footer on each answer links straight to it.
- Numbers that involve live futures quotes can differ slightly from the report pages: the assistant uses your stored positions and assumptions, and the reports layer live quotes on top.
- Anything else, contact support.

# Bin Inventory  (page: /inventory)

## What this page is for

Bin Inventory shows the dry bushels sitting in each bin right now, grouped by bin site. It's a live snapshot built from your load log: every load hauled into a bin adds, every load hauled out subtracts, and bin-to-bin transfers move grain between bins. Each site shows its bin count, total bushels, and a per-crop breakdown, so you can see at a glance what's on hand and where. Bushels show as whole numbers.

## How to use it

- Skim the site headers for totals, then the bin cards under each site for what's in each bin by crop.
- Use the **Entity**, **Site**, and **Crop** dropdowns to narrow the view — the page updates as soon as you pick one.
- Bins with a capacity set (under Settings → Bin Sites & Bins) show a **percent-full bar**: green when there's room, amber above about 90%, and red at or over capacity. Since inventory is an estimate, an over-full bin shows ">100%" rather than pretending it stopped at the brim. Bins without a capacity just show their bushels, same as always.
- Site headers roll capacity up too: the bar compares the grain in that site's capacity-rated bins against their combined capacity. If some bins at the site have no capacity set, a note says they're left out of the percentage.
- **Transfer grain** records grain moved from one bin to another — for example, out of a wet bin into a dry bin after drying. Pick the from bin, to bin, crop, and date, then either type the bushels or estimate them from run time.
- When you first start with Turnrow and a bin already has grain in it from before your load records begin, tap **Beginning inventory** on that bin and enter the dry bushels (with an as-of date and a note). That grain then counts until the bin is next emptied.
- When a bin is cleaned out, tap **Empty bin**. Turnrow shows you what it thinks is in the bin — the bushels of each crop — and asks you to confirm before it records a cleanout that zeroes the bin. That keeps small leftovers from shrink and scale drift from accumulating year over year.
- **Export** — Excel, PDF, CSV, or Print — downloads the current view, including each bin's capacity and percent full.

## Transferring grain between bins

- Tap **Transfer grain** at the top of the page (or on a bin's card to start from that bin). The crop defaults to whatever the from-bin holds the most of, and the date defaults to today.
- **Two ways to enter the amount:** type the bushels directly, or switch to **Estimate from run time** and enter your auger or leg's throughput (bushels per hour) and how long it ran. Turnrow multiplies them — 850 bu/hr for 2.5 hours is 2,125 bu — and drops the result into the bushels box, where you can still adjust it. Turnrow remembers the last throughput you used so you don't retype it.
- If you transfer more than the from-bin shows on hand, Turnrow warns you and asks before it records it — bin inventory is an estimate, and you may know better than the math. If you see that warning often, a load or transfer is probably missing.
- Each bin's card lists its transfers under **Transfers** — tap to expand. Estimated transfers show the throughput and hours behind the number. You can edit or delete a transfer there (delete asks first); both bins recalculate automatically.
- Transfers only move grain between bins. They never change yields, production, contract deliveries, or marketing numbers — those all come from loads.

## What the controls do

- **Entity** shows only sites belonging to that entity; **Site** narrows to one site; **Crop** shows only that crop's rows in each bin.
- **Empty bin** doesn't delete any loads — it records an offsetting adjustment dated today, so your load history stays intact.
- **Beginning inventory** takes dry bushels, an optional moisture, an as-of date, and a note. Bins carrying an active beginning inventory show it called out on the card, and the card breaks the total into bushels **from loads**, transfers, and beginning bushels so you know how much is measured versus carried in.

## How the numbers work

Each bin's balance per crop is: bushels delivered to the bin, minus bushels hauled out of the bin, plus any beginning inventory, minus any empty-bin cleanouts, plus transfers in, minus transfers out. All quantities are dry bushels — each load's net weight converted at the crop's pounds per bushel with shrink applied for moisture above the crop's base. Loads from any crop year count; this page shows what's physically in the bin today, not one season's production.

Because transfers are recorded in dry bushels on both ends, moving grain from a wet bin to a dry bin doesn't change your total inventory — the drying shrink was already taken out when the wet loads were converted to dry bushels coming in. A transfer just changes where the grain sits.

## Common questions

- **Why doesn't the bin match what I think is in it?** Usually a load is missing (a haul out that never got entered), a load's to/from bin is wrong, or a bin-to-bin move never got recorded as a transfer. The balance is only as good as the log.
- **A bin shows a small negative or leftover number after I hauled it all out.** That's normal drift from shrink and scale differences. Tap Empty bin to zero it.
- **A bin shows more than 100% full.** The bar is comparing estimated bushels against the capacity you entered. Either the capacity is set low, or a haul-out or transfer out is missing. It's shown as ">100%" on purpose so you can spot it.
- **What are "Unsited bins"?** Bins that haven't been assigned to a bin site. They're flagged in red so you can fix them under Settings — assign each bin to a site and they'll file under the right header. They also won't appear when you filter by entity or site until they're assigned.
- **Does emptying a bin or transferring grain affect my yields or loads?** No. Both only adjust where inventory sits. Loads, yields, and contracts are untouched.
- **Where do I set a bin's capacity?** Settings → Bin Sites & Bins — edit the bin and fill in **Capacity (bu)**. It's optional; the spreadsheet import has a capacity column too.
- **Can I correct a beginning inventory I entered wrong?** Enter the bin's true state by emptying it and re-adding the correct beginning inventory, or contact support to remove the bad entry.

## If something looks wrong

- Check the filters first — an entity or crop filter hides bins and rows.
- Compare the bin's loads on the Loads page (filter by the bin) against your own records; a wrong to-bin or from-bin on one load is the most common cause.
- Expand the bin's **Transfers** list — a duplicate or misdirected transfer shows up there and can be edited or deleted on the spot.
- Make sure every bin is assigned to a site and each site to the right entity.
- If the balance still won't reconcile, contact support.

# Contracts  (page: /contracts)

## What this page is for

The contract tracker shows every grain contract with how much you've delivered against it, how it's priced, and what's been paid. Progress bars make it easy to see which contracts are filled, which still owe bushels, and which have pricing left to set before a deadline bites.

## How to use it

- Cards at the top total what's on screen: contracted, delivered, remaining to deliver, delivered-but-unpaid (with the dollars waiting at contract price), and the share fully priced. Pick a crop year and a **Sold vs unsold** bar appears: fully priced and seed contracts in green, contracts with a pricing leg still open in amber, and the rest of that year's expected production as unsold. It uses the expected yields you keep on the Marketing page — until those are entered for the year it shows the sold totals only.
- Each row shows the buyer, type, crop year, date sold, where it delivers, the delivery window, contracted versus delivered bushels, progress (percent delivered for grain, percent priced for seed), price, contract value, and paid versus unpaid bushels with the unpaid dollars. A totals row closes the table. Tap anywhere on a row to open the contract; the contract number stays put while you scroll a wide table sideways on an iPad.
- Tap a contract to open its printable detail page: the full terms, every load delivered against it (your dry bushels beside the buyer's settled net bushels), attachments, and actions to mark it complete or delete it.
- Press **New Contract** to type in one grain contract — buyer, crop, crop year, and contracted bushels are required, and the form points out anything missing before it saves. The small caret beside the button holds **Seed contract** for acreage-based seed production agreements and **Several at once** for entering from a spreadsheet or a contract document (Settings → Contracts).
- Attach the signed paper contract on the detail page so it's always at hand.

## Contract types in plain words

- **Forward (cash)** — both the futures price and the basis are locked. Your price is set; all that's left is delivery.
- **HTA (hedge-to-arrive)** — the futures price is locked, the basis is still open. Your price moves with local basis until you set it.
- **Basis** — the basis is locked, the futures price is still open. Your price moves with the futures market until you set it.

When you later set the open leg — an HTA gets its basis, or a basis contract gets its futures — the contract shows as Forward, because at that point both legs are locked and it prices like one. The pricing status (fully priced, awaiting basis, awaiting futures) is shown and filterable on the list.

- **Seed** — a seed production agreement (growing seed beans for a seed company). These commit acres instead of bushels and have their own entry form, detail page, and progress: the bar shows the share of the bushels you've priced, not deliveries, and the contract completes when the final payment arrives. See the **Seed production contracts** help topic for the full story.

## What the controls do

- **Filters apply as you change them and stay put** — entity, crop, crop year, type, pricing, and the Completed / Not open yet toggles are remembered: leave the page and come back and your last view is waiting, from the very first moment the page draws (it never shows everything and then narrows down a second later). While the list refreshes after a change, the bar says *Updating the list…*; change two things quickly and both are kept. The line under the title states the filters in words, and a note beside the legend counts what the current filters leave out (completed contracts, ones not open yet, and — under an entity filter — contracts written with no entity). **Clear filters** (shown whenever any filter is on) resets to everything and forgets the saved view.

- **Date sold** — an optional date on each contract recording when you made the sale. Informational: it prints on the contract page and exports, and doesn't change any delivery or payment math.

- **Warnings** appear at the top for contracts approaching risk: an HTA or basis contract with pricing still open whose contract month's first notice day is within 30 days (or already past), and contracts whose delivery window ends within 14 days. Both warnings stop once a contract is completed — marked complete or fully delivered — since there's nothing left to price or deliver.
- **Entity** on a contract is optional. If your operation has one entity, Turnrow fills it in for you — you'll see it on the form but won't need to touch it. With more than one entity, leave it blank when the contract belongs to the operation as a whole, or pick an entity when one company holds the contract in its own name. If your operation markets everyone's grain through a single marketing company, put that company on the contract — entity-filtered reports then share its bushels out to the farming entities by their share of the acres.
- **Load warnings** at the top flag two things: loads delivered to a buyer with no contract picked (open Loads to attach them so the bushels count), and loads still pointing at a contract that has since been deleted. Both counts follow the crop year, crop, and entity filters, so they describe the same slice of the operation the table does.

## How the numbers work

- **Delivered** counts the loads attached to the contract. **Remaining** = contracted − delivered.
- **Contract value** = contract price × contracted bushels, for priced contracts.
- **Paid bushels** are the buyer's settled bushels from settlements. **Unpaid bushels** are delivered loads not yet on any settlement, and **Unpaid $** is those bushels at the contract price — what you're still owed at that price.
- The contract page shows **Fully delivered** once delivered bushels reach the contracted amount, or the date you marked it complete.

## Common questions

- **I picked an entity and most contracts vanished.** An entity filter shows only contracts written in that entity's name. Contracts entered with no entity belong to the operation as a whole and are left out — the note beside the legend says how many. Clear the entity filter to see them.
- **Why is a contract's price blank?** One pricing leg is still open. An HTA shows no cash price until its basis is set; a basis contract, until its futures is set.
- **Why did my HTA start showing as Forward?** You set its basis. Both legs are now locked, so it reads as a forward — the history is still on the contract.
- **A delivered load isn't counting against the contract.** The load isn't attached to it. Open the load, edit it, and pick the contract.
- **What does marking a contract complete do?** It ends the warnings and stops the contract from projecting future revenue in reports. Use it when a contract is finished even if a few bushels never shipped.

## If something looks wrong

- Delivered bushels off: check that every load for that buyer is attached to the right contract, and that the crop year matches.
- A warning that shouldn't be there: confirm the contract month and delivery dates are entered correctly.
- Anything else: contact support.

# Cotton Marketing  (page: /cotton/marketing)

## What this page is for

Cotton Marketing tracks what happens to your bales after the gin: sales contracts, CCC loans, LDPs, and the fees that ride along. The **Bale Disposition board** always shows where every bale stands — held, in loan, sold, pooled, or delivered — with counts and pounds and a per-bale drill-down. This page is owner-only; gin-operator logins never see it.

## How to use it

- **Sales Contracts** — four types, and the form adapts to each: **spot** (sold outright), **fixed** (price locked), **on-call** (basis set, futures month named, price open — a **Fix futures** button locks it later, and cash equals basis plus the fixed futures), and **pool** (a payments ledger tracks advances, progress payments, and the final).
- **CCC Loans** — pick held bales with the receipt-filtered picker. Principal per bale is its classing loan value in cents per pound times its pounds; an unclassed bale uses the base rate with a "pending classing" flag and a **Recompute** button once grades import. Maturity is nine months from entry. Three ways out: **Redeem** (enter the AWP — payoff and any marketing loan gain are computed, interest waived, bales return to held), **Equity sale** (enter the equity cents per pound and buyer — effective price is the banked loan value plus the equity), or **Forfeit**.
- **LDP** — enter an LDP instead of a loan. The rate fills in automatically as the loan rate minus the AWP, never below zero. A bale that takes an LDP can never go into loan, and a loan bale can never take an LDP — the app enforces it.
- **Fees** — set a per-year fee schedule (storage per bale per month, receiving, classing, checkoff plus the supplemental percentage, interest rate) and the page projects accruals; actual invoices replace the matching projection when entered.
- **AWP** — enter the weekly Adjusted World Price, or use the AI lookup with a confirm step.
- **Upload Marketing Document** — one button handles seven document kinds: sales contracts, pool payment notices, CCC loan documents (including the full PBI bale list), LDP notices, equity sale confirmations, warehouse/storage invoices, and bare bale-number lists. The app classifies the document, extracts its fields, and shows a pre-filled review panel — existing records are updated by their contract, loan, or invoice number, never duplicated. If the app isn't confident what the document is, it asks you to pick.
- **Assign bales from file** — on any bale picker, load a CSV, text list, or even a PDF or photo of a recap sheet. Bale numbers are matched by PBI, conflicts (wrong disposition, loan/LDP exclusion) are blocked with the reason, and unmatched numbers are listed verbatim.

## How the numbers work

- Loan principal: classing loan value × pounds (a 509-pound bale at 55.1 cents is $280.46).
- LDP rate and marketing loan gain are the same number: loan rate minus AWP, floored at zero.
- Redemption payoff: principal minus the marketing loan gain, interest waived.
- Equity sale effective price: banked loan value plus equity cents per pound.
- On-call cash price: basis plus the fixed futures — unpriced until you fix.
- The disposition board conserves every bale: nothing is dropped or double-counted.

## Common questions

- **Why is a loan blocked from re-upload?** The document's loan number matches a loan that is no longer open.
- **Why can't I pick certain bales?** They're already sold, in loan, pooled, or LDP'd — the picker shows the reason.

## If something looks wrong

- If principal looks off, check for "pending classing" bales and press Recompute after grades import.
- If a fee looks doubled, confirm the actual invoice replaced its projection rather than adding a second row.
- Anything else, contact support.

# Cotton — Loads, Gin Receipts, Bales & Grades  (page: /cotton)

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

# Crop Insurance  (page: /settings/crop-insurance)

## What this page is for

This is where your crop insurance policies live. Enter each policy once — plan type, coverage, APH, acres, premium — and the Claims Monitor, Income Sensitivity, and Cash Flow reports estimate from them all season. The page also holds your projected prices, your county yield assumptions, and a Coverage Check that reconciles insured acres against planted acres.

## How to use it

- Add policies by hand or with the **AI policy upload** — a photo or PDF of your schedule of insurance becomes editable rows, one per crop, county, and practice.
- Each policy line carries plan type (RP, RP-HPE, YP, or the county-based ARP/AYP), the **practice** (irrigated or dryland — the same crop, county, and year can carry one of each), coverage level, unit structure, APH yield, projected price, insured acres, premium, and policy number.
- Add **SCO, ECO, STAX, or MCO** endorsements on the policy form. STAX carries its cotton coverage band and protection factor; MCO carries its margin band and expected margin. For ARP/AYP the form shows the expected county yield or revenue and protection factor, and notes that your farm yield isn't used.
- Every policy belongs to **one entity**. Single-entity operations assign automatically; multi-entity operations pick the insured entity on upload or entry.
- Run the **Coverage Check** to compare insured acres against planted acres by entity, crop, county, and practice.

## What the controls do

- **AI policy upload** — extracted rows are compared against what's already entered: identical policies show as "Already exists", changed ones show a field-by-field difference and update the existing policy in place (never duplicated), and only new combinations are added. You can tick the "covers all planted acres" attestation per row before saving.
- **Crop Insurance Price Discovery** — one table for every insurance price, one row per crop you grow. Each row shows which RMA offer it is (your state, the practice, the sales-closing date), the futures contract that offer is actually priced on (a Southern corn offer can price on September, not December — Turnrow uses the offer's own contract), and both prices with a colored chip saying exactly where each number came from.
- **The harvest price moves through three phases**, and the chip tells you which one you're in: before the discovery window it's an estimate from today's price of the offer's contract ("est. — ZCU26 today, discovery starts 8/1"); during the window it's RMA's own running average, updated daily ("RMA discovery avg… day 14 of 31"); after the window closes it's the published RMA final, and it stops moving.
- **The projected price** fills in automatically from RMA once its window closes (green "RMA released" chip). Type your own number to override — Turnrow keeps yours and shows a note with what RMA published; "Reset to RMA" restores the published value. A crop with no RMA offer for your state says so and stays on the estimate.
- **Winter crops run on an earlier calendar.** Fall-planted crops (winter wheat, canola) get their projected price the summer BEFORE planting and their final harvest price at early-summer harvest — so by fall both prices already show as RMA finals, with last year's dates on the windows. That's correct, not stale. Turnrow picks the winter offer automatically for spring-harvested crops. If your state lists both Winter and Spring offers for a crop (Idaho wheat, say), the row asks you once — "Idaho lists both Winter and Spring wheat insurance. Which do you grow?" — and remembers the answer; states with one offer never see the question. The answer is also reachable under Settings → Crops → Edit as "Crop insurance type (winter/spring)".
- **The harvest price is editable here too** — type a value to enter your own harvest price (marked manual; it beats the running average and the estimate), and "Reset to RMA" restores the automatic value. If RMA later publishes a final that differs, you'll see the notice with a "keep mine" choice — kept manual values carry through the Claims Monitor and Income Sensitivity.
- **"No RMA offer found"** on a row means RMA genuinely lists no revenue-price offer for that crop in your state — it's not an error. The estimate keeps working and you can still type a price. If a row instead says RMA was unreachable, that's a connection problem: your last-known values stay put and ↻ retries.
- **Overrides live here.** The reports show where each price came from, but changing a price always happens on this page — the Claims Monitor links back here ("Price details & overrides").
- **Refreshing is always safe** — ↻ pulls the latest from RMA (per row or all at once). If RMA can't be reached, your current values stay on screen with a note saying how fresh they are; a refresh never clears the table.
- **County yield assumptions** — the "my yield vs county" differential per crop, county, and year: how much your yields run above the county average, in the crop's own unit. Estimated county yield equals your yield basis minus this differential, and it drives every county-triggered endorsement. This is separate from the ARC-CO expectation on the government pages. Values save when you leave the field.
- **Coverage Check** — flags combinations with no policy, more planted than insured, or more insured than planted. Ticking **"covers all planted acres"** on a policy marks its combination Covered and quiets the acre-mismatch flag — but a combination with no policy at all is always flagged.
- **Stacking warnings** — appear above the list when endorsement combinations need agent review (for example ECO with STAX). Warnings only; nothing is blocked.

## How the numbers work

- APH, coverage level, projected price, and acres entered here are exactly what the Claims Monitor multiplies through — a wrong APH here means a wrong estimate everywhere.
- Cotton insurance prices are **dollars per pound** (for example 0.68), not cents. Entering cents produces absurdly large estimated indemnities, and the Claims Monitor will flag it.

## Common questions

- **Small acre differences keep getting flagged.** The Coverage Check tolerates small differences; anything larger needs either corrected acres or the covers-all-planted attestation once your agent confirms.
- **Why did my upload say "Update available"?** A policy with the same entity, crop, county, year, practice, and plan already exists with different values — review the differences and confirm.

## If something looks wrong

- If the Claims Monitor looks off, check this page first: APH, coverage level, practice, prices, and entity assignment.
- If a policy vanished from a report, confirm its crop year and entity.
- Anything else, contact support.

# Getting Started  (page: /)

## What this page is for

The home page is your launcher. The big green **New Load** button at the top starts a truck load — the thing you do most during harvest. Below it, a tile opens each of the other main areas of Turnrow — Loads, Bin Inventory, Contracts, Settlements, Yields, Hedging, Reports, and Settings — the same destinations as the green bar across the top. If your operation is new in Turnrow, a setup checklist appears above them until your first load is in.

## How to use it

Tap a tile to go to that area. On a new account, work down the **Welcome — let's set up your operation** checklist. Each step opens the page that does the work, a green check appears as you finish it, and the corner shows how many are done:

- **Upload your FSA-578 / 156-EZ or a lease** — the fastest start. Turnrow reads the document and fills in entities, farms, fields, and plantings at once, for your review. Skip this if you'd rather type them in.
- **Create your entities** — the companies and people that farm.
- **Add your farms** — each FSA farm, linked to its entity, county, and landowner.
- **Add your fields** — the fields on each farm, with total and irrigated acres.
- **Record this year's plantings** — which crop went in which field this season.
- **Confirm your crops** (marked *Review*) — the standard crops come pre-loaded; check the names and harvest seasons match how you farm.
- **Trucks & bins** (optional) — add them here, or the first time the load form asks.
- **Enter your first loads** — type one in at New Load, or photograph scale tickets at Loads → Scan.

That order matters: farms need an entity, fields need a farm, and loads need fields, crops, trucks, and bins to point at.

## What the controls do

- **The checklist** shows only to owners, and only until the first load is recorded. **Hide setup** puts it away for good on this device; you can still reach every step under Settings.
- **The tiles** mirror the top navigation exactly. If Cotton is turned on for your operation (Settings → Organization), a Cotton tile appears as well. On a phone the green bar shows the first few areas and a **More** button for the rest.
- **The ? button** in the top bar is on every page, for every role. It opens Help with three tabs: **Help** (a guide to the page you're on, with all topics and search underneath), **Ask** (Ask Turnrow — *My numbers* answers from your own data, *How Turnrow works* answers from these guides), and **Support** (a message to a person). The **Help center** link inside it opens the full searchable Help Center.
- **Put Turnrow on your Home Screen** — on an iPad or iPhone, Safari shows a one-time hint: tap Share, then Add to Home Screen, and Turnrow opens full-screen like an app.

## Common questions

- **Where are the importers?** Most setup pages accept files so you don't retype what you already have. Settings has an upload card that takes any document; Fields, Plantings, Farms, Landowners, and Trucks take a spreadsheet too. Loads can come in three ways: typed one at a time, scanned from ticket photos at Loads → Scan, or uploaded as a spreadsheet at Loads → Import.
- **Do I have to finish the checklist before using the app?** No. Any page works at any time — the checklist is a guide, not a gate.
- **What's a planting?** A field, a crop, and a season together — for example, Field 12, corn, 2026. Plantings are what yields, insurance, and marketing reports are built on.
- **I farm under several companies. How do those fit?** Each one is an entity. Farms belong to entities, and most reports can be filtered by entity, so keeping them straight up front pays off later.
- **I farm under just one company. Do I have to keep picking it?** No. With a single entity, Turnrow fills it in for you everywhere — entity dropdowns disappear from forms and imports until the day you add a second entity.
- **Can more people on my crew log in?** Yes. Under Settings → Users an owner can add people by email and choose what each one sees.
- **What if I lose signal?** Turnrow needs a connection to load pages. If one won't load, you'll see an "You're offline" page — reconnect and try again.

## If something looks wrong

- A checklist step won't check off: confirm you actually saved at least one record on that page.
- A tile you expect is missing: your login may limit what you see — an owner can check it under Settings → Users.
- If the checklist or tiles still look wrong after that, contact support.

# Government Payments  (page: /settings/government-payments)

## What this page is for

This page holds the data that drives every ARC/PLC projection: your farms' base acres and elections, MYA prices, ARC-CO benchmarks, and the program-year parameters. The Decision Aid and Payment Tracker compute from what you enter here.

## How to use it

- Pick the **Program year** at the top — everything on this page is keyed to it, and links from the reports arrive with the right year already selected.
- Load **base acres** fastest with the FSA form import: upload your FSA base-acres document and the app extracts each farm's commodities, base acres, and PLC yields into a review table. FSA paperwork often repeats a farm and commodity across tracts and pages; duplicate lines are combined at review with a note showing what was merged. You confirm before anything saves. If the document names a farm that isn't in Turnrow yet, the review offers to **create that farm** right there — check the box and its base acres save with it (finish its county and entity later under Settings → Farms).
- Enter or look up **MYA prices** per commodity and month. The **USDA lookup** pulls real published prices received by farmers; fetched months appear beside anything you typed, and already-entered months start unchecked so nothing is overwritten without your say-so. A WASDE midpoint can stand in before months publish, and a published final locks the row. If the lookup comes up empty, an AI lookup is offered as a clearly labeled fallback.
- Enter **ARC-CO benchmarks** — the FSA benchmark price and county yield per commodity and county. The county picker starts with your own counties and can open to any state and county.
- Review **Program Parameters** per year: the SCO trigger, the per-person payment limit, the sequestration percentage, and payment factors.

## What the controls do

- **FSA lookup** (on a benchmark row) — reads the county benchmark yield straight from FSA's published "ARC-County Benchmark Yields and Revenues" workbook, with an irrigated/non-irrigated choice when the county publishes both. If nothing is found, you can borrow from a nearby county in the same state or a prior year — borrowed values save to your own county's row with the borrowing noted, and amber chips show before you confirm.
- **Payment limits** — shown read-only here. The eligible-persons count is set per entity under Settings, Entities; the cap is persons times the per-person limit for the program year.
- **ARC flat rates** — a fallback flat per-acre estimate used only for counties without benchmark data; reports label it "flat est.".

## How the numbers work

- PLC projections need the MYA and each farm's base acres and PLC yield. ARC-CO projections additionally need the benchmark price and county yield for the farm's county and this program year.
- Base acres pay independent of what you plant; unassigned base carries no payment.
- The MYA precedence everywhere is: published final, then your manual entry, then the WASDE midpoint, then the running estimate.

## Common questions

- **Which year do I enter benchmarks under?** The program year the reports are computing. If a report warns that benchmarks exist only for other years, use its link — it lands here preset to the right one.
- **My county's name exists in two states.** Benchmarks are stored against the specific county and state ("County, ST"), so pick carefully in the county picker.
- **The FSA import shows a merged line — is that right?** Yes — the same farm and commodity appeared on multiple lines of the document, and they were summed with an acre-weighted PLC yield. Expand the note to see the pieces.

## If something looks wrong

- If a projection seems off, check the MYA row's status chip — an estimate behaves differently than a final.
- If ARC-CO shows a flat estimate, that county and program year has no benchmark row yet.
- Anything else, contact support.

# Hedging  (page: /hedging)

## What this page is for

Hedging tracks your futures and options positions alongside the crops they protect. Open positions are valued against current market prices so you can see where you stand today; closed positions keep their final results by crop year. Summary cards roll everything up by crop year and commodity.

## How to use it

- **New position** records a trade: commodity, contract month, buy or sell, number of contracts, price, date, and account. Options carry strike and premium as well.
- When you offset a trade at the brokerage, use **Close** on the position and enter the closing price, date, and commission. The result moves from unrealized to realized.
- When you move a hedge out to a later month, use **Roll…** on the position: pick the new month, enter the price the old month closed at and the price the new month opened at, the date, and any fees. Turnrow closes the old leg, opens the new one, and links the two — the new month keeps the same crop year automatically.
- Or skip the typing: **import a brokerage statement** (photo or PDF). Turnrow reads the open positions, closed trades, rolls, and cotton alongside the grains, shows everything on a review screen, and saves only what you confirm.
- Filter by crop year, commodity, entity, and open / closed / both; closed positions can be narrowed by date range. Filters apply as you change them and are remembered for next time.
- On each open row, **Close** and **Roll…** are the two buttons; **Edit**, **History**, and **Delete** sit behind the **…** button, and Delete always asks first. **Update** on an option is where you type today's premium when there is no live price.
- Switch the page between **Positions** and **History**. History is the running record of everything that ever happened to your hedges, newest first.

## What the controls do

- **Open / Closed tables** — open positions show live gain or loss at current prices; closed positions show the locked-in result net of commissions. Losses print in parentheses, like ($1,250.00). The commodity column stays put when a wide table scrolls sideways on an iPad.
- **Statement import** matches what it reads to positions you already have, so re-importing a statement doesn't duplicate anything. Closed trades come in lot by lot: each opening lot becomes its own closed position with its own result, and the lots are checked against the statement's total — a disagreement over a dollar is flagged on the review screen for you to look at.
- The import also runs a second check: positions Turnrow shows open that don't appear on the statement are flagged as possibly closed. You choose — **Close this position** (which walks through the normal close, nothing closes automatically) or **Keep open**.
- Cotton is handled in its own terms throughout: pounds instead of bushels, cents per pound instead of dollars per bushel.

## How the numbers work

- **Unrealized** is what an open position would make or lose if you offset it at the current market price: the difference between today's price and your trade price, times contracts, times the contract size. It changes with the market and isn't money in the bank.
- **Realized** is the locked-in result of a closed position: the difference between your opening and closing prices, times contracts, times contract size, minus commissions. It no longer moves.
- A sold (short) position gains when prices fall; a bought (long) position gains when prices rise.
- Options are valued off their premium: what you paid or collected versus what the option is worth now (open), or what you closed it at (closed).
- Market prices on this page are for valuing open positions and are delayed quotes — they're a gauge, not a fill price.

## Rolling a hedge to a later month

A roll closes one contract month and opens the next in the same crop's hedge — say, DEC corn rolled out to MAR. Turnrow treats the two halves as one event, not two unrelated trades.

- **Rolled positions carry a chip** on the open table — "rolled from DEC 26 @ 4.9525" — and, beside the new leg's own open price, an **effective price** since the original entry. That is the original price plus or minus what each roll cost: entered at 4.9525, closed DEC at 5.435 and opened MAR at 5.585, the roll added 15 cents, so the hedge now reads at 5.1025. Roll again and the next spread adds on. It is the price the whole crop-year hedge really sits at.
- **Statement imports find rolls for you.** When a statement shows a month closed and a different month opened the same day, same commodity, same direction, same number of contracts, the review screen shows it as one line — *Rolled 14 DEC 26 → MAR 27 on 9/03: closed DEC @ 5.435 → realized −$33,775.00; opened MAR @ 5.585 · crop year 2026 (inherited)* — with a single **Treat as roll** box already ticked. Both halves save together, linked, and the new month takes the crop year of the position it replaces. You are never asked for that crop year again.
- A roll placed as one spread order at the brokerage is recognized with the most confidence. A close and an open placed separately the same day still show as a roll, marked *same day, no spread code*, so you can untick the box if they really were unrelated. Rolling fewer contracts than you held (a partial roll) works the same way; the contracts that did not roll stay open.
- If you untick **Treat as roll**, the close and the open import as two independent trades, exactly as before.
- Rolling changes nothing in your marketing numbers: the closed leg's result is counted once and the new leg is valued at its own price, which comes to the same money as the effective price. The effective price is there so you can read the hedge at a glance.

## History — the record of every change

Every open, close, partial close, roll, edit, crop-year change, delete, and statement import is recorded the moment it happens, and the record can be read but never rewritten.

- The **History** view on this page lists one plain line per event, newest first — "9/03 · Rolled 14 DEC 26 → MAR 27 corn · −$33,775.00 realized · from StoneX statement 9/03". Tap a line for the detail: prices, fees, the roll lineage, which statement it came from, who recorded it and when, and for edits, exactly what changed from what to what. The crop year, commodity, and entity filters above apply to History too.
- **History** on any position (open or closed) shows that position's own chain, and for rolled positions the whole lineage across legs with the effective price.
- The same trail prints and exports from the **Hedging Summary** report as a *Hedging Activity* section — one row per event, in date order, with every detail column — so a full account history comes out of the report a lender already sees.
- Positions that existed before this record began carry their opening and closing entries from their own dates, marked *from existing records*.

## When a price says "manual"

Turnrow's live price feed covers corn, soybeans, and wheat. It does not cover **cotton** (ICE Cotton No. 2), and once in a while a contract month or the whole feed is unavailable. Rather than leave the number blank, any contract with no live price shows an **enter price** box — on the price board here, and anywhere else that price is needed (the Marketing Dashboard's what-if, the Income Sensitivity price axis, the Crop Budget Planner). Type the settlement from your broker or the exchange and it is saved for that contract; every screen then uses it. Cotton can be typed either way, $0.7265 or 72.65 — both mean the same price and display as dollars per pound.

- A price you typed is never dressed up as market data: it carries an amber **manual · 9/2** chip (the date you entered it) everywhere it appears — the price board, the marketing price buildup, axis headers, and the unrealized P&L rows it feeds.
- The chip warns when the price gets old: after a week it says the quote is a week old; after a month it turns red. Update it by typing over it — the same box.
- If live coverage comes back for that contract, the live price takes over automatically and the manual one is kept only as a fallback.
- Importing a brokerage statement that lists a settlement for a contract you have a manual quote on (or none) offers to update the manual quote to the statement's close with one tap.

## Common questions

- **Why does my unrealized number bounce around?** It's marked to the current market. Only closing the position locks a number in.
- **My total doesn't match the brokerage's month-end.** Check commissions on manually closed trades, and make sure every statement has been imported. Statement totals are reconciled on import, and disagreements were flagged then.
- **The import says a position is "possibly closed" but it isn't.** Choose Keep open. The flag only means the statement didn't list it — a partial statement can cause that.
- **A roll came in earlier as two separate trades — can I fix it?** Yes. Import that day's statement again: the review finds the roll, shows both halves as already recorded, and links them when you save. Nothing is duplicated, the new month picks up the right crop year, and the possibly-closed step stops flagging the old month.
- **Why does the new month show two prices?** The first is what the new leg actually opened at; the smaller *eff.* figure is the effective price since the original entry, with the roll spreads folded in.
- **Do hedge results show up in my marketing numbers?** Yes — realized futures results flow into the marketing and revenue reports, counted once, per crop year.
- **Why are there no live prices right now?** Quotes can be temporarily unavailable; positions are still there, and any contract without a price offers an **enter price** box so you can carry on with a manual quote. If live prices never come back for corn, soybeans, or wheat, contact support.
- **Why is my cotton price always "manual"?** Cotton (ICE) is not in the live feed. Enter the settlement when you check it — it is remembered until you change it.

## If something looks wrong

- A doubled position after an import: check whether the same trade was also entered by hand, and delete the duplicate.
- A wrong realized number: open the position and verify the close price, contract count, and commission.
- Lot totals flagged against the statement: trust the statement, edit the lots to match.
- Anything beyond that: contact support.

# Loads  (page: /loads)

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

# ARC/PLC Decision Aid  (page: /reports/arc-plc-decision-aid)

## What this page is for

Every year you elect ARC or PLC for each farm and covered commodity at the FSA office. This page does the homework: it projects what PLC and ARC-CO would each pay on your farms at current price expectations, compares them side by side, and lets you record your elections. The export is the page you bring to the FSA office.

## How to use it

- Start with the **Program Comparison by Crop** at the top. For each commodity it shows your base acres, the resolved MYA price, the effective reference price, the PLC payment-rate spread, projected totals under all-PLC and all-ARC-CO, the difference per base acre, and a verdict: **Favors PLC**, **Favors ARC-CO**, or **Toss-up** when the two are within a couple dollars per base acre — too close to call.
- Use the **All PLC** or **All ARC-CO** buttons to set every farm's election for a commodity at once. You'll see a list of the farms that would change before anything is saved, and individual farms stay editable afterward.
- Below the summary, each farm × commodity row shows both projections, the drivers behind them, and **Elect PLC / Elect ARC-CO** buttons to record the choice per farm.
- Drag the **What-If MYA slider** to see how both programs respond if the marketing-year price comes in higher or lower — it moves PLC and ARC-CO together.
- Export to **PDF** or **Excel** when you're ready to talk to FSA.

## What the controls do

- **Program year selector** — everything on this page is keyed to the FSA program year.
- **MYA Prices panel** — shows the price driving each commodity's projection, with its status (estimated, manual, final, or WASDE-based), a USDA lookup for real published monthly prices, and manual entry.
- **County Yield Expectation** — your expected county yield for ARC-CO, entered as a percent of benchmark or an absolute yield, per commodity and county. This is separate from the crop insurance county assumption.
- **Election buttons** — record PLC or ARC-CO per farm × commodity, or in bulk per commodity.

## How the numbers work

- **PLC** pays when the MYA falls below the effective reference price: the spread, times the farm's PLC yield, times base acres, times the payment factor, less sequestration.
- **ARC-CO** pays on county revenue: a guarantee built from the benchmark price and benchmark county yield, compared against actual county revenue, capped at a percentage of benchmark revenue.
- Counties without benchmark data fall back to a flat per-acre estimate, marked with a **"on a flat estimate"** chip — tap it to see why (no county on the farm, or no benchmark entered for that county and year). Enter benchmarks under Settings, Government Payments to replace the flat estimate with the real calculation. A row that cannot be figured yet says **needs the marketing-year price**.
- The Payment Tracker uses the identical math, so the two pages always agree.
- **SCO note**: for 2025 and later crop years, SCO can be purchased regardless of your ARC/PLC election, with an 80 percent premium subsidy. And for 2025 only, FSA automatically pays the higher of ARC or PLC per farm and commodity.

## Common questions

- **These are projections, right?** Yes. FSA determines final payments after the marketing year ends. The verdicts move as MYA expectations move.
- **Why does one farm differ from the summary verdict?** The summary sums all farms; an individual farm's county benchmark or PLC yield can tip it the other way.

## If something looks wrong

- A "flat estimate" chip means benchmark data is missing — add it in Settings, Government Payments.
- A notice about benchmark years means your benchmarks are entered under a different program year; the notice links you to the right spot.
- Anything else, contact support.

# Bale Quality Summary  (page: /reports/bale-quality)

## What this page is for

This report is part of the Cotton module — it appears in the Reports menu only when Cotton is turned on under Settings → Organization.

The Bale Quality Summary is the quality package a cotton producer shows buyers. For each field — with farm and entity rollups — it shows how many bales you made, total lint pounds, the weighted average loan value in cents per pound, and how your bales distribute across the HVI grades that drive price: color grade, staple, micronaire, and strength. When a merchant asks "what does your cotton look like?", this is the answer.

## How to use it

- Pick a **crop year**. Every classed bale for that year rolls into the tables.
- Read each field's row: bale count, lint pounds, weighted average loan cents per pound, and the grade distributions.
- Watch the micronaire columns — bales outside the 3.5 to 4.9 range are flagged as discount territory, so you can see at a glance how much of a field's crop is at risk of dockage.
- Export to **Excel** or **PDF** to share with a buyer or your marketing advisor.

## What the controls do

- **Crop year** — which crop's bales to summarize.
- **Export buttons** — produce the same tables as the screen, formatted for sharing.

## How the numbers work

- Bales and lint pounds come from your gin receipts (Statements of Ginning), entered under Cotton.
- Grades come from the classing data you import on the Bales & Grades page — each bale's HVI results are matched to the bale by its PBI number.
- The **loan value** shown per field is the bale-weight-weighted average of each bale's classing loan value, in cents per pound — the same value that drives CCC loan figures.
- Grade distributions count bales in ranges: color grades as classed, staple under 34 / 34–36 / 37 and up, micronaire under 3.5 (discount) / 3.5–4.9 / over 4.9 (discount), strength under 28 / 28–30 / over 30.

## Common questions

- **Why do some bales show no grades?** Their classing data hasn't been imported yet, or the classing rows didn't match a bale by PBI number. Import the classing file on Bales & Grades and review any unmatched rows there.
- **Why don't my bale counts match the gin's total?** Check the gin receipt — the receipt review flags any difference between the gin's stated bale count and the bales actually captured.
- **Is this the same loan value as my CCC loan?** Yes — the per-bale classing loan value is the same number used to figure loan principal on the Cotton Marketing page.
- **I don't see this report at all.** The Cotton module may be turned off. An owner can turn it on under Settings → Organization.

## If something looks wrong

- If lint pounds look off, verify the bale list on the gin receipt for that field.
- If grades look off, re-check the classing import on Bales & Grades — unmatched rows are held there visibly for later.
- Anything else, contact support.

# Cash Flow Forecast  (page: /reports/cash-flow)

## What this page is for

The Cash Flow Forecast lays out, month by month, when money from the crop should actually arrive: what you have already been paid, what you are owed for grain delivered, what your contracts should bring as you deliver them, and the safety-net layer of ARC/PLC, crop insurance, and other USDA payments. It is the page for planning loan payments, input purchases, and conversations with your lender about timing.

## How to use it

The forecast opens on the current crop year; pick another year, a crop, a buyer, or an entity if you want a narrower view. The summary tiles total each category in whole dollars; a stacked bar per month shows received, outstanding, projected, and safety-net money at a glance; the monthly table underneath carries the same numbers with a running cumulative column; and the contract detail shows each contract's value, what has been received, what is outstanding, and what is still projected.

## What the controls do

- **Crop year** — frames the whole forecast, including which program year's ARC/PLC belongs in it. "All crop years" is available for a whole-book view but is never the default.
- **Entity filter** — narrows fields, production, and policies to the entity. Contracts held by your marketing agent, or with no entity, count toward each entity by its share of the crop's planted acres.
- **Tap any number to see where it comes from.** Every amount in the monthly table, the summary tiles, and the safety-net tiles opens a list of the lines behind it: the settlements (with buyer, contract, loads, and bushels) behind Received; the contracts with delivered-but-unsettled loads behind Outstanding; each contract's undelivered bushels, price, and how the delivery window spreads it across months behind Projected; the farm-and-commodity rows behind ARC/PLC; each policy behind Crop Insurance; each payment behind Other USDA; and the cotton and seed lines behind their columns. A month's total lists every kind together. Each line links to its record — the settlement, the contract, the report it came from — and the list totals to the number you tapped.
- **Export Excel / PDF / Print** — the monthly matrix, safety net, and contract detail together.

## How the numbers work

The three revenue columns split every contracted dollar by how certain it is:

- **Received** — cash already collected on settled loads, shown in the month of the settlement.
- **Outstanding** — grain delivered but not yet paid for, valued at the contract price, shown in the current month as money owed to you.
- **Projected** — contracted bushels not yet delivered, valued at the contract price and spread evenly across the remaining months of the contract's delivery window. A contract with no window shows in the current month. A contract marked complete — or fully delivered — projects nothing more, even if bushels remain on paper; it carries a "complete" badge.

The **Total Safety Net** adds program and insurance money with realistic timing. ARC/PLC for a program year is paid in October of the following year — so when you filter to a crop year, the ARC/PLC shown is the prior program year's payment arriving that October, and the card names the program year. Crop insurance is the projected indemnity, using the same per-practice yields and the current futures-based harvest price estimate as the Claims Monitor, so the two reports agree. Other USDA payments count in the month and year received.

When cotton is in the year, a **Cotton (net)** column and a cotton cash detail table appear: CCC loan money when bales enter loan, redemption payoffs and equity sale proceeds when loans resolve, pool payments on their dates plus each pool's estimated remaining value, priced contract proceeds spread across their delivery windows, on-call contracts valued at basis plus the current futures quote, LDP on its date, and fees as outflows.

When a **seed production contract** is in the year, a **Seed (net)** column and its own detail table appear: 80% of each priced portion in its election month (unpriced bushels assumed priced by the agreement's deadline), the final 20% plus premiums at the estimated final settlement, storage pay monthly, and the usage fee as an outflow. Payments you record on the contract replace the projection for their type.

## Common questions

- **Why is a month's projected revenue lower than I expected?** The contract's value is spread across every remaining month of its delivery window — one month carries only its share.
- **Why does my ARC/PLC payment seem to be for last year?** That is how the program works: a program year's payment arrives the October after it. The forecast puts the cash in the month it actually lands.
- **A number looks wrong — how do I check it?** Tap it. The list shows exactly which settlements, contracts, policies, or payments add up to it, with a link to each one.
- **How firm are these numbers?** Received is fact. Outstanding is owed. Projected and the safety net are estimates — final program and insurance amounts are set by RMA and FSA after harvest.

## If something looks wrong

If projected revenue is missing for a contract, check that it has a delivery window and is not marked complete. If received money is in the wrong month, check the settlement's date. If the insurance line seems off, review your policies and yields on the Claims Monitor, since this page uses the same estimate. Otherwise, contact support.

# Crop Budget Planner  (page: /reports/crop-budget)

## What this page is for

The Crop Budget Planner is a pre-season sandbox for the question "what should I plant next year?" You build one budget per budget crop year: for each crop, a grid of acres, yield, and cost — overall plus irrigated/dryland and full-season/double-crop rows — with a price for the budget year, and underneath it a price × yield matrix showing revenue or profit per acre across a range of outcomes. Nothing you do here touches your real marketing numbers, assumptions, or actuals — it is planning only.

## How to use it

Pick the budget year in the header. Each crop you planted this year appears with a starting point already filled in: yields seeded from your APH (per practice, where your policies have it), costs from this year's cost assumptions, and price from the live budget-year new-crop futures quote. Type over any of it — the seeded values are a starting point, not a verdict. Add a crop you did not plant this year with **Add crop**; take one out with **Remove from budget**. The summary band totals the whole plan so you can compare crop mixes at the operation level.

## What the controls do

- **Budget year selector** — each budget year keeps its own budget; switch years to work on a different plan.
- **⚙ Assumptions** — the editing panel, one collapsible section per crop, with the acres/yield/cost grid. A blank breakout cell falls back to the crop's Overall row, the same convention as the Marketing Dashboard.
- **Price, edit-in-place** — each crop's price defaults to the live budget-year futures quote (marked "live" with its quote date). Typing over it switches the crop to a manual price; the ↻ button restores the live quote. Basis is its own field alongside.
- **Blended | Broken out** — Broken out shows one output section per breakout row (irrigated, dryland, and so on); Blended shows one acre-weighted section per crop.
- **Revenue | Profit** — what the matrix cells show.
- **Export Excel / PDF / Print** — the budget with the budget year, view, and quote date in the filter line.

## How the numbers work

Each row's math is straightforward: (price + basis) × yield − cost per acre, times acres for totals. Breakevens show the price or the yield at which the row covers its cost. The matrix repeats that calculation across a spread of prices and yields around your inputs, so you can see how much room a plan has before it goes under water.

Seeded values show where they came from until you edit them — APH for yields, this year's costs, the live quote for price. Once you type a number, it is yours and stays.

## Common questions

- **Does this change my real numbers?** No. The planner never writes to your marketing assumptions, contracts, or production records. It is a separate scratch pad per budget year.
- **Can I compare different plans?** Each budget year holds one budget. To compare crop mixes, adjust the acres between crops and watch the summary band, or export a copy before changing course.
- **Why is a crop's price marked manual?** You typed over the live quote. Press ↻ next to the price to go back to the live futures value.
- **Where do the starting yields come from?** Your APH by practice where your insurance records have it, otherwise your expected-yield breakouts. Double-crop rows seed from double-crop figures.

## If something looks wrong

If a crop shows no price, its budget-year futures quote was not available — type a price in the Assumptions panel, and the ↻ will pick the quote back up when it can. If seeded yields look off, check your APH entries under crop insurance and your expected yields on the Marketing Dashboard, since the seeds come from there. Otherwise, contact support.

# Crop Insurance Production Report  (page: /reports/crop-insurance)

## What this page is for

This report lays out your production the way your crop insurance agent needs it: by county and by practice (irrigated vs dryland). When it's time to certify production after harvest, you can hand your agent this one report instead of digging through load tickets. It shows certified acres, total production, and yield per acre for every crop, split by county and practice.

## How to use it

- The report opens on the current crop year (or the newest year with plantings the first time). Pick another **crop year** at any time — your pick is remembered.
- Narrow by **entity** if different entities carry different policies.
- Use the **crop chips** to include only certain crops. Leaving them all off means every crop shows. The chips only offer crops you actually planted in the selected year and entity.
- Export with the **Excel**, **PDF**, or **Print** buttons at the top right. They appear once the report can be generated — a year picked, no fields waiting on a breakout, and at least one sheet. The export mirrors what's on screen in the three metric groups — Certified Acres, Production, and Yield/Acre — using the wording your agent's form expects ("Bu. Or Lbs."); on screen each crop's column simply says **bu** or **lbs**.

## What the controls do

- **Crop year** — the harvest year you're reporting.
- **Entity** — limits the report to farms owned by one entity.
- **Crop filter chips** — toggle crops in or out. This also affects which fields can hold up the report: filtering to corn means a soybean field that still needs attention won't block your corn report.
- **Enter breakouts on Yields** — a shortcut to the Yields page when the report asks you to split a field's production between irrigated and dryland acres.

## How the numbers work

- Production comes from your recorded loads, with split loads credited to the right fields.
- A field planted **part irrigated and part dryland** needs its production divided between the two practices before it can appear here, because insurance treats the practices separately. The report will list the fields that need this and pause until you either enter the breakout on the Yields page or choose to count the whole field as dryland. Mixed fields still being harvested are listed separately and never block the report — if one of them is actually finished, tap **Count anyway** next to it to treat its bushels as final.
- That question is only asked **once a field's harvest is complete**. Fields still being harvested are left out entirely and noted, so a half-picked field never shows a misleading yield.
- Yield per acre is production divided by certified acres for each county and practice combination.

## Common questions

- **Why is a field missing?** Its harvest probably isn't complete yet. Fields with recent load activity, or no loads at all, are excluded until harvest wraps up. If a field is truly done but still excluded, mark it on the Yields page.
- **Why is the report blocked?** One or more mixed-practice fields finished harvest without a production breakout. Enter the irrigated/dryland split on the Yields page, or accept the option to roll it into dryland.
- **Can I report one crop at a time?** Yes — use the crop chips. Only the selected crops (and their fields) count.
- **Does the export match the screen?** Yes. Every column and metric group on screen appears in the Excel and PDF versions.

## If something looks wrong

- If acres look off, check the field's total and irrigated acres under Settings, and the planting's acres for that year.
- If production looks low, make sure all loads for the field are entered and any split loads are allocated correctly.
- If a county is missing, confirm the field is assigned to a county in Settings.
- If none of that explains it, contact support.

# Grain Dryer Math  (page: /reports/dryer-math)

## What this page is for

What it costs to take a point of moisture out — and what it costs to take out one too many. Three inputs and the table answers: **Crop · Fuel · Fuel price**. The table is two columns — **Moisture** and **Total drying cost per bushel** — for every incoming moisture from bone-dry to 28%. Above base, the total is fuel, fan power, and dryer depreciation. Rows below base show the price of overdrying in red. It's a calculator, not a record book: nothing here tracks loads.

## Setting it up

- **Crop** — sets the base moisture from the crop's own standard (the same base the rest of Turnrow shrinks to).
- **Fuel** — propane or natural gas, with its price. If a saved dryer is selected, its fuel applies automatically.
- **Fuel price and its unit** — type the price and pick the unit beside it: **$/gal** for propane, **$/ccf** for natural gas, or **$/MMBtu** (per million BTU — how many suppliers and utilities quote). A price entered per MMBtu is converted once, using the standard heat contents (91,500 BTU per gallon of propane, 1,020 BTU per cubic foot of natural gas — so 1 MMBtu is 10.93 gallons of propane or 9.80 ccf of gas), and a line under the input shows the equivalent per-gallon or per-ccf figure. The table, the dry-it-or-haul-it comparison, and the calibration all price the same whichever unit you typed. Your choice of unit and the prices you enter are remembered on this device.
- Everything else lives under **⚙ Assumptions**: your dryer (a saved one, a catalog model, or a standard 0.018 gal-LP-equivalent per bushel-point), the electric rate, the **depreciation** figure, the calibrate-from-records tool, and the grain price. The grain price matters for the rows *below* base (overdrying) and for the buyer comparison — it defaults to today's futures quote for the crop's reference contract, and you can type over it any time. The line under the inputs always says which dryer, depreciation figure, and grain price are in play.

## Reading the table

- **Rows above base** are incoming wet grain dried to base. The single figure is the **total drying cost** per bushel: fuel + fan electricity + depreciation. Hover a figure and it shows the breakdown.
- **The base row** is the stop line.
- **Rows below base** are the price of **overdrying**: every half-point past base gives away sellable grain *and* burns fuel removing water nobody pays for. These are the only rows that need a grain price. Hover the red figure for the split.

## Dryer depreciation

A dryer costs money to own, and that cost belongs in the price of drying: **≈ dryer investment ÷ useful life ÷ bushels dried per year** — for example $300,000 ÷ 15 years ÷ 500,000 bushels ≈ 4¢ a bushel, which is the starting figure. It's applied **flat to every bushel that goes through the dryer**, not per point: a bushel that lost two points and one that lost ten carry the same 4¢. Under ⚙ Assumptions you can type your own figure or fill in the three numbers and let the page work it out. Want full ownership costing? Raise the figure to fold in repairs and interest. The figure saves for your operation.

## Why shrink isn't a drying cost

The water above base moisture is unsellable either way. Haul it to town wet and the buyer's shrink table takes it off the ticket. Dry it yourself and it goes up the stack. You end up with the same dry bushels in both cases, so drying didn't cost you that weight — it was never yours to sell. What drying *does* cost you is the fuel, the fan, and the dryer. Below base it's a different story: that weight is real grain you could have sold, which is why the overdrying rows count it.

## Dry it or haul it wet

An optional comparison at the bottom (collapsed until you open it): pick a buyer whose discount schedule is on file and every wet row shows what hauling it wet costs by their sheet beside your drying cost, with the call — *Dry it* or *Haul it wet* — and the savings.

**How the elevator treats wet grain.** It's two steps, and both cost you. First the elevator **shrinks your bushels** to base at *its* shrink factor — 1.4% per point is typical. Part of that is water that's gone whether you or they dry it (about 1.183% per point), so that part is on nobody's side of the comparison. Everything above it is sellable grain they keep, and it's valued at the grain price. Then they **charge to dry what's left** — so many cents per point, or a percent of the price per point. The "haul it wet" figure is those two added together, and each row shows the split: *17.5¢ charge + 4.6¢ excess shrink*. Some sheets print one bundled percent-of-price discount per point with no shrink line; that discount already includes the shrink, so it's applied alone and labeled *bundled*.

The comparison needs a **grain price** (it values the grain the elevator keeps) — the one under ⚙ Assumptions, defaulted from the live quote. A line under the buyer picker shows the sheet's terms: base, shrink factor, and charge. If the sheet on file doesn't state a shrink factor, 1.4% stands in and the line says *assumed — verify against the schedule*; type the printed factor on the schedule row under Settings → Buyers and the comparison uses it.

**Depreciation in the comparison** is a checkbox there, on by default. If you own the dryer, its depreciation is spent whether or not this particular load runs through it — so for the marginal call on one load you may prefer to untick it and compare fuel and fan alone. Left on, the comparison prices your full cost of drying. Schedules live with the buyer under Settings → Buyers; you can also upload one right there in the section. Ask Turnrow can quote the same schedules in plain words.

## Calibrating from your records

The honest consumption number is yours, not a brochure's: in ⚙ Assumptions, enter last season's total gallons (or ccf), bushels dried, and average points removed, and the page computes **your** fuel per bushel-point — then offers to save it to the selected dryer. One season of records beats any preset.

## Common questions

- **Where did the fuel and per-point columns go?** Into the hover on each total and the note under the table. The table itself is two columns so it reads at a glance.
- **Where do the catalog numbers come from?** Typical figures by dryer type (cross-flow, mixed-flow, tower, heat recovery). They're starting points, labeled as such — calibrate with your records.
- **Why does hauling wet sometimes win?** A buyer's charge plus the grain they keep can still come in under your cost — a cheap sheet with a lean shrink factor, or a point or two of moisture. The comparison uses their posted sheet — and whether depreciation is in your side is your choice.
- **The comparison used to favor hauling wet a lot more. What changed?** It counted only the buyer's drying charge and ignored the bushels their shrink factor takes beyond the water. Now it counts both, the way the elevator does.
- **Is depreciation charged on the overdrying rows too?** No. Those rows are the extra cost of going past base — lost grain and wasted fuel. The bushel already carried its depreciation reaching base.
- **My gas bill is in therms or dekatherms.** A therm is 100,000 BTU, so $/MMBtu = $/therm × 10; a dekatherm is one MMBtu, so enter that price as-is under $/MMBtu.
- **Does this change any of my data?** No. Only saved dryers, a calibration you choose to save, and the depreciation setting persist — the rest is session inputs kept on this device.

## If something looks wrong

- The rows below base say to enter a grain price: there's no live quote — enter one under ⚙ Assumptions. The rows above base don't need it.
- No buyers in the compare list: no discount schedule on file for this crop yet — upload one in the comparison section or on Settings → Buyers.
- The buyer column says *needs grain price*: enter one under ⚙ Assumptions — the comparison can't value the shrink without it.
- The sheet line is amber, *assumed — verify against the schedule*: the schedule on file has no shrink factor. Check the printed sheet and type the factor on the schedule row under Settings → Buyers.
- The depreciation box is greyed out and won't save: a database update is needed — contact support. The table still uses the 4¢ default.
- Numbers that don't square with your fuel bills: calibrate from records; the presets are estimates. Still off after that: contact support.

# Freight Math  (page: /reports/freight-math)

## What this page is for

What a haul really costs — and the number that settles picked-up vs delivered decisions. Put in diesel, labor, and miles, and the page answers instantly: the cost of the trip itemized (fuel, labor, wear) and totaled per load, the cost per bushel, and the decision line — **how much more a delivered contract must pay than a picked-up one to cover the haul**. Below the answer, two tables: **every saved destination costed with its own miles and wait time**, and the same math at 10/25/50/75/100 miles for quick scanning.

## Setting it up

- **Diesel $/gal · Labor $/hr · Miles (one-way)** — the three inputs. That's the whole main screen.
- **Crop** — sets the payload per load from the crop's test weight (corn about 950 bushels, soybeans and wheat about 880). Override it under ⚙ Assumptions if your trucks run different.
- **Destination** — optional: the picker lists your delivery locations grouped by buyer, each showing the saved miles from your bin site (choose which bin site when you have several). Pick one and the miles fill in — and if that location has its own wait time, the cost uses it. A location with no miles yet says so — type them under ⚙ Assumptions.
- **⚙ Assumptions** — truck mpg (6.0 loaded/empty average), average speed (45 mph), the default load/unload and wait time (0.75 hr), wear and repairs ($0.20/mi), the payload override, and the distances table with a wait time per location. All editable, saved for your operation.

## What the breakeven means

If hauling to town costs 9¢ a bushel, a delivered bid has to beat the picked-up bid by MORE than 9¢ before delivering is the better deal — otherwise you're hauling for free. The line uses **operating costs only** (fuel, labor, wear): for deciding *where* to haul, that's the right basis, because depreciation and insurance cost you the same whether the truck rolls or not. An "include ownership costs" toggle is there if you want the fully-loaded figure.

The **custom-rate equivalent** ($ per loaded mile) is a sanity check: if a hired hauler quotes less than your own number, let them haul it.

## Cost by destination

The first table under the answer lists your saved destinations, grouped by buyer, each costed at today's diesel and labor with **its own miles** (from the bin site you picked) and **its own wait time**: Miles · Wait · Cost/load · ¢/bu. The destination you picked is highlighted. A location with no miles on file shows greyed with a *set distance* link to the assumptions panel. Sitting an extra hour at a slow house at $25/hr labor is about 2¢ a bushel on a corn load — this table is where that shows up side by side.

## Wait times per location

Elevator lines vary wildly, and everyone knows which houses make you sit. The default load/unload + wait time (0.75 hr per trip) covers a normal stop; in the distances table under ⚙ Assumptions, the **Wait** column beside each location's miles lets you set that house's own hours. Leave it blank and the default applies (shown greyed in the box). Type 1.5 for the one that always backs up and every figure for that destination — the main screen when it's picked, its row in the cost-by-destination table — uses 1.5. Each entry saves as soon as you leave the box.

## Destination distances

- The table under ⚙ Assumptions is organized the way Settings → Buyers is: each **buyer** is a heading, its **delivery locations** sit beneath it, and every location has a miles box for each of your bin sites plus its wait box.
- **Type the miles you know.** Each number saves as soon as you leave the box and is marked *yours*. No address is needed — a location without an address still gets its row, with a note that typing is the way to fill it. Your number is never changed by anything else on the page.
- **Estimate missing distances (AI)** is optional. It looks up the coordinates of bin sites and delivery locations that have addresses, estimates road miles (straight-line distance plus a quarter for real roads), and shows them for review before anything is saved. It fills **only the blanks** — it never touches a number that's already there, yours or an earlier estimate. Estimates are always labeled *estimate*; type over one and it becomes yours.

## Common questions

- **Why doesn't the per-bushel number show for cotton?** Cotton hauls in pounds on module trucks, not a bushel payload — the per-load cost still works.
- **Should I include ownership costs?** For where-to-haul decisions, no — they don't change with the trip. For setting a full custom rate to charge someone else, yes.
- **The estimated miles look off.** They're straight-line × 1.25 — river crossings and detours can beat the factor. Type the real miles over it; your number sticks.
- **A location isn't in the estimate.** It has no address on file. Type its miles directly — that's all it needs.
- **I typed miles by hand — which wait time applies?** The default. A location's own wait time only applies when that destination is picked; typing miles clears the pick.
- **Does the export include the destination table?** Yes — both tables, with the wait hours each row was costed at.

## If something looks wrong

- No destinations in the picker or the destination table: add buyers and their delivery locations under Settings → Buyers.
- No miles boxes in the table: add a bin site under Settings → Bin Sites — distances are measured from there.
- The estimate finds nothing to do: every pair already has miles, or the locations have no addresses. Type the ones you need.
- The Wait boxes are greyed out and won't take a number: a database update is needed — contact support.
- Anything else: contact support.

# Government Payment Tracker  (page: /reports/government-payments)

## What this page is for

The Payment Tracker projects your ARC/PLC and other USDA payments, shows when the money actually arrives, and tracks each entity against its FSA payment limit. It answers three questions: how much is coming, when does it land, and does any entity bump its limit.

## How to use it

- Pick a year. The **By Entity × Crop matrix** at the top shows each entity's projected payments per commodity, plus other USDA payments, with totals that reconcile in the corner.
- Below, each farm's breakdown shows the commodity, election, and projected payment, with a drill-down into the drivers.
- Check the **Payment Limit Status** table to see each entity's persons-times-limit cap and where the projections stand against it.
- Review the **MYA Prices panel** — every projection rides on these prices, and you control where they come from.
- Export to **Excel** or **PDF**; the export includes the matrix, the election column, and the payment limit table.

## What the controls do

- **Year basis toggle** — the default **"By payment year"** view answers "what cash arrives in year Y": ARC/PLC for program year Y−1 (which pays the following October) plus other payments received in Y. Switch to **"By program year"** to line up with FSA paperwork instead. The year you picked stays put when you switch; only the label and the framing change, and the line under the toggle says which framing you are looking at.
- **Check your setup** — when something is off in your setup (benchmarks entered under another program year, older payment entries whose year needs a look, a missing program parameter), the notices fold into one **Check your setup (N)** panel under the filters. Tap it to read them.
- **MYA Prices panel** — per commodity: an Auto/Manual toggle, inline manual entry, and a **Look up USDA prices** button that pulls real published monthly prices received by farmers. Fetched months appear beside anything you've already entered; nothing you typed is overwritten without your confirmation. A published final price locks the row. If the lookup finds nothing, an AI lookup is offered as a clearly labeled fallback.
- **ARC-CO settings** button — jumps to Settings, Government Payments with the right program year already selected.

## How the numbers work

- **Timing**: ARC/PLC for a program year is paid in October of the following year. That one rule drives the whole payment-year view — program year 2025's payment shows as 2026 cash.
- **PLC** pays the gap between the effective reference price and the MYA; **ARC-CO** pays on county revenue against its benchmark guarantee — the same math as the Decision Aid, so the two pages agree.
- **Payment limits**: each entity's cap is its number of FSA-eligible persons (set once in Settings, Entities) times the program year's per-person limit. The status table shows the multiplication and colors entities approaching or over their cap.
- **Seed cotton** is one commodity with one price: the lookup fetches the lint price (cents per pound) and the cottonseed price (dollars per ton) and blends them at configurable shares, showing you the composition before you confirm.
- Payments tied to a farm roll up through the farm's entity; other payments attribute to their entity, with a "no entity" row so the totals always reconcile.

## Common questions

- **Why do the two year views show different totals?** They frame the same payments differently — cash-arrival year vs FSA program year. Use payment year for cash planning, program year for FSA reconciliation.
- **Why did a projection change?** MYA prices update as months publish and as futures move; a confirmed final locks it down.
- **What's the amber note on an old entry?** An other-payment entry looks like it was recorded under the old year convention — open it and confirm its dates.

## If something looks wrong

- A benchmark-year notice in **Check your setup** means ARC-CO benchmarks exist only for other years — the notice links to Settings preset to the right year. A **flat estimate** chip on a farm's row means the same thing for that county; tap the chip for the explanation.
- If an entity's limit looks wrong, check its eligible-persons count in Settings, Entities and the per-person limit in Program Parameters.
- Anything else, contact support.

# Hedging Summary  (page: /reports/hedging-summary)

## What this page is for

The Hedging Summary gathers every futures and options position — open and closed — into one report, summarized by crop year and commodity with realized and unrealized profit and loss. It is written to be lender-ready: the export is the clean statement of your hedge book a banker or business partner expects, without them needing to know your trading platform.

## How to use it

The report opens on the current crop year (or the year you last picked); narrow to a commodity if you want. The summary table shows each crop year × commodity combination with total contracts, quantity (bushels, or pounds for cotton), average hedge price, unrealized gain or loss on open futures, realized gain or loss net of commission on closed ones, options gain or loss, and the combined figure. The positions table below lists every position, named in plain words — "Dec 26 Corn" — with the exchange symbol beside it, plus side, quantity, prices, and its own result. Date filters let you cut the report to a statement period. Every filter is remembered between visits.

## What the controls do

- **Crop year** — which marketing year's positions to show; each position is tagged to the crop year it hedges. "All crop years" is available for the whole book.
- **Commodity** — narrow to corn, soybeans, wheat, cotton, and so on.
- **Entity** — positions in an entity's own name count wholly toward it; positions held by your marketing agent or entered without an entity are hedging for the whole operation.
- **From date / To date** — filter positions by trade date, or close date for closed positions. The activity section uses each event's trade date.
- **Export Excel / PDF / Print** — the summary and full position detail with your filters named, plus the activity sheet.

## Hedging activity

Below the positions, **Hedging Activity** is the account's full record for the period: every open, close, roll, edit, crop-year change, and statement import, newest first, in the same plain lines the Hedging page's History shows. Tap a line for the detail. The export adds it as its own sheet — one row per event in date order, with the entry and close prices, realized result, fees, crop year, entity, where it came from (which statement, or entered by hand), when it was recorded and by whom, and what an edit changed — so a lender or partner gets an auditable history from the same report that summarizes the book. Read-only users see the positions but not the activity record.

## How the numbers work

- **Unrealized P&L** applies to open futures positions: the move from your trade price to the most recent market price, times contracts, times the contract size. It changes as the market does.
- **Realized P&L** applies to closed positions: the booked gain or loss, minus commission. It is final.
- **Average hedge price** is the contract-weighted average trade price of the futures positions in the row.
- **Options** show unrealized value only when you have entered a current value on the position — there is no live options quote here — while closed options report their booked result.
- Quantities and prices stay in each commodity's own units: bushels and dollars per bushel for grain, pounds and cents per pound for cotton.
- The summary's net P&L per row is futures unrealized + futures realized + options, so the pieces always reconcile to the total.

For **read-only users**, positions held by the marketing agent or without an entity are shown scaled to the granted entities' share of planted acres — so contract counts can show fractions and bushels can be partial. The prices are untouched; only the size of the slice changes.

## Common questions

- **Why did unrealized P&L change since yesterday?** It is marked to the latest market price. Only closed positions are locked.
- **Why does an option show no unrealized value?** No current value has been entered for it. Enter one on the Hedging page and it will appear here.
- **Why do I see 1.6 contracts?** You are viewing as a read-only user with an entity share — operation-level positions are split by acre share, and fractions are the honest way to show your portion.
- **Does this include the hedge gains already counted in my average price?** The Marketing Dashboard folds realized hedge P&L into its price buildup; this page is the position-level view of the same money. Use this one for the hedge book, that one for the blended price.

## If something looks wrong

If a position is missing, check its crop year tag on the Hedging page — a mistagged year moves it to a different summary row. If unrealized P&L looks stale, the market quote may not have refreshed recently; check back, and if it stays frozen, contact support.

# Income Sensitivity  (page: /reports/income-sensitivity)

## What this page is for

Income Sensitivity answers "what happens to my income if prices or yields move?" Each crop gets a table with futures prices down the side and yields across the top; every cell is your revenue or net profit per acre in that scenario, with your locked contracts, crop insurance, and (optionally) government payments all baked in. It shows how well your marketing and insurance protect you before the season plays out.

## How to use it

The report opens on the current crop year (or the year you last picked); scroll to a crop. The row and column closest to today's futures price and your expected yield are highlighted — that cell is "you are here." Read down for cheaper prices, left for lower yields, and watch where insurance kicks in to flatten the damage. A badge above each table says how many bushels are contracted at locked prices, or that the crop is fully price-sensitive.

## What the controls do

- **Revenue/acre | Net profit/acre** — switches what the cells show; profit subtracts your cost per acre from the Marketing assumptions.
- **Price and yield axis controls** — set the center, step, and number of steps for each axis of each crop; leave them blank for automatic values centered on your current assumptions — the assumed futures price from your marketing assumptions (falling back to today's price, then your policies' projected price) and your expected yield. An entry that does not parse reverts to the previous value.
- **Include government payments** — adds the payments expected to arrive during the crop year (the prior program year's ARC/PLC paid that fall, plus other USDA payments) as one flat dollars-per-acre amount, identical for every crop and constant across cells.
- **County yield toggle** — see below.
- **Entity filter** — narrows acres, positions, and policies; agent-held or whole-operation contracts count toward each entity by its share of the crop's planted acres.
- **Export Excel / PDF / Print** — the tables with the price axis as the first column and your active toggles noted.

## How the numbers work

- **Contracted bushels stay locked.** Cash contracts keep their cash price, HTA and basis contracts their locked legs, open hedges their trade price, realized gains counted once. The scenario price applies only to unpriced bushels, plus your assumed basis. If scenario production falls below contracted bushels, revenue is capped at production.
- **Seed contracts** follow the same rule: elected portions stay locked at their elected price, the unpriced committed share moves with the scenario price, and premiums hold at the contract's expected-outcome assumption.
- **Harvested bushels are facts.** The yield axis applies only to unharvested acres. Mid-harvest, the header shows what is already in the bin; a fully harvested crop collapses to a single actual-yield column, leaving only price risk.
- **Insurance re-runs in every cell.** Each RP, RP-HPE, and YP policy — with SCO and ECO, per irrigated/dryland practice — recomputes with the scenario price as the harvest price, shown net of premium. Once the RMA final harvest price is on file, it is used instead in every cell.
- **County yield modes.** County-based coverage (SCO, ECO, STAX, ARP, AYP, MCO) needs a county yield, estimated from your "my yield vs county" differential. **County independent** (the default) holds the county constant while your farm yield moves — a local loss the county may not share, exposing the gap where county products might not pay when you have a loss. **County moves with me** models a widespread loss: the county falls with your yield, keeping your usual relationship to it, so area coverage triggers alongside your own policies. Once the RMA final county yield is published, both modes pin to it.
- **Cotton** tables run in cents per pound (the futures convention) and pounds of lint per acre; sold and pool pounds stay locked, and in-loan pounds never fall below the banked CCC loan value.

## Common questions

- **Why doesn't the yield axis change one of my crops?** It is fully harvested — yield is settled and only price still matters.
- **Why does insurance ignore the price axis?** The RMA final harvest price is on file, so the price axis moves crop sales only.

## If something looks wrong

Check the crop's yield, cost, and basis assumptions on the Marketing Dashboard first — every cell builds on them. If county-based coverage looks off, review your county differential on the Claims Monitor. Otherwise, contact support.

# Crop Insurance Claims Monitor  (page: /reports/crop-insurance-claims)

## What this page is for

The Claims Monitor estimates what each of your crop insurance policies would pay if the year ended today. It runs every policy — RP, RP-HPE, and YP, plus SCO, ECO, STAX, and MCO endorsements and ARP/AYP county policies — against your current yields and the running harvest price, and shows the estimated indemnity net of your premium. Use it during and after harvest to see whether a claim is shaping up, before your adjuster ever shows up.

## How to use it

- Pick a **crop year**. Every policy for that year appears, with irrigated and dryland as separate rows and a subtotal per crop.
- Review the estimated indemnity for each policy and endorsement. Green means a payment is estimated; the summary cards total everything up.
- Set your **"My yield vs county"** number for each crop and county (see below) so the county-based endorsements estimate realistically.
- For "what would happen if prices or yields moved" questions, follow the link to the **Income Sensitivity Report** — this page deliberately has no what-if controls.
- The **Coverage Check** link takes you to Settings to confirm your insured acres match your planted acres.

## What the controls do

- **Crop year / entity filters** — narrow which policies you're watching.
- **My yield vs county** — one control per crop and county. You enter how much your own yields typically run above (or below) the county average, in bushels per acre (pounds per acre for cotton). The estimated county yield is your expected or actual yield minus that differential, and the derivation is shown right on the control. This drives every county-triggered piece: SCO, ECO, STAX, MCO, ARP, and AYP. It is separate from the ARC-CO expectation used on the government payment pages.

## How the numbers work

- **Everything here is an estimate.** The banner at the top says so: figures are based on current yield assumptions and futures prices, and final amounts are determined by RMA after harvest.
- **Yields**: once a practice is harvested, the actual irrigated or dryland yield is used. Before that, your expected yield breakout from the Marketing page fills in, so irrigated and dryland can differ even pre-harvest.
- **Harvest price**: a colored chip beside every price says exactly where it came from — the same chips as the Price Discovery table in Settings — and a small ↻ pulls the latest from RMA for that crop without touching anything else. Overrides live in Settings (the "Price details & overrides" link); the label beside the price says exactly where it came from, and it upgrades as the season progresses — a futures estimate (est.) before the discovery window opens, RMA's own running average once the window is live (RMA discovery, with the day of the window), and (RMA final) the moment RMA publishes. A price you entered by hand shows (final); if RMA later publishes a different final, a notice shows both numbers and lets you keep yours — nothing is replaced silently.
- **County pieces**: SCO, ECO, STAX, MCO, ARP, and AYP pay based on estimated county results, not your farm's. ARP and AYP rows are labeled "county-triggered — farm yield not used" because your own yield genuinely does not matter to them.
- Indemnities are shown net of premium, so the number is what you'd actually expect to collect.
- **Stacking warnings** appear when endorsement combinations need agent review (for example ECO alongside STAX). These are warnings only — your agent is the authority.

## Common questions

- **Why does my SCO show a payment when my crop is fine?** County endorsements pay on the county, not on you. Check your "my yield vs county" differential — if it's blank or stale, the county estimate may be off.
- **Why did the numbers change since yesterday?** Before the discovery window the harvest price tracks the live futures market; during the window it follows RMA's running average, which updates daily; after RMA publishes, it stops moving.
- **Can I test other prices or yields?** Yes — on the Income Sensitivity Report, linked at the top.

## If something looks wrong

- An implausibly huge cotton indemnity usually means a price was entered in cents per pound where dollars per pound belong — review the policy's projected and harvest prices under Settings, Crop Insurance.
- If a policy is missing, confirm it's entered for this crop year and assigned to the right entity.
- Otherwise, contact support.

# Marketing Dashboard  (page: /reports/marketing)

## What this page is for

The Marketing Dashboard shows where you stand on selling each crop for a crop year. Every crop gets its own full-width section: production, acres, yield, the average price built from futures and basis, profit per acre, and total profit, with position bars underneath showing how much is sold or priced and how much is still open. It is the page to check before making the next sale.

## How to use it

The dashboard opens on the current crop year (or the year you last picked). Scroll through the crop sections; the bar at the bottom of each section expands a detail view that reads like a statement: the futures price buildup source by source, the basis buildup, and profitability side by side. Enter your yield and cost assumptions once through **Edit Assumptions**; use the **Assumed price for unpriced bushels** block to value your unpriced bushels at a futures price and basis you choose.

## What the controls do

- **Crop year and entity filter** — the crop year list always includes this year and the next two, plus any year you already have plantings, contracts, hedges, or assumptions for — so next year's marketing has a place to live before anything is planted. The entity filter narrows acres and production to that entity. Contracts and hedges held by your marketing agent — or entered with no entity — are marketing for the whole operation, so they count toward each entity in proportion to its share of that crop's planted acres. A contract in an entity's own name counts wholly toward it.
- **Edit Assumptions** — a panel with one section per crop: enter an overall yield and cost per acre, or break them out by irrigated/dryland and full-season/double-crop. A blank breakout cell falls back to the overall figure. The **Harvest complete** checkbox tells Turnrow the crop is finished; checking it snaps the yield to the actual average from your loads.
- **Cotton in bales** — a cotton section quotes production in bales beside pounds of lint: pounds ÷ an assumed bale weight, 500 lb unless you change it. The **lb** box next to the bale count is that assumption (per crop and crop year); type a different weight and the count follows, or clear it to go back to 500. Once gin receipts exist the actual ginned bale count shows alongside.
- **Assumed acres (planning a year before planting)** — for a crop year with no plantings yet, each crop's section in the panel takes **assumed acres** instead: an overall figure, or split by irrigated/dryland like the yield. The Double-crop rows appear only for a crop designated Double-crop under Settings → Crops (soybeans after wheat); every other crop shows just Irrigated and Dryland. If you later change a crop's designation, acres already entered in a Double-crop row are not lost — a note says so and offers to clear them. Enter the acres and the expected yield and the dashboard values the year's contracts and hedges against that expected production — 2027 wheat you've already sold ahead, 2028 corn you've hedged. Crops with no acres assumed stay off the dashboard. The moment the first field is planted to a crop for that year, the **planted acres take over automatically** and the assumed figure is ignored (the panel then reads "using planted acres"). Assumed acres are for the whole operation, so they show under **All entities**; an entity filter still goes by the fields actually planted.
- **Assumed price for unpriced bushels** — type an assumed futures price (or use the **Use today's price** button, which fills in the current quote for the reference contract shown) and an assumed basis. The headline numbers preview your typed figures right away, but nothing is kept until you press **Save**. Once saved, these are standing assumptions: they stay until you change them and are used on Revenue Projections and Income Sensitivity too — the block says so, so a saved number never quietly re-prices another report. **Clear** wipes both. When a contract has no live quote — cotton always, since the live feed doesn't cover it — the reference line offers **enter price**: type the settlement once and every screen uses it, marked with an amber **manual · date** chip so it is never mistaken for market data (see Hedging → "When a price says manual").
- **The reference contract** — shown next to the futures input as the board month and its live quote (for example "ZWU26 · $5.72"). This is the futures contract your unpriced bushels are valued against. The default is the crop year's new-crop month — December corn and cotton, November soybeans, July wheat — and once that contract stops trading (around the middle of its delivery month), Turnrow automatically moves to the next traded month and shows a small note like "Jul 26 expired → Sep 26". You can also pick a different month from the dropdown — any traded month from this crop year through the next — and your choice sticks for that crop and year until you press **Reset to default**. The Income Sensitivity price axis and Revenue Projections follow the same contract, so every page prices unpriced bushels off one answer.
- **Physical Sales Complete for the Year?** — checkboxes at the bottom, one per crop. Because shrink and small leftovers keep the math from ever landing on exactly zero, this is how you tell Turnrow a year's selling is truly finished.
- **Export Excel / PDF / Print** — the full dashboard, formatted for handing to a lender.

## How the numbers work

Production is your assumed acres × yield until you mark harvest complete; after that it is the actual bushels from your loads (pounds of lint from gin receipts for cotton). Turnrow also switches to actuals on its own once every field of a crop is harvested. If a crop hasn't switched because a field still shows as being harvested, an amber note at the top names the field — tap **Count anyway** there if it's actually done, and its bushels count as final everywhere. Every bushel is valued at its own price: cash sales at their cash price, HTA and basis contracts at their locked legs, hedged bushels at their trade price with realized futures and options gains counted once, and unpriced bushels at your assumed futures plus assumed basis (or, with no assumption entered, the reference contract's current quote). Basis totals show their state — actual where locked, assumed where not, and a blend when it is some of each.

An amber **includes assumptions** marker appears whenever any production is not fully priced; tap it to see how many bushels ride on assumed futures or basis. A crop running on assumed acres carries an **acres assumed — no plantings yet** badge and an "assumed" chip on its acres (tap either for the explanation), and the export labels the line "Assumed acres (no plantings yet)". A blended basis figure has a **blended** chip you can tap to see the locked and assumed portions. Revenue Projections, Income Sensitivity, and Cash Flow use the same acres, so the whole set of reports works for a future year. Profit is this blended revenue minus your cost per acre, and it matches Revenue Projections to the cent. Breakeven price is cost divided by yield; breakeven yield is cost divided by average price.

Cotton sections work in pounds and cents per pound, with a position bar covering sold, pool, in-loan, hedged, and unpriced lint.

A crop with a **seed production contract** shows a "Seed — [company]" tag and its own segments in the position bar: the linked seed fields' bushels count as committed, elected portions hold their elected price plus the expected premiums, and the unpriced share is valued at the reference price (marked "seed est."). Premiums stay assumptions until the seed company accepts the crop — the contract's expected-outcome setting drives them.

## Common questions

- **Why did my average price move when I typed an assumed price?** The headline previews the number you typed on the unpriced bushels — that is the point. It is only kept, and only reaches the other reports, once you press Save. Clear it to see locked pricing only.
- **I'm a read-only user — can I try my own numbers?** Yes. Your edits are private "your scenario" values only you see, marked with a chip (assumed acres included). If an administrator later changes the official assumption, your scenario value is replaced and a notice tells you.
- **I picked next year and the page says there are no plantings yet.** That's expected before planting — open **Edit Assumptions**, give each crop you plan to grow its assumed acres and expected yield, and the dashboard fills in with the contracts and hedges already on file for that year.
- **I entered assumed acres but the dashboard shows a different number.** Fields have been planted to that crop for the year, and planted acres always win. Check Settings → Plantings; the assumptions panel names the planted total it is using.

## Cost per acre from Turnrow Farm

When the cost per acre for a crop came from Turnrow Farm, the assumptions box says "Cost/ac from Turnrow Farm, updated (date)" with a **Use my own costs** switch that keeps whatever you type. If that cost already includes the crop insurance premium, the same line adds "Insurance included in the Turnrow Farm cost per acre" — Revenue Projections then counts the insurance payment on its own so the premium is not charged twice.

## If something looks wrong

Check the assumptions panel first — a "needs yield" badge means a crop has no yield entered, and profit shows "Set costs" until cost per acre exists. If a contract seems missing under an entity filter, remember agent-held contracts are shared by acres. Otherwise, contact support.

# Rent Settlement  (page: /reports/rent-settlement)

## What this page is for

Settling up with a landowner at the end of the year. Put the lease on file once, and Turnrow builds the settlement statement from your records — the landowner's share of bushels (the same splits-aware production math as the Share Rent Report), actual sale prices where you marketed their share, and shared expenses — itemized line by line. The finished statement carries **your farm's name and logo** (set under Settings → Organization), not Turnrow's — it's your document to mail.

## How to use it

1. **Put the lease on file.** Tap **Upload lease (AI)** — a PDF or photos — and Turnrow reads the terms: who the landowner is, which farms, crop-share percentages (by crop if they differ), which expenses are split, how the landowner's grain is priced, payment timing, and any flex clauses. You review and correct every field before saving, and the lease document stays attached. Handshake lease with nothing written down? **Enter a lease by hand** — same form, no upload.
2. **Generate a settlement.** Pick the lease and the crop year. Turnrow shows what your records supply — bushels by crop and the average settled price where you sold their share — then asks for **exactly what the lease needs that the records don't have**: a drying bill to split, a reference price to confirm, a flex bonus amount. Every one is a labeled blank; the statement won't generate until they're answered.
3. **Check, save, and send.** The preview shows every line with a small grey tag saying where its number came from — *From farm records*, *Entered at settlement*, or *Reference price (confirmed)*. Save it (it's kept on this page and can be regenerated), and download the PDF to print or email. Deleting a saved settlement asks you to confirm first.

## Where the numbers come from

- **Bushels** — your loads and combine entries for the lease's farms, split-aware, times the lease's share percentage.
- **Prices** — settled sales of grain hauled off those farms when you market the landowner's share; a price you confirm when the lease names a reference (the **Look it up (AI)** button suggests a figure with its source — nothing is used until you accept it); no price at all when the landowner markets their own grain (the statement shows bushels).
- **Expenses and flex adjustments** — always entered by you at settlement time, split per the lease.

## Common questions

- **The lease covers only some of a landowner's farms.** Check just those farms on the lease form; leaving all unchecked means every farm linked to that landowner.
- **Different share on corn than beans?** Add per-crop percentages on the lease — they override the overall share.
- **Can the landowner owe me?** Yes — when they market their own grain but owe their half of drying, the balance shows negative.
- **How is this different from the Share Rent Report?** That report is bushels only, using the share percentage on each farm. This one applies the *lease's* terms and produces a dollars statement.

## If something looks wrong

- Bushels look low: check the crop year, and that the right farms are checked on the lease — and that the fields' loads are entered.
- No settled price found: the sales may not be matched to settlements yet (check the ticket numbers), or the grain moved through a bin first — enter the price by hand.
- Anything else, contact support.

# Revenue Projections  (page: /reports/revenue-projections)

## What this page is for

Revenue Projections is the one-page financial summary of a crop year: every revenue source — crop sales, crop insurance proceeds, and government payments — alongside your costs, projected profit, and breakevens, crop by crop with operation totals. It is the page to hand a lender who asks "what is the whole year going to look like?"

## How to use it

The report opens on the current crop year (or the year you last picked); narrow to an entity if you want. The summary tiles show total revenue, total cost, total profit, and profit per acre. Tap **detail** beside a government-payments figure to see its ARC/PLC and other-payment pieces. Below them, the revenue table lists each crop's acres, yield, production, crop sales revenue, insurance proceeds, government payments, and revenue per acre; the profitability table adds cost, profit, the headline Total Avg Price, and both breakevens. The collapsible **How this is calculated** panel on the page walks through the same methodology described here.

## What the controls do

- **Crop year** — the year everything reports on.
- **Entity filter** — narrows acres, production, policies, and payments to that entity. Contracts and hedges held by your marketing agent, or entered with no entity, are whole-operation marketing: they count toward each entity by its share of the crop's planted acres, while an entity's own-name contracts stay wholly its own.
- **Export Excel / PDF / Print** — the full summary with the filter line included.

## How the numbers work

- **Crop sales revenue** is the same blended figure as the Marketing Dashboard: every bushel valued at its own price — cash sales at cash, futures-priced contracts at futures plus basis, open hedges and unpriced bushels at the relevant futures plus assumed basis — with realized futures and options gains counted once. Your standing assumptions from the Marketing Dashboard's What-If flow straight through here.
- **Cotton** buckets its pounds the same way: sold lint at locked prices, pool lint at dollars received plus the pool estimate, in-loan lint at the higher of the banked loan value or the market (the loan is the floor), held lint at the market or assumed price, net of fees. LDP payments and marketing loan gains count once inside cotton sales — never again under government payments.
- **Insurance proceeds** are estimated indemnities minus premium, from the same engine as the Claims Monitor.
- **Government payments** are attributed to the year the money arrives: for crop year Y, that is the prior program year's ARC/PLC (paid in October of year Y) plus other USDA payments landing in Y, allocated across crops by planted acres.
- **Breakeven** is sales-only: breakeven price = cost per acre ÷ yield, breakeven yield = cost per acre ÷ the Total Avg Price. The insurance and government safety net is in total revenue but deliberately not folded into breakeven.

This page and the Marketing Dashboard are built on the same math, so with no insurance or government payments the two profits match to the cent — insurance and payments are the only difference.

## Common questions

- **Why does profit here differ from the Marketing Dashboard?** Only because this page adds insurance proceeds and government payments. The crop sales line itself is identical.
- **Are these final numbers?** Not until after harvest. Insurance proceeds and harvest prices are estimates until RMA finalizes them, and unpriced bushels ride on your assumptions — watch for figures that depend on them.
- **I'm a read-only user — do my assumption edits show here?** Yes, as your private scenario: values you change flow into your view of this page, and an administrator's change replaces them.

## Insurance when your cost per acre comes from Turnrow Farm

If your cost per acre came from Turnrow Farm and already includes the crop insurance premium, this report says so under the Cost, Profit & Breakeven table and marks those crops **+ins** beside their cost. For those crops, Insurance Proceeds shows the expected insurance payment on its own instead of the payment minus the premium, because the premium is already in the cost. Every other crop is unchanged.

## If something looks wrong

If a crop is missing, it likely has no yield assumption yet — set one on the Marketing Dashboard. If revenue looks too high or low, check the assumed futures and basis there, since they value every unpriced bushel. If a government payment seems absent, confirm which year it was received in; payments count in the year they arrive. Otherwise, contact support.

# Season Summary  (page: /reports/season)

## What this page is for

The Season Summary is the one-table answer to "what did we plant and what did it make?" For a chosen crop year it shows every crop with its acres — full-season, double-crop, total, irrigated, and dryland — plus total dry bushels and yield per acre, with a grand total row at the bottom. Headline tiles above the table show total acres (with the irrigated and dryland split underneath), dry bushels from finished fields, the weighted yield across those fields, and the share of acres harvested so far.

## How to use it

The report opens on the current crop year; pick another at the top. If you run more than one entity, use the entity filter to narrow the report to one of them — acres, production, and yield then reflect that entity's fields only. Leave it on all entities for the whole operation. Both filters are remembered between visits.

When harvest is running, check back as loads come in: the production and yield columns build up as fields finish.

## What the controls do

- **Crop year** — chooses the crop year the whole page reports on.
- **Entity filter** — narrows acres and production to the fields belonging to that entity's farms.
- **Export Excel / Export PDF / Print** — exports the table exactly as shown, with the season and entity named in the header.

## How the numbers work

- **Acres** count every planted field, split into full-season and double-crop, and into irrigated and dryland where you have entered that breakout.
- **Dry bushels** come from your recorded loads, adjusted to each crop's base moisture — the same dry-bushel rules used everywhere else in Turnrow.
- **Yield per acre** divides production by the acres of fields that are actually finished. Fields that are unharvested or still in progress are left out of both production and yield, so a half-picked field never drags the average down. Their acres still show in the acreage columns. The **% harvested** tile is finished acres over all planted acres; the **weighted yield** tile is grain bushels over finished grain acres.
- **Average yields** for recent seasons appear in the header strip, computed the same way.
- **Cotton** rows keep their acres in this table, but production and yield for cotton are measured in pounds of lint, not bushels — the row points you to the Cotton Yields section below, which shows lint pounds per acre, seed cotton pounds per acre, turnout percentage, and any loads still on the yard awaiting ginning, field by field.

## Common questions

- **Why is my yield higher than I expected mid-harvest?** Only finished fields count toward yield. If your best ground came off first, the early average reflects that and will settle as the rest is harvested.
- **Why does a crop show acres but no bushels?** Either no loads are recorded for it yet, or its fields are still marked in progress. Cotton crops intentionally show no bushels — see the Cotton Yields section instead.
- **Why don't the irrigated and dryland columns add up to total acres?** Those columns only fill in where you have recorded the irrigated/dryland breakout on the field or planting. A dash means no breakout was entered.
- **Does the entity filter change yields?** It changes which fields are included. Yields are then computed from that entity's fields alone, so they can differ from the whole-operation figure.

## If something looks wrong

If production looks low, check the Loads page for missing or misdated loads — a load recorded under the wrong crop year will not appear here. If a field you know is finished still is not counting, its harvest status may need updating on the Yields page, where you can also force a field to be included. If numbers still do not add up after checking loads and field status, contact support.

# Bundled Settlement Statements  (page: /reports/settlement-pdfs)

## What this page is for

When your crop insurance production is audited, the adjuster wants the buyer's settlement statements to verify the production you self-reported. This page gathers every settlement statement for a crop and year and bundles the attached PDFs into a single zip file you can hand to your agent — no hunting through folders or email.

## How to use it

- Pick a **crop** and a **crop year**. Both are required.
- The page lists every settlement whose lines matched loads of that crop and year, and shows three counts: settlements matching, settlements with a PDF (these get zipped), and settlements missing a PDF.
- Press **Download ZIP** to get one file containing every attached settlement PDF.
- If any settlements are missing their PDF, open each one from the list, attach the buyer's PDF, and come back to re-run the download.

## What the controls do

- **Crop** — which crop's settlements to gather.
- **Crop year** — which year's settlements to gather.
- **Download ZIP** — builds the bundle. The button shows progress while it works and tells you how many PDFs it will include.
- **Export buttons** — export the list itself (dates, settlement numbers, buyers, matched line counts, PDF status) as a checklist to go with the bundle.
- **Open →** — jumps to a settlement's review page, where you can attach a missing PDF.

## Common questions

- **How does it know which settlements belong to this crop and year?** Through matched lines. Each settlement line is matched to a delivered load by ticket number, and the load carries the crop and crop year. A settlement with at least one matched line for your selection is included.
- **Why does it say no settlements match?** Either no settlements are entered for that crop and year, or their lines aren't matched to loads yet. Open your settlements and match the lines — matching is what drives crop and year detection here.
- **A settlement is listed but marked "Missing"** — it was entered without the buyer's PDF attached. The data is in the system, but there's no document to bundle. Open it and attach the PDF.
- **Can my landlord's or a viewer's login see this?** No. This page covers the whole operation with no entity split, so read-only viewer accounts don't get it.

## If something looks wrong

- If a settlement you expect is absent, check that it exists under Settlements and that its lines are matched to loads of the right crop and year.
- If the zip is missing a statement, that settlement likely had no PDF attached — the "Missing PDF" count on this page will confirm it.
- If a download fails partway, try again; if it keeps failing, contact support.

# Share Rent Report  (page: /reports/share-rent)

## What this page is for

If you rent ground on crop shares, this report figures the landlord's share of the bushels. It takes each share-rent farm's production and applies that farm's agreed landlord percentage, giving you bushels owed by landowner, by farm, and by crop — the numbers you need when it's time to settle up or deliver the landlord's grain.

## How to use it

- The report opens on the current crop year (or the newest year with plantings the first time); your pick is remembered. It shows a summary of bushels owed per crop, then a section per landowner showing each of their share-rent farms. Bushels are whole numbers, acres to one decimal.
- A landowner signed in with read-only access sees only the ground with a landowner on it — the operation's own "Owned / No Landowner" group is left off their view.
- Each farm section shows the landlord's share percentage, the farm's FSA number, and a field-by-field table: acres, total dry bushels, yield, and the landlord's bushels.
- Narrow with the **crop**, **entity**, or **landowner** filters to prepare a statement for one owner.
- Export to **Excel** or **PDF** to hand the landowner a clean statement.

## What the controls do

- **Crop year** — the harvest year to settle.
- **Crop** — one crop at a time, if you settle crops separately.
- **Entity** — farms operated under one of your entities.
- **Landowner** — a single owner's farms.

## How the numbers work

- Only farms marked as **share rent** with a **landlord share percentage** entered are included. Both are set in Settings, Farms.
- Landlord bushels = the farm's dry bushels multiplied by that farm's share percentage. Each farm uses its own percentage, so different deals on different farms are handled correctly.
- Bushels are dry bushels — adjusted to the crop's base moisture — so the landlord's share is figured on the same basis grain is priced.
- Split loads are credited to the right fields first, so a farm's production reflects what actually came off it.
- The "owed" totals at the top sum the landlord bushels across all owners for each crop.

## Common questions

- **Why is a farm missing?** It isn't marked as share rent, its landlord share percentage is zero or blank, or it has no production in the selected year. Check Settings, Farms.
- **My deal is a cash-plus-share arrangement — where does the cash part go?** This report covers the bushel share only. Track cash rent outside this report.
- **The landlord and I split by field, not by farm.** The share percentage is set per farm. If different fields carry different splits, set those fields up under separate farms so each can carry its own percentage.
- **Does this show dollars?** No — it reports bushels owed. Pricing the landlord's grain is between you and the landlord.

## If something looks wrong

- If the share looks off, verify the farm's landlord share percentage in Settings, Farms.
- If bushels look off, check the fields' loads and split allocations for the year.
- If a landowner heading is wrong, fix the landowner assigned to the farm in Settings.
- Anything else, contact support.

# Yields by Landowner  (page: /reports/yields-by-landowner)

## What this page is for

This report shows production and yields organized by landowner. If you farm ground for several owners, this is the page to open when one of them asks "how did my ground do this year?" Each landowner's section lists their farms and fields with acres, bushels, and yield per acre, so you can share results owner by owner without exposing the rest of your operation.

## How to use it

- The report opens on the current crop year (or the year you last picked). It groups everything by landowner, then by farm, then by field.
- Narrow with the **crop**, **entity**, or **landowner** filters — picking one landowner gives you a clean page for that owner alone.
- Use the **Excel**, **PDF**, or **Print** buttons to produce a copy to hand or email to the landowner. The export mirrors the screen. The "Owned / No Landowner" group is left off the printed handout, and off the page entirely for a landowner signed in with read-only access.
- Your filter choices are remembered, so the report opens the same way next time. The same view lives on the Yields page under the **By landowner** tab, where it follows that page's filter row.

## What the controls do

- **Crop year** — the harvest year to report.
- **Crop** — limit to one crop (for example, only the corn ground).
- **Entity** — limit to farms operated under one of your entities.
- **Landowner** — limit to a single owner's ground.

## How the numbers work

- Production comes from your recorded loads. When one load was split across multiple fields, each field is credited with its share, so a landowner's numbers reflect what actually came off their ground.
- Bushels are dry bushels — net weight adjusted to the crop's base moisture — so yields compare fairly across wet and dry loads.
- Yield per acre is the field's production divided by its planted acres for that year.
- Farms are tied to landowners in Settings, Farms. A farm with no landowner assigned won't appear under anyone.

## Common questions

- **Why is a landowner missing?** Their farms may not have a landowner assigned in Settings, or none of their fields have production recorded for the selected year.
- **Why is a field's yield blank or low?** Its loads may not all be entered, or its harvest may not be complete. Check the Yields page for that field.
- **Can I send this to a landowner directly?** Export the PDF with the landowner filter set to that one owner — it prints clean with a date stamp.
- **Do share-rent percentages show here?** No — this page is total production. For the landlord's share of bushels at the agreed percentage, use the Share Rent Report.

## If something looks wrong

- If acres are off, check the field and planting acres in Settings.
- If bushels are off, check the field's loads and any split-load allocations.
- If a farm is grouped under the wrong owner, fix the landowner on that farm in Settings, Farms.
- Anything else, contact support.

# Reports Overview  (page: /reports)

## What this page is for

The Reports page is the front door to every report in Turnrow. It shows one card per report, grouped by the question you are asking, with a one-sentence description of what each one answers. The same list appears in the sidebar on the left, so you can move between reports without coming back here.

The groups:

- **How is harvest going** — Season Summary, Yields by Field, Yields by Farm, Yields by Landowner, and (with the Cotton module on) the Bale Quality Summary.
- **Where do I stand on selling** — the Marketing Dashboard and the Hedging Summary.
- **What will I make** — Revenue Projections, Income Sensitivity, the Cash Flow Forecast, and the Crop Budget Planner.
- **Landowners** — the Share Rent Report and Rent Settlement.
- **Insurance & USDA** — the Crop Insurance Production Report, the Claims Monitor, Bundled Settlement Statements, the ARC/PLC Decision Aid, and the Government Payment Tracker.
- **Calculators** — Freight Math and Grain Dryer Math.
- **Records** — the load log, contract tracker, unpaid loads, and bin inventory, which open on their own pages.

## How to use it

Pick the question you are trying to answer, then open the report under it. If you want a season's production story, start with Season Summary. If you want to know where you stand on selling the crop, open the Marketing Dashboard. If a lender wants one page, Revenue Projections or the Hedging Summary is usually what they are after.

Every report opens on the **current crop year** the first time you visit it. Change the year and the report remembers your pick from then on — it never resets a year you chose. The other filters (entity, crop, and so on) are remembered the same way, so a report you check often opens the way you left it.

Every report has the same layout: the title with a plain line underneath naming the crop year, entity, and other filters in effect; the Excel, PDF, and Print buttons on the right; and a filter row with a label on every control. On a phone the filter row folds behind a **Filters** button that shows how many filters are active.

## What the controls do

- **Report cards** — click any card to open that report.
- **The ↗ marker** — a card or sidebar entry marked with ↗ opens a standalone page elsewhere in Turnrow (for example, Yields by Field opens the Yields page, and the Load Log opens the Loads page). Everything without the marker opens right inside the Reports area.
- **Sidebar** — the same reports, always visible, for quick switching.

## How the numbers work

The landing page itself does no math — each report computes its own numbers and explains them on its own page. What the reports share is consistency: the entity filter means the same thing everywhere, the Marketing Dashboard and Revenue Projections are built to agree with each other, and the Cash Flow Forecast and Claims Monitor use the same insurance estimates.

Every report that opens inside the Reports area has **Export Excel**, **Export PDF**, and **Print** buttons. Exports always reflect the filters you have set on screen — the spreadsheet or PDF matches what you are looking at, including a filter line at the top so the recipient knows exactly what they are seeing.

## Common questions

- **Why do some entries open a different page?** Reports marked ↗ are working pages (Loads, Contracts, Inventory, Yields) that double as reports. They have their own exports and filters there.
- **Do the exports include my filters?** Yes. The export names the crop year, entity, and any other active filters, so a lender or agent can tell what slice of the operation it covers.
- **Why don't I see every report listed?** What you see depends on your role. Read-only users see the reports their access covers; links into operational pages are hidden for them. When a report is empty and the fix lives on a page a read-only user cannot open, the report says "Ask the operator to …" instead of showing a link that would not work.

## If something looks wrong

If a report card is missing that you believe you should have access to, check with whoever administers your Turnrow account — access is set per user. If a report opens but shows no data, check its crop year and entity filters first; most empty-looking reports are filtered to a year with no activity. If a report will not open at all, contact support.

# Scan tickets  (page: /loads/scan)

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

# Seed production contracts  (page: /contracts/seed)

## What a seed contract is

A seed production agreement is different from selling grain. You commit **acres** — named fields growing the seed company's variety — not a bushel count. Whatever those fields produce belongs to the seed company. In return you get to price the bushels on your own timing against a named local elevator's posted price, and a premium rides on top of that price once the company accepts the crop as seed.

Turnrow tracks all of it: the agreement's terms, your pricing elections, the staged payments, and how it all rolls into the marketing and cash-flow reports.

## Entering one

On the Contracts page, the **New Contract** button opens the grain contract form directly; the small **▾** caret beside it holds **Seed contract**, which opens the dedicated form. Type the terms in, or upload the signed agreement (PDF or photos) — Turnrow reads the signature page and the premium/payment terms and fills the form in for your review. Nothing saves until you confirm.

The important pieces:

- **Contract acres and forecast yield** — together they set the estimated quantity, but the real committed production comes from the **fields you link** on the form. Until harvest, those fields count at their expected yield; after harvest, at their actual bushels.
- **Local market for pricing** — the elevator whose posted price your elections use (for example, a river terminal named in the agreement).
- **Price everything by** — the agreement's deadline (Selection Date). All the bushels need a price by then.
- **Premium schedule** — what the company pays on top of your elected price, per outcome: one stack if the seed is *accepted*, another if it's *released* back to you, and so on. Some premiums (like an irrigation premium) pay only on irrigated bushels, and the total is capped per bushel. The form starts from the standard soybean seed schedule (all four outcomes filled in) — edit every row to match your agreement, and you can also add, edit, or remove rows any time on the contract's own page, or tap **Apply standard schedule** to reset it to the standard one (it asks before replacing what's there).
- **If the upload can't read the premium pages** — when the agreement's premium terms are missing or only partly readable, Turnrow never quietly saves a partial schedule. It asks: apply the standard schedule (shown for your review), keep just the rows it could read, or leave the schedule empty. An empty or incomplete schedule is always flagged — never a silent zero.
- **Usage fee** — the per-bushel fee the company nets out of your settlement. Enter it as a plain number; Turnrow knows it comes out, not in.

## Pricing elections

You price the crop in 25% pieces (25 / 50 / 75 / 100), each at the local market's price that day or a target order that filled. Record each one on the contract's page — "Price 25% at $10.42 — elected 11/3" — and the page keeps the running total priced. Turnrow won't let elections go past 100%.

## Why premiums are an assumption until acceptance

The premium stack only pays in full if the company accepts the crop as seed — and that decision comes after harvest. Until then, every projection in Turnrow values the premiums at the **expected outcome** you've set on the contract (it starts at *Accepted*). If you want to plan conservatively, change the expected outcome and every report follows. When the company settles, record the real payments and the projections step aside.

## Payments

Seed contracts pay in stages: typically 80% of the base price after delivery and pricing, the final 20% plus premiums at final settlement (often the following spring), storage pay monthly if you hold the crop, and the usage fee netted out. Record each payment on the contract's page as it arrives — type the amount as a plain number and pick the type; a usage fee is recorded as money taken out automatically. A seed contract's **Edit** button opens the seed form, never the grain one. The **Cash Flow report** projects the stages until the real payments replace them, and the contract shows **complete** once the final base payment is received.

## Where it shows up in reports

- **Marketing** — the linked fields' bushels count as committed to the seed company, with their own segment in the position bar and a "Seed — [company]" tag. Elected bushels hold their elected price plus expected premiums; unpriced bushels move with the market (marked "seed est.").
- **Income Sensitivity** — elected portions stay locked; unpriced seed bushels move with the scenario price. Premiums stay at the expected-outcome assumption.
- **Cash Flow** — the staged payments appear as labeled seed lines with their own column.
- **Revenue Projections** — the seed dollars are inside crop sales revenue, so everything still adds up.

## Common questions

- **Why does the contract show "(est.)" bushels?** The linked fields haven't finished harvest, so committed production is still the expected yield. It switches to actual bushels when harvest wraps up.
- **Can I sell grain off the seed fields to someone else?** No — the agreement commits everything those fields produce, and Turnrow treats it that way: seed-field bushels never count as available for grain contracts.
- **What if the crop is released back to me?** Set the expected outcome to *Released* so projections use that premium level; the released bushels are yours to market as grain at that point.
- **Why does the contract say "no premiums"?** The outcome you've set as expected has no premium rows on file, so every projection shows the base price only — that's a gap in the schedule, not a real $0 premium. Open the contract and add the rows, or tap **Apply standard schedule**. The warning shows on the contract page, the contract list, and the Marketing page until the rows exist.

## If something looks wrong

- The committed bushels look off: check which fields are linked on the contract (Edit) and the crop's expected yield under the Marketing page's assumptions.
- Premiums look too high or low: open the contract and check the premium schedule rows, the irrigated acres on the linked fields, and the premium cap.
- Anything else: contact support.

# Bin Sites & Bins  (page: /settings/bin-sites)

## What this page is for

Where your grain is stored. A **bin site** is a place with bins — the home place, a rented elevator — under an entity; each **bin** has a name, an optional crop, and an optional capacity. The load form and Bin Inventory both work from this list.

## How to use it

- **Add a bin site** with its name and entity (county and address are optional). Type the bins right on the same form, separated by commas, and they're created with it.
- **Show bins** on a site to add, edit, or move bins; each bin shows its bushels on hand.
- **Upload a bin list** or bring in a spreadsheet — each row names the bin, its site, and optionally its crop and capacity.
- **Delete** a site and its bins stay, marked "not assigned to a site" until you pick a new one. A bin with loads in or out of it can't be deleted — rename it or move it instead.

## What the controls do

- **Capacity (bu)** — set it and Bin Inventory shows a percent-full bar for that bin.
- **Crop** — what the bin normally holds; the load form uses it to warn about mixing.
- **Bins not assigned to a site** appear in a red box at the top with a picker for each — assign them so inventory groups correctly.

## Common questions

- **What's "Default Site"?** Bins that existed before sites did were grouped there automatically. Rename it or split it into your real sites.
- **Moving grain between bins?** That's recorded on the Bin Inventory page, not here.

## If something looks wrong

- A bin missing from the load form: check it's assigned to a site.
- Anything else, contact support.

# Buyers & Delivery Locations  (page: /settings/buyers)

## What this page is for

Buyers are the businesses you sell and haul to — elevators, river terminals, feed mills, ethanol plants, gins. Each buyer can carry one or more delivery locations (separate elevators, terminals), which contracts and loads then point at. Set them up once here and they're available everywhere a load or contract asks where the grain went.

## How to use it

- Type a name and **Add Buyer** to create one. Expand a buyer to add its delivery locations, each with an optional address.
- **Find buyers near me** searches the web for elevators, terminals, and other buyers that handle your crops near a zip code you enter, within a radius you pick. Results come back as a checklist — tick the ones you actually sell to, edit a name if it isn't quite right, and add them. Anything you don't tick is discarded, and results already in your list are marked so you don't double up.
- To bring in a whole list at once, use the spreadsheet import at the top — one row per buyer, locations in one cell separated by semicolons. There's also an **Upload a buyer list** card that reads buyer names and delivery locations out of any document, alongside anything else it finds worth filing elsewhere.
- **Discount schedules live on each buyer.** Expand a buyer and its schedules are right there — crop, effective date, rule count, and a link to the original sheet — with **Upload discount schedule** on the buyer's own card (photo or PDF; Turnrow reads where drying and test-weight charges start, the rates or bracket scales, rejection points; review and confirm — nothing saves until you do). When a buyer posts a new sheet, upload it too — the effective dates keep each one applied to its own period; to replace a bad read, delete it and upload again.
- **The shrink factor sits on the schedule row.** Elevators shrink wet bushels to base at their own factor (1.4% per point is typical) before charging drying, and the Grain Dryer Math comparison needs that number. Turnrow reads it from the sheet when it's printed; when it isn't, the row shows the moisture terms in amber with *assumed — verify against the schedule* and a **Shrink %/pt** box — type the printed factor and it saves as you leave the box. Blank means the 1.4% assumption.
- **Schedules are queryable in plain words.** Once a schedule is on file, **Ask Turnrow** can quote it — try *"What will [buyer] dock me for 17% corn?"* — and can compare what each buyer's discounting actually cost you from your settled statements ("which buyer's discounts cost me the most last year?"). The Grain Dryer Math tool also uses the schedules for its dry-it-or-haul-it-wet comparison.

## What the controls do

- **Find buyers near me** remembers your last zip and radius. Results are AI-found from public sources — verify the details (that they're still buying, hours, address) before hauling. A result marked **unverified** means the search couldn't confirm it from a direct source. Rural areas may genuinely turn up only a handful — that's the honest answer, not a glitch. Adding your buyers by hand is always the sure path.
- **Edit / Delete** on a buyer or location work as you'd expect; deleting a buyer also deletes its locations, and contracts pointing at a deleted location have their location cleared.

## Common questions

- **The finder didn't list an elevator I know is there.** Public listings are patchy, especially for smaller elevators. Add it manually — that's the primary way, the finder is just a head start.
- **A found buyer's details look off.** Treat the finder as a lead, not gospel: verify the name, location, and that they're buying your crop before hauling. You can edit everything after adding it.
- **Why is a result greyed out?** A buyer with that name is already in your list.

## If something looks wrong

- A buyer missing from a load or contract dropdown: check it exists here and, for contracts, that the delivery location is on the right buyer.
- The finder keeps erroring: wait a few minutes and try again — searches are limited to keep them snappy. Manual entry always works meanwhile.
- Still stuck: contact support.

# Contract list (bulk edit)  (page: /settings/contracts)

## What this page is for

Every grain contract in one editable list — for cleanup, spreadsheet imports, and fixing several at once. For day-to-day work (deliveries against a contract, pricing, what's left to fill), use the **Contracts** tab.

## How to use it

- **Add a contract** by hand, or **upload the contract** (PDF or photo) and Turnrow fills in the form from the document — review, then Add Contract, and the document attaches automatically.
- Bring in many at once with the spreadsheet import.
- **Search** by contract number, buyer, crop, year, or notes; **Select all** and **Delete selected** clean up a batch.
- **Edit** a row to change anything. **Delete** is only offered for a contract with no loads delivered against it — move those loads to another contract first.

## Common questions

- **Where are seed contracts?** They have their own page under the Contracts tab; this list is the grain book only.
- **Deleting a batch that has deliveries?** The loads keep their records but lose the contract link. Turnrow confirms before it does it.

## If something looks wrong

- A contract missing here: check the crop year and search terms — nothing is filtered by entity on this page.
- Anything else, contact support.

# Crops  (page: /settings/crops)

## What this page is for

Your crop list, with the two settings that shape everything else: each crop's **harvest season** (fall or spring) and whether it's grown as a **double-crop**. It also holds the year-end **Physical Sales Complete** checkboxes.

## How to use it

- The standard crops come pre-loaded. Check the names match how you settle, add any you grow that are missing, and set each one's harvest season.
- **Edit** opens a small dialog for renaming a crop, which also holds **Crop insurance type (winter/spring)** — normally automatic, and only matters if your state offers both types.
- **Delete** is only offered for a crop with no plantings or loads recorded against it; otherwise rename it.

## What the controls do

- **Harvest season** — spring-harvest crops like wheat are what make a later planting on the same field count as double-crop.
- **Double-crop** — mark a crop that's grown after another (soybeans after wheat). Only a Double-crop crop gets double-crop rows in the Marketing Dashboard's assumptions grids when you plan a year that isn't planted yet.
- **Physical Sales Complete for the Year?** — when a crop year's grain or cotton is fully sold, mark it here. Shrink and small leftovers mean sold-versus-production rarely lands on exactly zero, so this checkbox is how you tell Turnrow the year's selling is finished. The same checkboxes sit at the bottom of the Marketing Dashboard.

## Common questions

- **Why does Physical Sales Complete matter?** Some year-end checks compare what you produced with what you sold; this flag tells them to stop expecting more sales.
- **I renamed a crop — do old loads change?** Yes, the name shows everywhere; the numbers don't change.

## If something looks wrong

- Double-crop acres look wrong: check the harvest seasons on both crops involved.
- Anything else, contact support.

# Entities  (page: /settings/entities)

## What this page is for

Entities are the companies and people that farm — an LLC, a partnership, you as an individual. Farms belong to entities, and most reports can be filtered by entity, so keeping them straight up front pays off later. If you farm under one name, you'll have one entity and Turnrow fills it in for you everywhere.

## How to use it

- **Add an entity** with its name, the counties it operates in (at least one — farms pick their county from this list), and its FSA eligible-persons count.
- **Edit** a row to change any of that; **Delete** removes an entity nothing depends on. An entity with loads recorded against it can't be deleted — rename it instead.
- The upload card at the top reads entity names out of any document (FSA records, a lease) alongside anything else it finds worth filing.

## What the controls do

- **Counties** — the counties this entity farms in. Farms and bin sites under the entity choose from these, so add every county you have ground in.
- **Payment-limit persons** — the eligible persons for FSA payment limits. The entity's total ARC/PLC cap is this number times the program year's per-person limit. Set it once; change it if the entity's structure changes.
- **Role** — a **farming entity** (the usual) or a **marketing agent**: one entity that holds the contracts and hedge account on behalf of the whole operation. In entity-filtered reports the agent's marketing flows down to each farming entity by its share of the crop's planted acres, so income lands where the grain was grown.

## Common questions

- **Do I have to use a marketing-agent entity?** No — it's for operations where one entity does the selling for several farming entities. Skip it if each entity markets its own grain.
- **I farm under just one company. Do I have to keep picking it?** No. With a single entity, entity dropdowns disappear from forms and imports until the day you add a second one.
- **What happens to farms when I delete an entity?** They're kept, but left without an entity until you reassign them. Turnrow shows the count before you confirm.

## If something looks wrong

- A county missing from a farm's dropdown: add it to the entity here first.
- Anything else, contact support.

# Turnrow Farm Link  (page: /settings/farm-link)

## What this page is for

Turnrow Farm and Turnrow Grain are two halves of the same operation. Turnrow Farm keeps your land: entities, farms, fields, boundaries, and what was planted where. Turnrow Grain keeps what happens after: loads, bins, contracts, settlements, hedging, crop insurance, government payments, and marketing. This page connects the two so each side stops re-typing the other's work.

Once connected, Turnrow Farm sends your entities, farms, fields, and plantings here and keeps them current. Turnrow Grain sends back production, marketing, income, bin inventory, and your crop insurance premiums. Because both sides are your own organization, everything is shared unless you turn a switch off.

## How to connect

1. Press **Generate pairing code**. The code appears once — copy it right away. It expires in 7 days if unused.
2. In Turnrow Farm, go to **Settings > Integrations > Turnrow Grain** and paste the code.
3. Turnrow Farm completes the pairing on its own. This page then shows **Connected** with the name of your Turnrow Farm organization.

If the code expires or you lose it, press **New pairing code**; the old one stops working.

## What changes once land has come across

After Turnrow Farm's first land sync lands, the **Entities, Farms, Fields, and Plantings** pages show a "Managed in Turnrow Farm" banner. Rows that came from Turnrow Farm are read-only here (edit them there; the change syncs back). Rows you created here that Turnrow Farm has not matched yet show a **not linked** chip and stay editable until you match them in Turnrow Farm. The spreadsheet and document importers for those four pages stop running and say so. Entities keep their county assignments and payment-limit persons editable here, because Turnrow Farm does not track those.

Deleting a farm, field, or planting in Turnrow Farm archives it here rather than deleting it, and Turnrow Grain refuses to archive a field or planting that already has loads, yields, or settlements; Turnrow Farm shows you that refusal.

If you edit a record here after the last update and Turnrow Farm later sends a different value for it, Turnrow Grain keeps yours and hands the conflict back to Turnrow Farm to resolve. Nothing is overwritten quietly. The count of conflicts from the last update shows on this page.

## What the switches do

- **Land records from Turnrow Farm** — entities, farms, fields, and plantings come from Turnrow Farm.
- **Production to Turnrow Farm** — harvest progress, bushels or pounds, and yields per field, the same numbers the Yields pages show.
- **Marketing to Turnrow Farm** — average sale prices, projected prices with basis, percent sold, and realized hedging results by crop.
- **Income to Turnrow Farm** — crop revenue, government payments, and crop insurance by crop and entity.
- **Bins to Turnrow Farm** — bushels on hand and bushels in for the year, per bin and crop.
- **Landowners shared with Turnrow Farm** — names, contact people, mailing addresses, and who the rent cheque is made out to stay the same on both sides. This one goes **both ways**: you can edit a landowner here or there. If you and Turnrow Farm both changed the same thing before the next sync, Turnrow Grain keeps yours and tells Turnrow Farm, so nothing is quietly overwritten. Leases you have entered here are offered to Turnrow Farm once; after it takes one over, that lease is read-only here with a link.
- **Crop insurance premiums to Turnrow Farm** — what you pay for crop insurance, by entity, crop, and irrigated or dryland, so you do not enter it again when you build a cost per acre over there. Turnrow Farm gets the premium you pay; the subsidy and the full premium go with it for reference, and so do the expected indemnities.
- **Cost assumptions from Turnrow Farm** — Turnrow Farm's planning cost per acre lands in the Marketing report's assumptions (with the irrigated, dryland, and double-crop breakouts) and in any Crop Budget marked to follow Turnrow Farm. The Marketing report labels these "from Turnrow Farm, updated (date)" and has a **Use my own costs** switch per crop that keeps what you type. When that cost already has crop insurance in it, both the Marketing report and Revenue Projections say "Insurance included in the Turnrow Farm cost per acre" beside the figure, and Revenue Projections then shows the insurance payment on its own so the premium is not charged twice.
- **Landowner statements from Turnrow Farm** — finalized rent statements are kept here so a landowner share can include them (see Landowner Shares).

Turning a switch off applies the next time Turnrow Farm checks in.

## Replace token and Disconnect

- **Replace token** issues a new link token, shown once. Paste it into Turnrow Farm under the same Integrations page; the old token stops working immediately.
- **Disconnect** ends the link. Turnrow Farm loses access at once. Records that already came across stay here and become editable again.

## Common questions

- **A farm shows "edit in Turnrow Farm" but I need to change its county.** Change it in Turnrow Farm; the next sync brings it here.
- **A field I created here says "not linked".** Open Turnrow Farm and match it to the field there. Until you do, it stays editable here.
- **The last update shows conflicts.** Open Turnrow Farm; it lists the records and lets you choose which side is right.
- **Nothing has come across yet.** The land pages stay fully editable until Turnrow Farm sends its land records the first time.
- **Turnrow Farm does not offer crop insurance premiums.** This switch is newer than the link. Make sure **Crop insurance premiums to Turnrow Farm** is on above, then pair again from Turnrow Farm and choose **Update now**.
- **I changed a landowner here and Turnrow Farm still shows the old one.** It arrives on the next sync. If you both changed the same thing, Turnrow Farm shows it as something to settle rather than picking a winner.
- **A landowner shows "from Turnrow Farm" beside a field.** That field was changed over there in the last day. It is only a note; you can edit it here whenever you like.
- **Turnrow Farm wants to merge two landowners.** Merging moves their farms, leases, settlements, and statements onto the one you keep, and archives the other. A landowner with a live Turnrow Landowner share is not merged or archived until you end the share or choose to move it.
- **The premium in Turnrow Farm does not match mine.** It is the total of every policy for that entity, crop, and practice, riders included, and it is the amount you pay after the subsidy. Check the policies under Settings > Crop Insurance for the same crop year.

## If something looks wrong

- Turnrow Farm says the pairing code is invalid or expired: generate a new code here and paste it again.
- Turnrow Farm says it isn't allowed in: replace the token here and paste the new one there.
- The page says the link needs a database update: contact support.

# Farms  (page: /settings/farms)

## What this page is for

A farm here is an FSA farm: a name, the entity that operates it, its county, its FSA farm number, and the landowner you rent it from. Fields sit under farms, and the share-rent settings here drive the Share Rent Report and the landowner statements.

## How to use it

- **Add a farm**: name, entity, county (the list comes from the entity's counties), FSA farm number, landowner, and — if it's share rent — the landlord's share percentage. New landowners can be added right from the landowner dropdown.
- **Upload FSA farm records or a lease** at the top and Turnrow fills farms in from the document, along with the entities, fields, and landowners it finds. Or bring in a spreadsheet.
- **Edit** a row to change anything. **Archive** hides a farm you no longer operate while keeping its fields, plantings, loads, and yields on record. **Delete** is only offered when nothing depends on the farm — Turnrow counts its fields and plantings first, and a farm with loads recorded can only be archived.

## What the controls do

- **Share rent / Landlord share %** — mark the farm share rent and enter the landowner's percentage of production (0–100). The Share Rent Report and rent statements use it.
- **Search** and the **Name ↑/↓** sort narrow long lists.
- **Spreadsheet import** — entity and landowner match by name against what already exists (import those first); counties match by name plus two-letter state together, so the state column is required whenever a county is given. Share rent comes in as yes/no with the landlord percent. If you have one entity, leave the entity column out and it's filled in for you.

## Common questions

- **The county dropdown is empty.** The farm's entity has no counties yet — add them under Settings → Entities.
- **Archive or delete?** Archive when the farm existed and has history; delete only for a mistake you just made.
- **Farms are read-only here.** Your land is managed in Turnrow Farm — change them there and they come across.

## If something looks wrong

- A farm shows "no county": edit it and pick one — county drives crop insurance and government-payment reports.
- Anything else, contact support.

# Fields  (page: /settings/fields)

## What this page is for

Fields are what loads, plantings, and yields point at. Each field has a name or number, the farm it's on, its county, and its total and irrigated acres — dryland acres are worked out for you (total minus irrigated).

## How to use it

- **Add a field**: name or number, farm, county (from the farm's entity), total acres, irrigated acres. The farm and county stay filled in so adding the next field on the same farm is quick.
- **Upload a field list** — a photographed or PDF list, an acreage report — or bring in a spreadsheet.
- **Plantings (n)** on a row shows what's been planted on that field by season; **Manage plantings →** opens the Field Plantings page.
- **Edit** a row to change anything. **Archive** hides a field you no longer farm while keeping its plantings, loads, and yields. **Delete** is only offered when no loads point at the field — Turnrow tells you how many plantings would go with it.

## What the controls do

- **Search**, the **Farm** filter, and **Sort** narrow long lists; the farm filter is remembered next time you visit.
- **Irrigated acres** can't be more than total acres — the form says so before you save.

## Common questions

- **Dryland acres look wrong.** They're total acres minus irrigated acres — fix one of those.
- **Two fields with the same name?** Turnrow allows the same name on different farms, but stops you adding a duplicate on the same farm.
- **Fields are read-only here.** Your land is managed in Turnrow Farm — change them there and they come across. Fields marked "not linked" were created here and stay editable until you match them there.

## If something looks wrong

- A field missing from the load form: check it isn't archived, and that it has the right farm.
- Anything else, contact support.

# Landowners  (page: /settings/landowners)

## What this page is for

Who you rent from: each landowner's name, contact details, address, and who the rent check is made out to. Farms point at landowners, and the landowner reports and rent statements are built from here.

## How to use it

- **Add a landowner** — name is the only required field. As you type, Turnrow checks for a landowner you already have and offers **Use** them instead, because two records for one landowner split their rent, their statements, and their share.
- **Upload a lease or landowner list**, or bring landowners in from a spreadsheet — do this before importing farms so the farms import can match their names.
- **Edit** to change details. **Archive** hides a landowner you no longer rent from; their farms and past statements keep the name, and **Show archived** brings them back. **Delete** is only offered when no farms point at them.

## What the controls do

- **Kind** — individual, family, company, trust, estate, government — helps the statements read right.
- **Make checks payable to** — when the payee isn't the landowner's own name.
- **Shared with Turnrow Farm** — a landowner both sides know. You can edit them here or there; a field changed in Turnrow Farm in the last day carries a "from Turnrow Farm" mark so you know why it looks different.

## Common questions

- **I added someone twice by mistake.** Edit the farms to point at the one you're keeping, then archive or delete the other.
- **Why can't I delete a landowner?** Farms still point at them. Archive instead, or change the landowner on those farms first.

## If something looks wrong

- A landowner missing from the farm dropdown: check they aren't archived.
- Anything else, contact support.

# Settings  (page: /settings)

## What this page is for

Settings is where your operation's structure lives — the entities, farms, fields, crops, and people everything else hangs on. Get these right once and the rest of Turnrow mostly fills itself in. The hub groups the pages the way you think about the farm; on a phone the same list is behind the **All settings** button on every settings page.

## The groups

- **Your operation** — Entities, Landowners, Farms, Fields, Field Plantings, Crops, Varieties. Each has its own help topic.
- **Storage & hauling** — Bin Sites & Bins, Trucks.
- **Buyers & contracts** — Buyers & Delivery Locations, and the Contract list (bulk edit). Day-to-day contract work lives on the Contracts tab; the list here is for cleanup and imports.
- **Programs** — Crop Insurance, Government Payments.
- **People & sharing** — Users, Organization (your name and logo on documents, and the Cotton switch), Landowner Shares, Turnrow Farm Link.

## Setting up from your paperwork

The top of Settings has an **Upload any document** card that takes anything — leases, FSA farm records (a 578 or 156-EZ), plat maps, acreage reports, plain lists. One upload reads the whole document and sorts what it finds into the right places (a lease fills in the landowner, the farm, and the share terms together), grouped for your review — nothing saves until you check it. Most setup pages have their own upload card too. See the Uploading Documents topic for the full picture.

## Spreadsheet imports: blanks are fine

In every spreadsheet import here, **a blank cell in an optional column never fails the row** — only each import's starred required columns can. Leave what you don't track blank: a blank share-rent cell simply means not share rent, a blank percentage stays empty, a blank landowner leaves the farm unlinked. You can also leave whole optional columns out of the file.

## Deleting and archiving

Before anything is deleted, Turnrow counts what depends on it and tells you — "Delete Home Place and its 12 fields and 31 plantings?" — and a record with loads recorded against it can't be deleted at all, because the loads and yields would lose their home. For farms, fields, and landowners, **Archive** is the safer choice: the record drops out of lists and pickers, and everything already recorded keeps its history.

## Common questions

- **Where do I start?** Upload your FSA farm records or a lease — that fills in entities, farms, fields, and plantings at once. Otherwise work top-down: entities, then farms, then fields, then crops and plantings.
- **Where is the Cotton switch?** Settings → Organization.
- **Something I deleted by mistake?** Contact support — deletes can't be undone from the app.

## If something looks wrong

- If reports group things oddly, check the farm's entity, county, and landowner assignments — most report groupings come straight from here.
- Anything else, contact support.

# Organization  (page: /settings/organization)

## What this page is for

How your operation appears on documents you send out, and the operation-wide **Cotton** switch.

## How to use it

- **Display name on documents**, **Address**, and **Contact line** — the Rent Settlement statement renders under exactly this identity (your name and logo, nothing else). Leave the display name blank to use your operation's name.
- **Logo** — PNG or JPG under 2 MB; a PNG with a transparent background looks best. Drop it on the card or use Upload logo.
- **Turn on Cotton for this operation** — adds the Cotton tab (seed cotton loads, gin receipts, bales and classing, cotton yields and marketing) for everyone in your operation. The tab appears after the next page load. Turning it off hides those pages and report sections; nothing is deleted.

## Common questions

- **Who sees the Cotton tab?** Everyone in your operation once it's on. A gin login sees only the Cotton intake pages either way.
- **Does the logo show inside Turnrow?** No — only on the documents you send out.

## If something looks wrong

- The Cotton tab didn't appear: load any page again.
- Anything else, contact support.

# Field Plantings  (page: /settings/plantings)

## What this page is for

A planting is a field, a crop, and a season together — "North 40, corn, 2026". Yields, crop insurance, and marketing reports are all built on plantings, so enter them once planting is done each spring (or upload your acreage report and let Turnrow do it).

## How to use it

- **Add a planting**: pick the field, the crop, the season year (use the harvest year), and the planted acres, with one or more varieties. Leave acres blank and the field's full acres fill in, shown as "from field acres" so you can override it.
- **Upload an acreage or planting report**, or bring in a spreadsheet. Both recognize variety spellings that differ only by brand prefix and ask whether to link or keep them separate, so "DG 3644" and "Dyna-Gro 3644" don't become two varieties.
- Filter by **season year** to work one year at a time.

## What the controls do

- **One row per crop** — a field that grew wheat and then double-crop soybeans is two rows for the same field and year, and both may claim the field's full acres. That overlap is normal; the form points it out as information, not a conflict.
- **Double-crop** pairs are worked out from the crops' harvest seasons (Settings → Crops).
- **Delete** removes a planting; if it was paired with a double-crop partner, the partner stays and is simply unlinked.

## Common questions

- **Which year is the season year?** The harvest year. Wheat planted in fall 2025 and cut in 2026 is a 2026 planting.
- **Plantings are read-only here.** Your land is managed in Turnrow Farm — change plantings there and they come across. Rows marked "not linked" were created here and stay editable.

## If something looks wrong

- A field shows no yield: check it has a planting for that season year and crop.
- Anything else, contact support.

# Landowner Shares  (page: /settings/shares)

## What this page is for

Landowner Shares connects a landowner's own software (Turnrow Landowner) to the fields they rent to you — read-only, only their farms, and only what you choose to share. You stay in control: each kind of information is a separate switch, and you can end a share at any moment.

## What's always shared, and what's up to you

Every share includes the landowner's **fields, plantings, and harvest progress** — the basic "what's growing on my ground" picture. Three more things are each their own switch:

- **Actual yields** — harvested results for their fields, as harvest is recorded.
- **Projected prices** — your projected average price per crop. This is **one number per crop and nothing more**: never your contracts, hedges, how much you've priced, or any cost or profit figures. Until you mark a crop year's selling finished (Settings → Crops), the landowner sees it labeled "projected"; after that it's labeled "final".
- **Projected yields** — your expected yield for the shared fields before harvest, with the irrigated/dryland split where a field has both. Once a field's harvest wraps up, the real number takes over, labeled "actual".
- **Rent statements** — the landowner's finalized rent statements from Turnrow Farm (they arrive here through the Turnrow Farm link under Settings). Only that landowner's own statements, exactly as finalized: never another landowner's, and never your costs beyond the cost-share lines the statement itself shows. Until your organization is linked to Turnrow Farm and a statement is finalized there, the landowner simply sees none.

**Projected prices, projected yields, and rent statements start OFF on every share** — including shares you created before these switches existed. Nothing you share changes unless you flip a switch yourself, and a change takes effect the next time the landowner's software checks in, usually right away.

## The preview — see exactly what they see

Open **Sharing & preview** on any share. The "What [your landowner] sees" panel is built by the very same part of Turnrow that answers their software, so it's not a mock-up — it *is* their screen. Flip a switch and the preview updates on the spot; anything you haven't shared shows the same "not shared" message they'd get. Use the year picker to check other crop years.

## Which of your entities they see

If you farm through more than one entity (an LLC and a partnership, say), the landowner sees **which entity farms each of their fields** — the entity on the farm the field belongs to (Settings → Farms). The preview's **Farmed by** line lists those entities with how many of the landowner's fields each one farms, so you can check the picture before they do.

When projected prices are on, the landowner gets the whole operation's average per crop **and** the same single number for each entity that farms their ground. An entity's price counts that entity's own contracts and hedges in full, and its share of anything marketed for the operation as a whole (including by a marketing entity) — in line with the Marketing report with that entity selected. It is still one number per crop per entity and nothing more. An entity that exists only to market (no farms of its own) never appears, and a crop with no price to show for an entity is left off rather than guessed.

## How to connect a landowner

1. Pick the landowner, choose your switches, and create the share.
2. A one-time code appears — copy it right then, it's shown only once, and it expires in 7 days if unused.
3. The landowner enters the code under **Connect a Farm** in Turnrow Landowner. The share shows **Connected** here once they have.

## Common questions

- **Can a landowner work out my marketing position from a shared price?** No. The price is a single average per crop with nothing behind it — no contract, hedge, quantity, or cost detail is ever available to them, shared or not.
- **How do I stop sharing?** Flip the switch off (that one kind of information stops immediately) or **End share** (their access ends entirely, right away).
- **Which fields do they see?** Only fields on farms linked to that landowner (Settings → Farms is where that link lives).
- **The preview says "no entity on these farms yet."** The landowner's farms have no entity set. Open each farm under Settings → Farms and choose the entity that farms it; the preview and the landowner's view update right away.
- **The preview won't load.** Try again in a moment; if it keeps happening, contact support.

# Trucks  (page: /settings/trucks)

## What this page is for

The truck list the load form offers, plus a separate list of **hauler trucks** — buyers' and hired haulers' trucks saved from pickup-contract loads.

## How to use it

- Type a name or number and **Add**. You can also add a truck without leaving the load form (**+ Add truck…** in its Truck dropdown).
- **Edit** to rename; **Delete** removes a truck no loads use. A truck with loads recorded can't be deleted — rename it instead.
- Bring in a whole fleet with the upload card or a spreadsheet.

## What the controls do

- **Renaming a truck won't change past loads** — they keep the truck name as it was entered. New loads use the new name.
- **Hauler trucks** never mix with your own list. Renaming or deleting one doesn't change loads already entered.

## Common questions

- **Two trucks with the same number?** Turnrow stops you adding a duplicate name — add the trailer or a letter to tell them apart.

## If something looks wrong

- A truck missing from the load form: check which list it's in — hauler trucks only appear on pickup-contract loads.
- Anything else, contact support.

# Varieties  (page: /settings/varieties)

## What this page is for

Every seed variety that appears on your plantings, grouped by crop, with how many plantings use each. It's the cleanup page for the spelling drift that creeps in over a few seasons — "DG 3644" here, "Dyna-Gro 3644" there.

## How to use it

- **Rename** a variety inline. Renaming onto a spelling that already exists **merges** the two — acres and bushels are combined per planting, and Turnrow tells you how many plantings change before it does it.
- **Find similar** lists pairs that look like the same variety. For each pair, pick which spelling survives and **Merge**, or **Keep both** so the pair isn't suggested again.
- **Delete** is only available for a variety no planting uses.

## Common questions

- **Will merging change my yields?** No — the same plantings and bushels are simply filed under one name.
- **A pair Turnrow suggested really is two varieties.** Press Keep both; the pair won't come up again.

## If something looks wrong

- A merge didn't finish: reload and check the rows before trying again.
- Anything else, contact support.

# Settlements  (page: /settlements)

## What this page is for

Settlements is where buyer settlement statements live — the paperwork that says which loads a buyer paid for, at what bushels and dollars. Entering settlements is what turns a load's badge from Unpaid to Paid, and it's how Turnrow catches loads the buyer shorted, missed, or never paid.

## How to use it

- The list shows each settlement with its buyer, date, line count, how many lines still need matching to loads, net bushels, and net revenue — plus a link to the original document. Tap any row to open the settlement's own page. The filters (search, dates, buyer, entity, crop year, contract) apply as you change them and are remembered for next time.
- To enter one, tap New Settlement. Three ways to get the lines in:
- **Upload the statement** — a PDF or a photo. Turnrow reads the settlement number, date, buyer, and every line (ticket number, net bushels, gross revenue, discounts) into editable rows for you to review before saving. It also itemizes each deduction the statement shows — drying, test weight, dockage, and the rest — into its own discount lines, however the buyer formats them (named charges, footnote codes, or a combined "less discounts" total, which stays labeled as written rather than being guessed into a category). A deduction taken as **weight** instead of dollars — pay bushels quietly reduced below gross — is captured as a weight line; Turnrow values it from your own load reconciliation so it's never counted twice. A warning shows if the itemized dollar lines don't add up to the statement's discount total.
- **Upload a spreadsheet** — columns for ticket number, net bushels, gross revenue, and discounts (a template is downloadable).
- **Type the rows** by hand. Need a buyer that isn't on the list yet? Pick **+ Add new…** in the Buyer box and it's created right there.
- As you review, each line shows whether its ticket number matches one of your loads. A line with no match offers **Pick the load…** — the buyer's recent loads — so a ticket the buyer renumbered can still be tied by hand. Save, and the settlement is recorded with its lines tied to loads. Save is always available; if something is missing (no buyer, no date, no lines) the form points at it instead of greying the button out. Should part of the detail fail to save after the settlement itself is recorded, you land on the settlement's page with a note saying what to add there.
- **Already entered? Turnrow says so before you save.** As the lines fill in, each one is checked against every settlement already saved. A line whose load is already on a saved settlement — or whose ticket number is already on one of this buyer's settlements — turns red and says **Already paid**, naming the settlement (tap to open it) with a **Leave it out** link. A red notice above the table sums it up: either *This settlement is already in Turnrow* (same buyer and settlement, check, or payment number as one you saved, or every load already paid) or *N of M loads on this statement are already paid*. Save still works, but it asks you to confirm first, because saving again would count that money twice on the Cash Flow and Contracts pages. This catches the same PDF uploaded twice, a statement re-sent by the buyer, and a check stub that repeats an earlier settlement.
- **Totals and check stubs are not loads.** Settlement packets often end with a check stub that restates the whole settlement ("58,118.929 bu … REF 16936 … 289,432.26"), and many sheets print a TOTAL row under the tickets. Turnrow tells the reader to skip those, and checks its work: a line whose bushels or dollars equal all the other lines added together, whose "ticket number" is really the settlement's own reference or check number, or whose bushels dwarf every other load is shown in amber as **Left out: looks like the settlement total — not a load**, unchecked and not counted. If the guard is ever wrong, tick **Include it** and the line comes back. The settlement's own grand total is read separately and shown under the table next to the sum of the ticket lines, so you can see at a glance whether they match.
- Open a settlement anytime to see its reconciliation page.

## The settlement detail page

Open a settlement and everything about it is on one page: the header (editable with **Edit**; **Delete** removes the settlement and its lines after a confirmation, sending its loads back to Unpaid), the original document (a PDF or photos — photos are stored as one PDF), net revenue up front with gross, discounts, and the matching counts beside it, and the sections below.

**The Discounts block** shows every deduction as its own line — the type, the statement's own wording, the dollars, and what it works out to in cents per settled bushel — then walks the price: gross $/bu, less quality discounts ¢/bu, less checkoff, less fees, equals net $/bu.

**Checkoff and fees are not quality discounts.** A checkoff (the promotion assessment, under whatever name the buyer prints — "check-off", "National Check-Off", "assessment", a soybean or corn board or commission) and service charges (vehicle inspection, grading, unload, administrative fees) get their own categories. They are listed outside the quality discounts, they never count against a buyer in Ask Turnrow's buyer comparisons, and the settlements list and the Season Summary report total **Checkoff paid** by crop and crop year, in dollars and cents per bushel. Some states refund checkoff on request — that total is the number to claim. Uploaded statements categorize these automatically; on a hand-entered settlement, add a Checkoff or Fees line in the Discounts block. It also shows the **weight deduction beyond standard shrink**: the buyer's pay bushels compared against your FSA-standard dry bushels, priced out — a real cost the price discounts never show. Statements entered by hand, or ones the upload couldn't fully itemize, can have discount lines added or corrected right here; these lines feed Ask Turnrow&rsquo;s buyer-discount comparisons.

Three sections do the reconciling:

- **Matched loads** — lines tied to a load, showing your dry bushels beside the buyer's net bushels. The difference is green when they paid on more than you weighed and red when less; anything over 1% either way is bolded so you can see where their scale or grading disagrees with yours. The load date opens the load.
- **Unmatched lines** — settlement lines Turnrow couldn't tie to a load. Two kinds: **Ambiguous** (the ticket number matches more than one of your loads, so it needs you to pick) and no match at all (you may never have entered that load). Each unmatched line has a dropdown to match it to the right load by hand.
- **Missing loads** — loads you delivered to this buyer in the contract's delivery window that appear on no settlement yet. These are the loads you haven't been paid for. Each row links to the load and its contract, and **+ Add line** puts the load on this settlement already tied and filled with your dry bushels, so you only type the dollars from the statement.

Matches are remembered: once a line is tied to a load — automatically by ticket or by your manual pick — that load shows Paid everywhere in Turnrow.

## How the numbers work

- **Net revenue** = gross revenue − discounts, per line; the settlement totals sum its lines.
- **How matching works.** Your ticket numbers often carry the buyer's ticket inside your own numbering (498074 stored as 498074-02-A or 12-498074), and buyers print theirs with leading zeros (0498074). Matching tries three things in order: an **exact** match after tidying (spaces, case, leading zeros); a **segment** match, where the buyer's ticket — or the buyer's load-order number — equals one dash-separated part of yours (parts shorter than four characters never count, so "02" can't match anything); and, when the numbers don't line up at all, a match by **date + weight** — same crop and buyer, delivered within a day, bushels within 1% of your dry bushels (or the exact gross and tare), backed up by the truck's license plate when the statement prints one. **Short ticket entries match too**: some buyers print long ticket numbers (530092988) and your driver writes only the tail ("2988-12", "92988-A"). When the last five or more digits of your ticket number are the last digits of the buyer's ticket, that is a match on its own (with a "check" chip until something else agrees). When only four digits agree, Turnrow also needs the delivery date within a day, the net pounds or bushels within 1% (an exact pound figure is a strong sign), or the statement's vehicle id naming your truck or driver. Any of those agreeing makes it a sure match. Three digits or fewer never match this way, and if two tickets on the statement — or two of your loads — end in the same digits, you pick. On the upload review each match shows how it was made; exact matches are certain, the others are one click to reject ("not this load"). When several loads fit, you pick. Once you save, every load matched by anything other than your own exact ticket keeps the buyer's full ticket number beside yours (your number is never changed), so the next statement — and the Paid badge — match exactly; a load matched by date and weight with no ticket at all gets the buyer's ticket as its own; a load's blank moisture or test weight fills in from the statement's grade block.
- **Statement details kept.** Each line stores the buyer's grade readings (the printed grade such as "1 US #1", moisture, foreign material, splits, damage, test weight, protein…) and its net pounds, the header contract number links the settlement to your contract, and the check page's payment number, check number and date are stored — never mistaken for tickets. When the statement prints a **contract summary** (bushels priced, settled so far, remaining), Turnrow compares the buyer's remaining bushels with its own contract progress and shows a notice when they disagree by more than 1% — a load missing on one side, or counted twice. A per-ticket **Checkoff / SPARC** line is filed as checkoff with the agency named, and a **Special Discounts** legend (Sour, Heating, DLQ, Aflatoxin…) maps each code to its discount type; Totals rows, the Deduction Summary and the Remit amount are never read as tickets. Rows labelled Total, Contract Total or Settlement Total are left out, and the lines are reconciled to the statement's printed totals.
- Sideways or upside-down scans are straightened before reading; a photo page can be rotated with the ↻ button on its thumbnail.
- The paid/unpaid badge on the Loads page comes straight from this matching — a load is Paid when a settlement line is tied to it.

## Common questions

- **It says the settlement is already in Turnrow, but this is a different check.** Some buyers reuse settlement numbers across crop years, or pay one statement in two checks. If the loads on the lines are not marked Already paid, save anyway — the warning is about the header numbers only. If the loads are marked paid, open the named settlement first and compare.
- **The upload read my statement wrong.** Fix any cell in the review rows before saving — nothing is recorded until you save. The original document stays attached either way.
- **Why is a line Ambiguous?** Two or more of your loads share that ticket number. Pick the right load from the line's dropdown; consider correcting the duplicate ticket on the loads themselves.
- **A load shows Unpaid but I have the check.** The settlement covering it hasn't been entered, or its line didn't match — check the ticket numbers on both sides, or match it by hand on the settlement page.
- **Their bushels don't match mine.** Small differences are normal (their shrink and dockage math). The page flags anything over 1% so you can decide whether to call the elevator.
- **Can I attach the original statement?** Yes — uploading the PDF or photos stores it with the settlement, viewable from the list and the detail page.

## If something looks wrong

- Unmatched lines piling up: compare ticket numbers character for character — a leading zero or a typo on either side breaks the match.
- Missing-loads section lists a load you know was paid: it's probably on a settlement you haven't entered yet.
- Totals that won't reconcile after that: contact support.

# Uploading Documents  (page: /settings/uploads)

## What this is for

Most of what Turnrow needs to know about your operation is already written down somewhere — leases, FSA farm records, plat maps, acreage reports, handwritten field lists. Instead of retyping them, upload the document and Turnrow reads it for you.

## How to use it

- Every setup page (Entities, Landowners, Farms, Fields, Plantings, Buyers, Bin Sites, Trucks) has an **Upload** card — use the one closest to what you're holding, or the **Upload any document** card at the top of Settings when you're not sure where something belongs. The new-operation checklist on the home page starts with exactly that: upload your FSA-578 or 156-EZ, or a lease, and entities, farms, fields, and plantings fill in together.
- Upload a PDF, a spreadsheet, or photos (snap multiple pages from your phone). Then review what was found.
- **Every upload spot is a drop target, and looks like one.** On a computer each one is a dashed card that says **Drag & drop files here, or click to browse**, with the file types it takes underneath (PDF, photos, CSV, Excel — whatever that spot accepts). Drag a file from your desktop or a folder onto the card — it turns green while the file is over it — or click anywhere on the card to open the file browser. The file uploads exactly as if you had picked it with the button. Small spots (the support-form screenshot, your logo) use a slimmer version of the same card. On an iPad or phone the card reads **Tap to choose files** instead, because dragging needs a mouse or trackpad. This applies to every upload in Turnrow: the AI document uploads here and on their own pages (policies, FSA records, brokerage statements, settlements, gin receipts, weight tickets, classing files, cotton marketing documents, seed contracts, discount schedules, leases), the spreadsheet importers, attachments on loads and contracts, your logo, and the screenshot on the support form. Several photos can be dropped together where several are accepted; a file of the wrong kind is refused with the same message the button would give. On an iPad or phone, keep using the buttons — dragging needs a mouse or trackpad.

## What the AI looks for

One upload reads the WHOLE document, not just the page you started from. A lease, for example, usually names the landowner, the farm, and the share or cash-rent terms — all three land in your review, each grouped under the place it belongs, with the line of the document it came from shown beside it. Documents it handles well: lease agreements, FSA farm records (156EZ), plat maps and field lists, planting/acreage reports, insurance schedules, and plain lists — typed or handwritten.

## Large documents

- A long document (a thick FSA packet, a statement with pages of lines, a big photo batch) is read a few pages at a time — you'll see the progress as it goes ("Reading pages 9–16 of 24…"). This works the same on every upload button in Turnrow.
- Something that appears on two of those page groups — the same farm, the same ticket — is recognized as one record, not two.
- If a hiccup stops one group of pages, Turnrow retries it automatically. If it still can't be read, you keep everything that WAS read, with a note naming the pages that weren't — upload just those pages again rather than starting over.

## Everything requires your confirmation

- Nothing is saved until you check it and press Save. Every row shows whether it's **already in Turnrow**, an **update** to something you have (with exactly what would change), **new**, or a **possible match** you must decide on.
- Records that belong together save together — if a lease creates a landowner and their farm at once, the farm is linked to that landowner automatically. If anything fails partway, nothing from that upload is kept, so you can fix the problem and try again.
- Uncheck anything you don't want. Unchecking something other rows depend on skips those rows too, with a note saying why.

## Common questions

- **The AI read a number wrong.** Leave that row unchecked and enter it by hand — or fix the source document and upload again. Re-uploading shows updates against what saved the first time, not duplicates.
- **It found things I didn't expect.** That's the point — a lease mentions more than landowners. Collapsed sections below your main one show counts of everything else found; open them or ignore them.
- **Does it replace typing things in?** No — every page keeps its normal add form and spreadsheet import. The upload is a head start, not the only door.

## If something looks wrong

- Blurry photos read poorly — retake in good light, one page per photo.
- If a document extracts nothing, it may not contain settings information — numbers-only reports (settlements, brokerage statements) have their own upload buttons on their own pages.
- Anything else, contact support.

# Users  (page: /settings/users)

## What this page is for

Who can sign in to your operation and what each person sees. It's how you give your gin a place to key in seed cotton loads without seeing your finances, give a landlord read-only reports for their own farms, or give your agronomist the whole operation's yields without any of the money.

## How to use it

- **Add a person**: enter their email, choose what they should see (nothing is pre-selected — the Send button stays off until you choose), and press **Send invitation**. They get an email with a set-your-password link and land in your operation with that access. **Get a link instead** creates the same one-time link without sending an email, so you can text it yourself.
- Choosing **Landlord or stakeholder** asks which entities they may see — pick at least one.
- **Change what someone sees** from their row: press **Edit**, pick the new access (and entities, for a landlord or stakeholder), and Save.

## What the controls do

The four kinds of access, in plain terms:

- **Farm owner or manager** — everything: loads, contracts, reports, settings, and this page.
- **Gin** — enters seed cotton loads, gin receipts, and bales only. No dollars, no reports, no settings.
- **Landlord or stakeholder** — read-only reports and yields, limited to the entities you pick. They see only those entities' share of the numbers; whole-operation pages with no entity split (like the bundled settlement statements) are hidden from them. When they try what-if values — assumed prices, yield assumptions — those changes are private to them and never touch your real numbers.
- **Agronomist** — the Yields page only, for the whole operation: yields by field, farm, entity, variety, and landowner, down to the load. Nothing financial, ever, and no entity checkboxes needed.

The **Cotton** switch for the whole operation is on Settings → Organization.

## Common questions

- **Why can't I change my own access?** Your own row is locked on purpose. If the last owner stepped down, nobody could manage people anymore. Have another owner change it, or contact support.
- **Send invitation or get a link — which should I use?** Send invitation is the easy path. Use the link when the person's email is unreliable or you'd rather text it — it's their one-time set-a-password link, so treat it like a key.
- **Can a landlord see other landlords' numbers?** No. They see only the entities granted to them, and only in read-only reports.
- **Landlord or agronomist — what's the difference?** A landlord or stakeholder sees reports and yields for just the entities you pick. An agronomist sees yields for the whole operation, but only yields: no reports, no dollars anywhere.
- **Someone needs both cotton intake and reports.** Each person has one kind of access. Give them owner or manager if you trust them with everything — there's no combined option.
- **They already have a login.** Sending an invitation to an email that already exists tells you so — use Get a link instead, or change what they see from their row.

## If something looks wrong

- If an invited person never got the email, press **Get a link instead** and send it to them directly.
- If a landlord reports missing numbers, check which entities are picked on their row.
- If your agronomist says a page keeps sending them back to Yields, that's their access working as designed — Yields is their whole app.
- Anything else, contact support.

# Yields  (page: /yields)

## What this page is for

Yields turns your load log into bushels per acre. The same production can be viewed five ways — by field, by farm, by entity, by variety, or by landowner — for any season. It's where you compare fields, settle up with landowners, and see how irrigated ground did against dryland.

## How to use it

- Pick a view from the tabs under the title: **By field**, **By farm**, **By entity**, **By variety**, or **By landowner**. The Reports page's "Yields by Field" and "Yields by Farm" cards open straight onto the matching tab.
- One filter row serves every tab: crop year, crop, farm, entity, and county. In the by-field view you can also filter to irrigated or dryland ground; the landowner tab adds a landowner pick. Your filter choices are remembered, so the page comes back the way you left it.
- Toggle between **Total yield only** and **Irrigated / Dryland breakdown** to split the yield columns by practice.
- **Tap any row (or its ▸ button) to open its detail.** A field row shows the loads behind its yield; a farm, entity, landowner, or variety row shows its totals plus a field-by-field breakdown, and each field there opens further into its loads — two taps from a landowner (or a variety) to a scale ticket.
- Bushels show as whole numbers and acres to one decimal, the same as every report.
- Export any view to a spreadsheet or a formatted report — the export carries exactly the columns you're showing on screen, and when a row's detail is open the export adds a Load Detail sheet for it.

## Reading the table

- Each view lists **Yield (bu/ac)** right after the acres, with **Dry bu** last — so the number you're usually after is visible without scrolling sideways on a phone or iPad.
- A field with no loads yet carries a **not harvested** badge and shows a dash for its yield and bushels rather than a zero. A field partway through carries an **in progress** badge.
- When the Cotton module is on, cotton fields are not listed in the grain tables at all — their yield is pounds of lint, shown in the **Cotton** section at the bottom of the page. A short note above the table says how many were set aside.
- On the variety tab, multi-variety fields that still need their bushels split are tucked into a **Needs attention** panel above the table; tap it to open the list.

## What the controls do

- **Harvest status.** A field that hasn't been harvested, or is only partway through, is left out of the yield math — a half-harvested field would drag every average down. In-progress fields are labeled so you can see they're pending. If a field really is done but Turnrow can't tell (say the last loads went straight to town under a different crop year), tap **Count anyway** on that field. Turnrow asks you to confirm, then treats the field as finished — it looks like every other completed field and its bushels go into the averages. Open the field's detail and tap **Undo** to put it back to automatic. Two things earn an in-progress label. First, **your current field counts as still going until you move to the next one or harvest goes quiet**: the field with loads and no later load on any other field of that crop is the one the combine is sitting in, so it reads in progress whatever its yield — even a perfectly normal one — until a later-dated load lands on another field, or about ten days pass with nothing hauled from that crop anywhere. (Loads carry a time of day, so when you switch fields mid-afternoon the field hauled later is the current one and the earlier one counts; if a load's time is missing, both fields are treated as current until the next day's loads settle it.) Second, once you've moved on, a field whose yield runs well below what's normal for the crop keeps its in-progress label. "Normal" is the crop's other harvested fields — and early in harvest, when there's little or nothing to compare against yet, it's the yield estimate you entered in the Marketing assumptions. That low-yield label is deliberately sticky: cutting a few loads, moving to another field for a while, and coming back later is normal, so loads landing on other fields never mark a low field finished — and as long as loads for the crop are still coming in anywhere on the operation, a low field stays in progress no matter how long since its own last load. A low field only counts once you tap **Count anyway** or mark the crop's harvest complete — or after about ten days pass with nothing more hauled from that crop at all, which means harvest is genuinely paused or over. A field yielding in line with the rest counts as soon as you've moved to the next one. The last field of the season never gets a "next one," so it counts when harvest goes quiet — or right away with **Count anyway**. If a field truly finished with a poor yield — a real crop failure — Turnrow can't tell that apart from a field you'll come back to, so use **Count anyway** to put its number in the averages.
- **Allocate irr/dry.** A field with both irrigated and dryland acres has one pile of bushels but two practices. There are two ways to split it. The easy way: tag each load Irrigated or Dryland as you enter it — when every load on the field carries a tag, the split comes straight from the loads (the row shows **From load tags ✓**) and you're never asked to allocate. Otherwise, once the field's harvest is complete, an **Allocate irr/dry** button lets you split the field's dry bushels between the two — type one side and the other side fills in so the split always totals the field's bushels. If some loads are tagged, the allocation opens pre-filled from those tags so you only complete the remainder. A manual allocation, once saved, stays in charge even if load tags change later — clear it to go back to using the tags. Until the field is split one way or the other, it counts in the overall total but sits out of the irrigated and dryland columns.
- **Allocate bushels (varieties).** A planting with a single variety credits all its bushels to that variety automatically. A planting with two or more varieties uses your per-variety bushel allocation when you've entered one; until then, its bushels are **estimated by each variety's share of the acres** and badged **"acre-share est."** wherever they appear — the page still lists the plantings that need allocation once their harvest is complete, and allocating replaces the estimate with your real split.
- **Variety detail.** Tap a variety row for its summary (acres of that variety, loads, dry bushels, yield, weighted moisture and test weight, harvest window, where the grain went) and a field-by-field table — each field showing the acres of *this* variety on it and the bushels attributed to it. On a field growing several varieties, the bushels carry a badge saying how they were attributed: **allocated** (your per-variety split) or **acre-share est.** (estimated until you allocate). Open a field there and you'll see every load off that field, with a note of how much of it belongs to this variety. Cotton varieties show gin receipts, bales, and pounds instead of grain loads. The moisture and test-weight averages weight each field's loads by the variety's share of that field, so a variety on a shared field only counts its portion.
- **By landowner** groups production by the landowner on each farm, split-aware, for rent conversations and year-end summaries.
- **Row detail.** The detail's summary line shows load count, total pounds, wet and dry bushels, the average moisture and test weight (weighted by each load's pounds, so an 80,000-lb pair at 16.0 and 18.0 moisture averages by weight — not a simple midpoint), the first-to-last load dates, and how the bushels split between bins and buyers. The load list carries date, ticket, truck, weights, moisture, test weight, and destination; a load split across fields shows just this field's share with a badge like "split — 14,200 of 34,300 lbs". Fields flagged in-progress carry the same flag on their detail, so the list always matches the number above it; a field you counted as finished shows a small note there with the Undo. Cotton fields show gin receipts, bales, turnout, and loan values in pounds instead of grain loads.

## Tracking harvest without scales

- A field entered with **Yield from Combine** (on the Loads page) shows here exactly like a weighed field — its production is the combine entry's adjusted total, and the row works in every view, filter, and export.
- Its detail opens with a labeled **Combine entry** line above any weighed loads, showing the adjusted total and the netting: weighed loads are subtracted from the combine figure, and the remainder is what sits in storage (in the destination bin, if one was picked). The weighed loads keep their own rows — tickets, weights, destinations — they're just never counted twice.
- The entry's **"Harvest complete"** checkbox decides whether the field counts now: checked, the field is done and its yield is in the averages; unchecked, it shows as in progress until you finish it.
- If the weighed loads from a field total more than its combine entry, the detail shows a warning instead of quietly hiding the difference — check the entry or its adjustment.
- Mixed irrigated/dryland fields entered by combine allocate the same way as everyone else: enter the split on the combine entry if the monitor shows it, or use **Allocate irr/dry** here after harvest.

## How the numbers work

- **Yield = dry bushels ÷ planted acres.** Bushels come from your loads (shrunk to dry at each crop's base moisture) — or from the field's combine entry where you used one — matched to a planting by field, crop, and crop year. Acres come from the planting.
- In the breakdown, a field that's all irrigated or all dryland reports its whole yield under that practice; mixed fields use the split from their load tags or your manual allocation — every report (insurance, claims, per-practice yields) reads the same split either way.
- Farm, entity, and variety views are the same math rolled up — the totals foot back to the by-field view under the same filters.

## Common questions

- **Why is a harvested field missing from the averages?** Turnrow still sees it as unharvested or in progress. Check that its loads carry the right field, crop, and crop year — or use Count anyway.
- **Why is the irrigated column blank for a field I know is irrigated?** It's a mixed field without a complete split yet. Tag its remaining loads Irrigated/Dryland, or Allocate irr/dry once it's finished.
- **My yield looks too low.** Usually acres: check the planting's acres, and check for loads recorded against the wrong field or year.
- **Do bin loads count?** Yes. Any load leaving the field counts toward that field's production, whether it went to a bin or to town.
- **A variety I planted isn't in the variety view.** The variety was never recorded on the planting under Settings → Plantings — or it's on a multi-variety planting with no acres recorded per variety, which leaves nothing to estimate from until you allocate bushels.
- **What does "acre-share est." mean?** A field growing several varieties hasn't had its bushels allocated yet, so that variety's share is estimated from its share of the acres. Allocate bushels on the planting and the badge goes away.

## If something looks wrong

- Check the crop year and filters first — last visit's filters are remembered and are the usual culprit.
- Compare the field's loads (Loads page, filtered to the field and year) against the bushels shown.
- Verify planted acres and varieties on the planting.
- If the views won't foot after that, contact support.
