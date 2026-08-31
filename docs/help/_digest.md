# Turnrow capabilities digest

Generated 2026-08-31 · version 0.1.0 · build d741fc7. Compiled from docs/help — regenerate with `npm run help:build`.

# What Turnrow does NOT do

Turnrow tracks grain and cotton from the field through storage, contracts, settlements, hedging records, crop insurance, and government programs. It deliberately does not do the following — if someone asks, say so plainly and don't improvise a workaround:

- **No accounting or taxes.** Turnrow is not a bookkeeping system. It projects revenue and profit for planning, but it does not produce a P&L, balance sheet, or anything for a tax return.
- **No marketing advice.** Turnrow records your contracts and hedges and shows your position. It never recommends when or what to sell.
- **No agronomy.** No seed, chemical, or fertility recommendations; no scouting or spray records.
- **No field maps or GPS.** Fields are records with acres, not drawn boundaries. No equipment or planter/yield-monitor connections.
- **No weather.**
- **No bank or brokerage connections.** Brokerage statements and buyer settlements come in as uploads you review — nothing links to an account automatically.
- **No payroll, HR, or equipment maintenance tracking.**
- **No app-store app.** Turnrow runs in the browser and can be added to a phone or iPad home screen from the browser's share/menu button.
- **No automatic price alerts or texts.** Market prices appear on-screen when pages load.
- **US grain and cotton, US dollars, US programs only.**
- **No self-serve signup.** New farms and new users join by invitation.

# Ask Turnrow  (page: /assistant)

## What this is for

Ask Turnrow answers questions about **your own account's numbers** in plain English — "What's my average corn price this year?", "Which field yielded best?", "What's sitting in the bins?". It reads the same data your reports do, so its answers match what the report pages show. It also answers how-do-I questions about using Turnrow, and keeps the two kinds of answers clearly separate.

## How to use it

- Open the **?** in the top bar and pick the **Ask Turnrow** tab, or open the full page from that tab.
- Type a question, or tap one of the suggested starters. Answers stream in; while it's checking your records you'll see what it's looking at ("Checking your yields…").
- Every data answer notes it came **from your Turnrow data as of that moment**, with links to the report where you can verify the same number.
- If your question could mean two things ("how much corn do I have" — in the bins? unsold? total production?), it asks which you mean instead of guessing.

## What it can answer

Marketing and average prices, yields by field/farm/crop/landowner, revenue projections, contract delivery progress, hedge positions, crop insurance estimates, government payment projections, grain cash flow, recent loads, and bin inventory — plus long-tail questions it can look up directly in your records. It always shows units and the crop year it used, and it never makes up a number: if the data isn't there, it says so.

## Who can see what

- The assistant only ever sees **your account's own records** — that separation is enforced by the database itself, not by the assistant's good manners. Nothing you ask or see is visible to any other operation.
- Each user's answers follow their own role: a viewer's assistant sees only their granted entities; an agronomist's only yield data.

## Common questions

- **Is this the same as the help chat?** The Ask Turnrow tab answers questions about *your data*; the How-to chat answers questions about *using the software*. Ask Turnrow can handle both, and labels which is which.
- **Why does it say a year I didn't ask about?** If you don't name a crop year it uses your most recent one with data — and tells you which.
- **It says it hit a lookup limit.** One question gets a handful of data checks; ask a follow-up and it keeps digging.
- **How many questions can I ask?** There's an hourly cap to keep things snappy — if you hit it, give it a little while.

## If something looks wrong

- If a number surprises you, open the linked report — that page is the source of truth, and the footer on each answer links straight to it.
- Numbers that involve live futures quotes can differ slightly from the report pages: the assistant uses your stored positions and assumptions, and the reports layer live quotes on top.
- Anything else, contact support.

# Bin Inventory  (page: /inventory)

## What this page is for

Bin Inventory shows the dry bushels sitting in each bin right now, grouped by bin site. It's a live snapshot built from your load log: every load hauled into a bin adds, every load hauled out subtracts, and bin-to-bin transfers move grain between bins. Each site shows its bin count, total bushels, and a per-crop breakdown, so you can see at a glance what's on hand and where.

## How to use it

- Skim the site headers for totals, then the bin cards under each site for what's in each bin by crop.
- Use the **entity**, **site**, and **crop** dropdowns to narrow the view, then tap **Apply**.
- Bins with a capacity set (under Settings → Bin Sites & Bins) show a **percent-full bar**: green when there's room, amber above about 90%, and red at or over capacity. Since inventory is an estimate, an over-full bin shows ">100%" rather than pretending it stopped at the brim. Bins without a capacity just show their bushels, same as always.
- Site headers roll capacity up too: the bar compares the grain in that site's capacity-rated bins against their combined capacity. If some bins at the site have no capacity set, a note says they're left out of the percentage.
- **Transfer grain** records grain moved from one bin to another — for example, out of a wet bin into a dry bin after drying. Pick the from bin, to bin, crop, and date, then either type the bushels or estimate them from run time.
- When you first start with Turnrow and a bin already has grain in it from before your load records begin, tap **Add beginning inventory** on that bin and enter the dry bushels (with an as-of date and a note). That grain then counts until the bin is next emptied.
- When a bin is cleaned out, tap **Empty bin**. Turnrow shows you what it thinks is in the bin, asks you to confirm, and records a cleanout adjustment that zeroes it. That keeps small leftovers from shrink and scale drift from accumulating year over year.
- **Export CSV** downloads the current view as a spreadsheet, including each bin's capacity and percent full.

## Transferring grain between bins

- Tap **Transfer grain** at the top of the page (or on a bin's card to start from that bin). The crop defaults to whatever the from-bin holds the most of, and the date defaults to today.
- **Two ways to enter the amount:** type the bushels directly, or switch to **Estimate from run time** and enter your auger or leg's throughput (bushels per hour) and how long it ran. Turnrow multiplies them — 850 bu/hr for 2.5 hours is 2,125 bu — and drops the result into the bushels box, where you can still adjust it. Turnrow remembers the last throughput you used so you don't retype it.
- If you transfer more than the from-bin shows on hand, Turnrow warns you but lets you continue — bin inventory is an estimate, and you may know better than the math. If you see that warning often, a load or transfer is probably missing.
- Each bin's card lists its transfers under **Transfers** — tap to expand. Estimated transfers show the throughput and hours behind the number. You can edit or delete a transfer there; both bins recalculate automatically.
- Transfers only move grain between bins. They never change yields, production, contract deliveries, or marketing numbers — those all come from loads.

## What the controls do

- **Entity** shows only sites belonging to that entity; **Site** narrows to one site; **Crop** shows only that crop's rows in each bin.
- **Empty bin** doesn't delete any loads — it records an offsetting adjustment dated today, so your load history stays intact.
- **Add beginning inventory** takes dry bushels, an optional moisture, an as-of date, and a note. Bins carrying an active beginning inventory show it called out on the card, and the card breaks the total into load-backed bushels, transfers, and beginning bushels so you know how much is measured versus carried in.

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

- Each row shows the buyer, type, crop year, delivery location and window, contracted versus delivered bushels, percent delivered, price, revenue, and paid versus unpaid bushels.
- Tap a contract to open its printable detail page: the full terms, every load delivered against it (your dry bushels beside the buyer's settled net bushels), attachments, and actions to mark it complete or delete it.
- Create contracts under Settings → Contracts — typed in, from a spreadsheet, or by uploading the contract document for Turnrow to read and pre-fill.
- Attach the signed paper contract on the detail page so it's always at hand.

## Contract types in plain words

- **Forward (cash)** — both the futures price and the basis are locked. Your price is set; all that's left is delivery.
- **HTA (hedge-to-arrive)** — the futures price is locked, the basis is still open. Your price moves with local basis until you set it.
- **Basis** — the basis is locked, the futures price is still open. Your price moves with the futures market until you set it.

When you later set the open leg — an HTA gets its basis, or a basis contract gets its futures — the contract shows as Forward, because at that point both legs are locked and it prices like one. The pricing status (fully priced, awaiting basis, awaiting futures) is shown and filterable on the list.

## What the controls do

- **Filters stay put** — entity, crop, crop year, type, pricing, and the hide toggles are remembered: leave the page and come back and your last view is waiting. **Clear filters** (shown whenever any filter is on) resets to everything.

- **Date sold** — an optional date on each contract recording when you made the sale. Informational: it prints on the contract page and exports, and doesn't change any delivery or payment math.

- **Filters** narrow by type, pricing status, crop year, and more; **Hide completed** tucks away finished contracts.
- **Warnings** appear at the top for contracts approaching risk: an HTA or basis contract with pricing still open whose contract month's first notice day is within 30 days (or already past), and contracts whose delivery window ends within 14 days. Both warnings stop once a contract is completed — marked complete or fully delivered — since there's nothing left to price or deliver.
- **Entity** on a contract is optional. If your operation has one entity, Turnrow fills it in for you — you'll see it on the form but won't need to touch it. With more than one entity, leave it blank when the contract belongs to the operation as a whole, or pick an entity when one company holds the contract in its own name. If your operation markets everyone's grain through a single marketing company, put that company on the contract — entity-filtered reports then share its bushels out to the farming entities by their share of the acres.
- **Orphan-load warnings** flag delivered loads that aren't tied to any contract, so bushels don't slip through unpriced.

## How the numbers work

- **Delivered** counts the loads attached to the contract. **Remaining** = contracted − delivered.
- **Revenue** = contract price × contracted bushels, for priced contracts.
- **Paid / Unpaid bushels** come from settlements: delivered loads whose tickets have settled count as paid; delivered-but-unsettled loads count as unpaid.

## Common questions

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

- **Seed Cotton Loads**: record each module or trailer load in pounds of seed cotton. Enter loads manually (the form remembers your crop year, and net weight fills in from gross minus tare), or use the **AI Module List upload** — a photo or PDF of the gin's module list becomes editable rows, one load per page, with the farm matched by FSA number first and producer name second. Review, correct anything, and save the batch. The **Yard Inventory** section shows pounds delivered that aren't on any gin receipt yet — your cotton sitting on the yard waiting to be ginned.
- **Gin Receipts**: when the gin sends a Statement of Ginning, enter it here — several can apply to one field. Manual entry works, but the **AI upload** reads the whole document: modules, seed cotton pounds, bales, lint pounds, cottonseed pounds, turnout, the load table, and the full bale list across every page. The review screen matches the receipt to your farm and field, matches its load lines to your recorded loads by load number (you can create a missing load right there), and flags any difference between the gin's stated bale count and the bales actually captured. Nothing saves until you confirm.
- **Bales & Grades**: import your classing data as a CSV file. Rows are matched to bales by **PBI number** (leading zeros don't matter), net weights are cross-checked against the receipt, and rows that don't match a bale are held visibly so you can resolve them after later receipts arrive.

## What the controls do

- **Upload buttons** — every AI upload lands on a review table first; you always confirm before anything is saved.
- **Create missing load** — on gin receipt review, adds a load line the gin has that you never recorded.
- **Yard Inventory** — delivered pounds minus ginned pounds, by field.

## How the numbers work

- Cotton weights are plain pounds — no moisture or shrink math like grain.
- **Turnout** is lint pounds divided by seed cotton pounds, from the gin receipt.
- Lint yield per acre is the field's bale net weights (from its receipts) divided by planted acres; the app also shows seed cotton pounds per acre alongside.
- Each bale's loan value in cents per pound comes from its classing data and feeds the Bale Quality report and CCC loan figures on the Marketing page.

## Common questions

- **Why can't the gin operator see Marketing?** The Marketing page is owner-only by design — gin logins get the three intake pages and nothing more.
- **Why don't I see the Cotton tab at all?** The Cotton module is off. An owner can enable it under Settings, Users & Modules.
- **A classing row didn't match a bale.** Its receipt may not be entered yet — unmatched rows wait visibly and can be matched later.

## If something looks wrong

- Bale-count mismatch flags on a receipt mean the stated total and the captured bale list disagree — recheck the document pages.
- If a load won't match, compare load numbers between the module list and the receipt; each load number is unique within a crop year.
- Anything else, contact support.

# Crop Insurance Settings  (page: /settings/crop-insurance)

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
- **Winter crops run on an earlier calendar.** Fall-planted crops (winter wheat, canola) get their projected price the summer BEFORE planting and their final harvest price at early-summer harvest — so by fall both prices already show as RMA finals, with last year's dates on the windows. That's correct, not stale. Turnrow picks the winter offer automatically for spring-harvested crops; if your state carries both Winter and Spring offers, the "RMA type" selector on Settings → Crops pins the right one.
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

The home page is your launcher. The big green **New Load** button at the top starts a truck load — the thing you do most during harvest. Below it, a tile opens each of the other main areas of Turnrow — Loads, Bin Inventory, Contracts, Settlements, Yields, Hedging, Reports, and Settings — the same destinations as the green bar across the top. If your operation is brand new in Turnrow, a setup checklist appears above them until the basics are in place.

## How to use it

Tap a tile to go to that area. On a new account, work down the **Welcome — let's set up your operation** checklist in order. Each step opens the page that does the work, and a green check appears as you finish it:

- **Create your entities** — the legal entities (LLCs, partnerships, individuals) that farm.
- **Add your farms** — each FSA farm, linked to its entity, with county and landowner.
- **Add your fields** — the fields on each farm, with total and irrigated acres.
- **Confirm your crops** — the standard four crops come pre-loaded; adjust names, base moisture, and pounds per bushel to match how you settle.
- **Enter your first loads** — type one in at New Load, or photograph scale tickets at Loads → Scan.

That order matters: farms need an entity, fields need a farm, and loads need fields, crops, trucks, and bins to point at. Set up trucks, bins and bin sites, and buyers under Settings before entering loads if you haul to those.

## What the controls do

- **The checklist** shows only while entities, farms, or fields are missing, and only to owners. Once the basics exist it goes away for good — the tiles are all you see afterward.
- **The tiles** mirror the top navigation exactly. If the Cotton module is turned on for your operation, a Cotton tile appears as well.
- **The ? button** in the top bar is on every page, for every role. It opens Help with a guide to the page you're on, plus tabs to browse all topics, ask the assistant a question, and send a message to support — that last one reaches a person. The **Help center** link inside it opens the full searchable Help Center.

## Common questions

- **Where are the importers?** Most setup pages accept files so you don't retype what you already have. Fields and Plantings (under Settings) take a spreadsheet or a photographed/PDF document that Turnrow reads for you. Farms and Trucks take a spreadsheet. Loads can come in three ways: typed one at a time, scanned from ticket photos at Loads → Scan, or uploaded as a spreadsheet at Loads → Import.
- **Do I have to finish the checklist before using the app?** No. Any page works at any time — the checklist is a guide, not a gate.
- **What's a planting?** A field, a crop, and a season together — for example, Field 12, corn, 2026. Plantings are what yields, insurance, and marketing reports are built on, so enter them once planting is done each spring.
- **I farm under several companies. How do those fit?** Each one is an entity. Farms belong to entities, and most reports can be filtered by entity, so keeping them straight up front pays off later.
- **I farm under just one company. Do I have to keep picking it?** No. With a single entity, Turnrow fills it in for you everywhere — entity dropdowns disappear from forms and imports until the day you add a second entity.
- **Can more people on my crew log in?** Yes. Under Settings → Users & Modules an owner can invite people by email and set what they're allowed to see.

## If something looks wrong

- A checklist step won't check off: confirm you actually saved at least one record on that page.
- A tile you expect is missing: your login role may limit what you see — an owner can check your role under Settings → Users & Modules.
- If the checklist or tiles still look wrong after that, contact support.

# Government Payments Settings  (page: /settings/government-payments)

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
- Or skip the typing: **import a brokerage statement** (photo or PDF). Turnrow reads the open positions, closed trades, and cotton alongside the grains, shows everything on a review screen, and saves only what you confirm.
- Filter between open, closed, and all; closed positions can be narrowed by date range.

## What the controls do

- **Open / Closed tables** — open positions show live gain or loss at current prices; closed positions show the locked-in result net of commissions.
- **Statement import** matches what it reads to positions you already have, so re-importing a statement doesn't duplicate anything. Closed trades come in lot by lot: each opening lot becomes its own closed position with its own result, and the lots are checked against the statement's total — a disagreement over a dollar is flagged on the review screen for you to look at.
- The import also runs a second check: positions Turnrow shows open that don't appear on the statement are flagged as possibly closed. You choose — **Close this position** (which walks through the normal close, nothing closes automatically) or **Keep open**.
- Cotton is handled in its own terms throughout: pounds instead of bushels, cents per pound instead of dollars per bushel.

## How the numbers work

- **Unrealized** is what an open position would make or lose if you offset it at the current market price: the difference between today's price and your trade price, times contracts, times the contract size. It changes with the market and isn't money in the bank.
- **Realized** is the locked-in result of a closed position: the difference between your opening and closing prices, times contracts, times contract size, minus commissions. It no longer moves.
- A sold (short) position gains when prices fall; a bought (long) position gains when prices rise.
- Options are valued off their premium: what you paid or collected versus what the option is worth now (open), or what you closed it at (closed).
- Market prices on this page are for valuing open positions and are delayed quotes — they're a gauge, not a fill price.

## Common questions

- **Why does my unrealized number bounce around?** It's marked to the current market. Only closing the position locks a number in.
- **My total doesn't match the brokerage's month-end.** Check commissions on manually closed trades, and make sure every statement has been imported. Statement totals are reconciled on import, and disagreements were flagged then.
- **The import says a position is "possibly closed" but it isn't.** Choose Keep open. The flag only means the statement didn't list it — a partial statement can cause that.
- **Do hedge results show up in my marketing numbers?** Yes — realized futures results flow into the marketing and revenue reports, counted once, per crop year.
- **Why are there no live prices right now?** Quotes can be temporarily unavailable; positions are still there, only the unrealized column waits. If prices never load, contact support.

## If something looks wrong

- A doubled position after an import: check whether the same trade was also entered by hand, and delete the duplicate.
- A wrong realized number: open the position and verify the close price, contract count, and commission.
- Lot totals flagged against the statement: trust the statement, edit the lots to match.
- Anything beyond that: contact support.

# Loads  (page: /loads)

## What this page is for

The load log is the master list of every load you've hauled — to a bin or to a buyer. Each row shows the date, ticket number, truck, crop, where it came from, where it went, weights, moisture, test weight, and whether the buyer has paid for it. It's the record everything else builds on: bin inventory, contract delivery, settlements, and yields all read from these loads.

## How to use it

- To record a new load by hand, use **New Load** — pick the date, truck, crop, crop year, where it came from (field or bin), where it went (bin or buyer), and enter the weights. If a load carries grain from more than one field, add a split so each field gets credit for its share.
- **New Load starts where YOU left off.** The form pre-fills the date, crop, crop year, From, and To from the last load **you** entered — whether that was field-to-bin, field-to-buyer, or bin-to-buyer — so a string of loads only needs weights and a ticket number. Two people entering different load types at the same time each get their own pre-fills; only when you haven't entered any loads yet does the form borrow the operation's last load. Every pre-fill can be changed. When the pre-filled date isn't today (say you're entering last night's tickets the next morning), a small note by the date says so — e.g. "Defaulted to 8/14 (your last load's date) — not today" — so nothing quietly lands on the wrong day. Change the date and the note goes away; each saved load becomes the starting point for the next.
- **Finding a field is a search, not a scroll.** Tap the field box and a search opens with the box right at the top — type a few letters of the field **or the farm** ("saun" finds everything on Big Saunders; a farm name narrows to just that farm's fields). Fields stay grouped by farm so two farms' "Field 12"s can't be mixed up. The same search is on split-load lines and on Yield from Combine.
- **Save & New is the harvest workhorse.** It saves the load and immediately gives you a fresh form for the next one — date, crop, From/To, and contract carried over; weights and ticket cleared — with a quick green "Saved — ticket 1234" confirmation at the bottom. **The truck starts empty on purpose:** during harvest, back-to-back loads usually come in on different trucks, and a quietly carried-over truck puts loads on the wrong one. Pick the truck for each load — the "Use last tare" shortcut is right there once you do. Use plain **Save** when you're done and want to go back to the load log.
- **The contract tracker keeps count as you go.** When a contract is picked, the delivered/remaining bar under it counts every saved load — including the ones you just entered with Save & New — so the remaining figure is right after each save, and the "over by" note shows on the very load that goes past the contracted bushels.
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

## Tare weights: the warning and the shortcut

- **"Tare … is well below this truck's usual …"** Turnrow learns each truck's normal empty weight from its past loads (the middle value of its tares, once the truck has at least three loads with a tare). If the tare you enter is half or less of that usual figure, a note appears under the Tare field — on New Load, Edit, and on each row of a ticket scan. It's a heads-up, not a stop: a typo or a mis-read scan on the tare makes the net weight (and the bushels, and what the buyer owes) look bigger than it is. Check the ticket; if the low number is real — a trailer dropped, a different tractor — just save. The note disappears as soon as the value is corrected, and saved loads that would have tripped it show a small **low tare?** tag in the load log so an old mistake is easy to find.
- **Use last tare.** Once a truck is picked on New Load, a small **Use last tare: 31,220** button appears by the Tare field — that truck's tare from its most recent load (hover to see the date). One tap fills it in; you can still change it. It works for your trucks and hauler trucks alike, and stays out of the way when the truck has no earlier loads. It never fills in on its own: weighing the empty truck is the accurate number, and the shortcut is for when you know the truck hasn't changed.

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
- Counties without benchmark data fall back to a flat per-acre estimate, marked with a **"flat est."** chip — hover it to see why (no county on the farm, or no benchmark entered for that county and year). Enter benchmarks under Settings, Government Payments to replace the flat estimate with the real calculation.
- The Payment Tracker uses the identical math, so the two pages always agree.
- **SCO note**: for 2025 and later crop years, SCO can be purchased regardless of your ARC/PLC election, with an 80 percent premium subsidy. And for 2025 only, FSA automatically pays the higher of ARC or PLC per farm and commodity.

## Common questions

- **These are projections, right?** Yes. FSA determines final payments after the marketing year ends. The verdicts move as MYA expectations move.
- **Why does one farm differ from the summary verdict?** The summary sums all farms; an individual farm's county benchmark or PLC yield can tip it the other way.

## If something looks wrong

- A "flat est." chip means benchmark data is missing — add it in Settings, Government Payments.
- A notice about benchmark years means your benchmarks are entered under a different program year; the notice links you to the right spot.
- Anything else, contact support.

# Bale Quality Summary  (page: /reports/bale-quality)

## What this page is for

This report is part of the Cotton module — it appears in the Reports menu only when Cotton is turned on under Settings → Users & Modules.

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
- **I don't see this report at all.** The Cotton module may be turned off. An owner can enable it under Settings, Users & Modules.

## If something looks wrong

- If lint pounds look off, verify the bale list on the gin receipt for that field.
- If grades look off, re-check the classing import on Bales & Grades — unmatched rows are held there visibly for later.
- Anything else, contact support.

# Buyer Discount Comparison  (page: /reports/buyer-discounts)

## What this page is for

Every buyer takes something off what you gross — but they don't take it the same way. One prints drying charges in dollars, another quietly pays you on fewer bushels than your scale says, a third does both. This report puts them all on one honest yardstick: **lost revenue from discounting, in cents per bushel**, by buyer, crop, and crop year. Price discounts count as the dollars taken off the check; volume cuts count as the bushels paid below your FSA-standard dry bushels, valued at that settlement's own price. One number, every mechanism.

## The lead number: lost ¢ per contracted bushel

When a settlement's loads deliver against a contract, the fairest denominator is the **contract's bushels** — that's the deal you priced, and it's what the discounting eroded. The lead column divides each buyer's lost dollars by their contracts' bushels (weighted across contracts); rank 1 is the cheapest buyer to sell to. Beside it, **lost ¢ per settled bushel** covers every settlement — and stands in (marked *spot/unlinked*) for buyers whose settlements have no contract behind them.

The category columns split the loss by type — moisture/drying, test weight, damage, FM/dockage, other, and **weight deduction** (pay-bushels taken beyond standard shrink that the statement didn't break out). The costliest type per buyer is highlighted. Tap a buyer's row to open its contracts, and each contract's settlements underneath.

## The other sections

- **Quality-adjusted detail** (collapsed by default) — corrects for the grain each buyer actually saw: their moisture/drying charges per point over base, their test-weight charges per pound light, with each buyer's average moisture and test weight shown so you can judge whether two buyers really got similar grain.
- **Published discount schedules** — each buyer's posted sheet side by side per factor. Schedules live with the buyer on Settings → Buyers (crop, effective date, the original document attached).
- **Expected vs actual** — the buyer's own published rules applied to your matched loads' known moisture and test weight, next to what they actually charged. A red flag means the charge ran materially above their own sheet — worth a phone call. Schedules carry effective dates, and the check always uses the sheet in force on the settlement date.

## How the numbers work

- **Lost revenue** = itemized price discounts (dollars off the check) **plus** the gap between your FSA-standard dry bushels and the buyer's pay bushels, valued at that settlement's own prices. When a statement itemizes its weight deductions (shrink pounds, FM weight), those lines say *which column* the gap lands in — the dollars are never counted twice.
- Settlements join a crop, crop year, and contract through their **matched loads** — a settlement with no matched loads doesn't appear. A buyer who paid on *more* bushels than standard shrink shows a negative (green) weight deduction.
- Category columns come from the itemized discount lines on each settlement (the AI upload fills them; you can add or fix them on the settlement's page). Un-itemized settlements still count in the totals, with their volume gap under Weight deduction.

For **read-only users**, the report covers the settlements whose matched loads belong to your granted entities.

## You can also just ask

The **Ask Turnrow** assistant answers from this same data: "What will [buyer] dock me for 17% corn?" reads the buyer's stored schedule (the app does the tier math, not the assistant), and "Who was cheapest on light test weight last year?" reads the settlement actuals behind this report.

## Common questions

- **Why does the lead column show an asterisk for a buyer?** Their settlements aren't linked to any contract — the settled-bushel figure stands in, and the row is marked spot/unlinked.
- **A buyer looks cheap here but their check always feels light.** Check their Weight deduction column — volume-style discounting never shows up as a price discount, but it shows up here.
- **Why is a buyer's moisture/drying column empty but their total isn't?** Their settlements aren't itemized. Open one and add its deduction lines in the Discounts section.
- **The audit flagged a settlement — now what?** Open it and compare the flagged factor's expected vs charged figures against the original statement. Flags are a reason to ask, not proof of a mistake.

## If something looks wrong

- A number that looks extreme usually traces to one small settlement — open the buyer's drill-down and check the settlements behind it.
- If a schedule's rules read wrong, delete it on the buyer's card (Settings → Buyers) and re-upload, correcting the rules on the review screen before confirming.
- Numbers that won't reconcile after that: contact support.

# Cash Flow Forecast  (page: /reports/cash-flow)

## What this page is for

The Cash Flow Forecast lays out, month by month, when money from the crop should actually arrive: what you have already been paid, what you are owed for grain delivered, what your contracts should bring as you deliver them, and the safety-net layer of ARC/PLC, crop insurance, and other USDA payments. It is the page for planning loan payments, input purchases, and conversations with your lender about timing.

## How to use it

Pick a crop year (and an entity if you want one entity's view). The summary tiles total each category; the monthly table shows every month with a running cumulative column, and the contract detail below shows each contract's value, what has been received, what is outstanding, and what remains unearned.

## What the controls do

- **Crop year** — frames the whole forecast, including which program year's ARC/PLC belongs in it.
- **Entity filter** — narrows fields, production, and policies to the entity. Contracts held by your marketing agent, or with no entity, count toward each entity by its share of the crop's planted acres.
- **Export Excel / PDF / Print** — the monthly matrix, safety net, and contract detail together.

## How the numbers work

The three revenue columns split every contracted dollar by how certain it is:

- **Received** — cash already collected on settled loads, shown in the month of the settlement.
- **Outstanding** — grain delivered but not yet paid for, valued at the contract price, shown in the current month as money owed to you.
- **Projected** — contracted bushels not yet delivered, valued at the contract price and spread evenly across the remaining months of the contract's delivery window. A contract with no window shows in the current month. A contract marked complete — or fully delivered — projects nothing more, even if bushels remain on paper; it carries a "complete" badge.

The **Total Safety Net** adds program and insurance money with realistic timing. ARC/PLC for a program year is paid in October of the following year — so when you filter to a crop year, the ARC/PLC shown is the prior program year's payment arriving that October, and the card names the program year. Crop insurance is the projected indemnity, using the same per-practice yields and the current futures-based harvest price estimate as the Claims Monitor, so the two reports agree. Other USDA payments count in the month and year received.

When cotton is in the year, a **Cotton (net)** column and a cotton cash detail table appear: CCC loan money when bales enter loan, redemption payoffs and equity sale proceeds when loans resolve, pool payments on their dates plus each pool's estimated remaining value, priced contract proceeds spread across their delivery windows, on-call contracts valued at basis plus the current futures quote, LDP on its date, and fees as outflows.

## Common questions

- **Why is a month's projected revenue lower than I expected?** The contract's value is spread across every remaining month of its delivery window — one month carries only its share.
- **Why does my ARC/PLC payment seem to be for last year?** That is how the program works: a program year's payment arrives the October after it. The forecast puts the cash in the month it actually lands.
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

- Pick a **crop year** first — nothing shows until you do.
- Narrow by **entity** if different entities carry different policies.
- Use the **crop chips** to include only certain crops. Leaving them all off means every crop shows. The chips only offer crops you actually planted in the selected year and entity.
- Export with the **Excel**, **PDF**, or **Print** buttons. The export mirrors exactly what's on screen, including the three metric groups: Certified Acres, Production, and Yield/Acre.

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

What it costs to take a point of moisture out — and what it costs to take out one too many. Pick your dryer, put in fuel and grain prices, and the table answers, per bushel, for every incoming moisture from bone-dry to 28%: the fuel to dry it to base, the weight that drying shrinks away, and — when you point it at a buyer's discount schedule — whether drying it yourself beats hauling it wet. It's a calculator, not a record book: nothing here tracks loads.

## Setting it up

- **Dryer** — pick one of your saved dryers, a catalog model (GSI, Sukup, Brock, Mathews Company, NECO, Grain Handler, Zimmerman, Farm Fans/GT — each with a *typical* consumption estimate by dryer type), or type one-off numbers. Catalog presets are estimates only; your records beat them (see calibrating, below). "Save these settings as a dryer" keeps a setup for next time.
- **Crop** — sets the base moisture from the crop's own standard (the same base the rest of Turnrow shrinks to).
- **Fuel** — propane in $/gal or natural gas in $/ccf; the page remembers your prices. LP and NG presets convert by energy content, so a catalog model works on either fuel.
- **Grain price** — defaults to today's futures quote for the crop's reference contract; type over it any time. It's what values the shrink.
- **Compare against buyer** — pick a buyer whose discount schedule is on file (uploaded here or on the buyer's card in Settings → Buyers) and every wet row shows their dock beside your drying cost.

## Reading the table

- **Rows above base** are incoming wet grain dried to base: fuel $/bu, the cost per point, the **shrink** (the physical water weight, valued at the grain price — shown separately because it's a real cost whether or not you think of it that way), and the total. With a buyer selected, the **Cheaper** column calls it: *Dry it* or *Haul it wet*, with the savings.
- **The base row** is the stop line.
- **Rows below base** are the price of **overdrying**: every half-point past base gives away sellable weight *and* burns fuel removing water nobody pays for. That combined number is why stopping at base instead of a point and a half low is worth real money on a big crop.

## Calibrating from your records

The honest consumption number is yours, not a brochure's: enter last season's total gallons (or ccf), bushels dried, and average points removed, and the page computes **your** fuel per bushel-point — then offers to save it to the selected dryer. One season of records beats any preset.

## Common questions

- **Where do the catalog numbers come from?** Typical figures by dryer type (cross-flow, mixed-flow, tower, heat recovery). They're starting points, labeled as such — calibrate with your records.
- **Why does hauling wet sometimes win?** A buyer's drying charge can be less than your fuel plus shrink, especially for a point or two. The comparison uses their posted sheet — if their actual settlements run above their sheet, the Buyer Discount Comparison report's audit will say so.
- **Does this change any of my data?** No. Only saved dryers (and a calibration you choose to save) persist — the rest is session inputs.

## If something looks wrong

- No grain price showing: there may be no live quote — type a price in.
- No buyers in the compare list: no discount schedule on file for this crop yet — upload one below or on Settings → Buyers.
- Numbers that don't square with your fuel bills: calibrate from records; the presets are estimates. Still off after that: contact support.

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

- **Year framing toggle** — the default **"By payment year"** view answers "what cash arrives in year Y": ARC/PLC for program year Y−1 (which pays the following October) plus other payments received in Y. Switch to **"By program year"** to line up with FSA paperwork instead. Switching shifts the year selector so the same pool of payments stays on screen.
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

- A benchmark-year notice means ARC-CO benchmarks exist only for other years — the notice links to Settings preset to the right year.
- If an entity's limit looks wrong, check its eligible-persons count in Settings, Entities and the per-person limit in Program Parameters.
- Anything else, contact support.

# Hedging Summary  (page: /reports/hedging-summary)

## What this page is for

The Hedging Summary gathers every futures and options position — open and closed — into one report, summarized by crop year and commodity with realized and unrealized profit and loss. It is written to be lender-ready: the export is the clean statement of your hedge book a banker or business partner expects, without them needing to know your trading platform.

## How to use it

Pick a crop year and, if you want, a commodity. The summary table shows each crop year × commodity combination with total contracts, bushels (or pounds for cotton), average hedge price, unrealized P&L on open futures, realized P&L net of commission on closed ones, options P&L, and the combined net. The detail table below lists every position — month, symbol, side, quantity, prices, and its own P&L. Date filters let you cut the report to a statement period.

## What the controls do

- **Crop year** — which marketing year's positions to show; each position is tagged to the crop year it hedges.
- **Commodity** — narrow to corn, soybeans, wheat, cotton, and so on.
- **Entity filter** — positions in an entity's own name count wholly toward it; positions held by your marketing agent or entered without an entity are hedging for the whole operation.
- **Date range** — filters positions by trade date, or close date for closed positions.
- **Export Excel / PDF / Print** — the summary and full position detail with your filters named.

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

Pick a crop year and scroll to a crop. The row and column closest to today's futures price and your expected yield are highlighted — that cell is "you are here." Read down for cheaper prices, left for lower yields, and watch where insurance kicks in to flatten the damage. A badge above each table says how many bushels are contracted at locked prices, or that the crop is fully price-sensitive.

## What the controls do

- **Revenue/acre | Net profit/acre** — switches what the cells show; profit subtracts your cost per acre from the Marketing assumptions.
- **Price and yield axis controls** — set the center, step, and number of steps for each axis of each crop; leave them blank for automatic values centered on your current assumptions — the assumed futures price from your marketing assumptions (falling back to today's price, then your policies' projected price) and your expected yield. An entry that does not parse reverts to the previous value.
- **Include government payments** — adds the payments expected to arrive during the crop year (the prior program year's ARC/PLC paid that fall, plus other USDA payments) as one flat dollars-per-acre amount, identical for every crop and constant across cells.
- **County yield toggle** — see below.
- **Entity filter** — narrows acres, positions, and policies; agent-held or whole-operation contracts count toward each entity by its share of the crop's planted acres.
- **Export Excel / PDF / Print** — the tables with the price axis as the first column and your active toggles noted.

## How the numbers work

- **Contracted bushels stay locked.** Cash contracts keep their cash price, HTA and basis contracts their locked legs, open hedges their trade price, realized gains counted once. The scenario price applies only to unpriced bushels, plus your assumed basis. If scenario production falls below contracted bushels, revenue is capped at production.
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

Pick a crop year, then scroll through the crop sections. The chevron on each section expands a detail view that reads like a statement: the futures price buildup source by source, the basis buildup, and profitability side by side. Enter your yield and cost assumptions once through **Edit Assumptions**; use the **What-If** row to value your unpriced bushels at a futures price and basis you choose.

## What the controls do

- **Crop year and entity filter** — the entity filter narrows acres and production to that entity. Contracts and hedges held by your marketing agent — or entered with no entity — are marketing for the whole operation, so they count toward each entity in proportion to its share of that crop's planted acres. A contract in an entity's own name counts wholly toward it.
- **Edit Assumptions** — a panel with one section per crop: enter an overall yield and cost per acre, or break them out by irrigated/dryland and full-season/double-crop. A blank breakout cell falls back to the overall figure. The **Harvest complete** checkbox tells Turnrow the crop is finished; checking it snaps the yield to the actual average from your loads.
- **What-If on Unpriced Bushels** — type an assumed futures price (or use the **use today's price** button, which fills in the current quote for the reference contract shown) and an assumed basis. These are standing assumptions: they save automatically, stay until you change them, and flow into every headline number here and on Revenue Projections. **Clear assumptions** wipes both.
- **The reference contract** — shown next to the futures input as the board month and its live quote (for example "ZWU26 · $5.72"). This is the futures contract your unpriced bushels are valued against. The default is the crop year's new-crop month — December corn and cotton, November soybeans, July wheat — and once that contract stops trading (around the middle of its delivery month), Turnrow automatically moves to the next traded month and shows a small note like "Jul 26 expired → Sep 26". You can also pick a different month from the dropdown — any traded month from this crop year through the next — and your choice sticks for that crop and year until you press **Reset to default**. The Income Sensitivity price axis and Revenue Projections follow the same contract, so every page prices unpriced bushels off one answer.
- **Physical Sales Complete for the Year?** — checkboxes at the bottom, one per crop. Because shrink and small leftovers keep the math from ever landing on exactly zero, this is how you tell Turnrow a year's selling is truly finished.
- **Export Excel / PDF / Print** — the full dashboard, formatted for handing to a lender.

## How the numbers work

Production is your assumed acres × yield until you mark harvest complete; after that it is the actual bushels from your loads (pounds of lint from gin receipts for cotton). Turnrow also switches to actuals on its own once every field of a crop is harvested. If a crop hasn't switched because a field still shows as being harvested, an amber note at the top names the field — tap **Count anyway** there if it's actually done, and its bushels count as final everywhere. Every bushel is valued at its own price: cash sales at their cash price, HTA and basis contracts at their locked legs, hedged bushels at their trade price with realized futures and options gains counted once, and unpriced bushels at your assumed futures plus assumed basis (or, with no assumption entered, the reference contract's current quote). Basis totals show their state — actual where locked, assumed where not, and a blend when it is some of each.

An amber **includes assumptions** marker appears whenever any production is not fully priced; its tooltip breaks down how many bushels ride on assumed futures or basis. Profit is this blended revenue minus your cost per acre, and it matches Revenue Projections to the cent. Breakeven price is cost divided by yield; breakeven yield is cost divided by average price.

Cotton sections work in pounds and cents per pound, with a position bar covering sold, pool, in-loan, hedged, and unpriced lint.

## Common questions

- **Why did my average price move when I typed a What-If number?** The headline reflects your standing assumptions on unpriced bushels — that is the point. Clear them to see locked pricing only.
- **I'm a read-only user — can I try my own numbers?** Yes. Your edits are private "your scenario" values only you see, marked with a chip. If an administrator later changes the official assumption, your scenario value is replaced and a notice tells you.

## If something looks wrong

Check the assumptions panel first — a "needs yield" badge means a crop has no yield entered, and profit shows "Set costs" until cost per acre exists. If a contract seems missing under an entity filter, remember agent-held contracts are shared by acres. Otherwise, contact support.

# Rent Settlement  (page: /reports/rent-settlement)

## What this page is for

Settling up with a landowner at the end of the year. Put the lease on file once, and Turnrow builds the settlement statement from your records — the landowner's share of bushels (the same splits-aware production math as the Share Rent Report), actual sale prices where you marketed their share, and shared expenses — itemized line by line. The finished statement carries **your farm's name and logo** (set under Settings → Organization), not Turnrow's — it's your document to mail.

## How to use it

1. **Put the lease on file.** Tap **Upload lease (AI)** — a PDF or photos — and Turnrow reads the terms: who the landowner is, which farms, crop-share percentages (by crop if they differ), which expenses are split, how the landowner's grain is priced, payment timing, and any flex clauses. You review and correct every field before saving, and the lease document stays attached. Handshake lease with nothing written down? **Enter a lease by hand** — same form, no upload.
2. **Generate a settlement.** Pick the lease and the crop year. Turnrow shows what your records supply — bushels by crop and the average settled price where you sold their share — then asks for **exactly what the lease needs that the records don't have**: a drying bill to split, a reference price to confirm, a flex bonus amount. Every one is a labeled blank; the statement won't generate until they're answered.
3. **Check, save, and send.** The preview shows every line with where its number came from — *From farm records*, *Entered at settlement*, or *Reference price (confirmed)*. Save it (it's kept on this page and can be regenerated), and download the PDF to print or email.

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

Pick a crop year and, if you want, an entity. The summary tiles show total revenue, total cost, total profit, and profit per acre. Below them, the revenue table lists each crop's acres, yield, production, crop sales revenue, insurance proceeds, government payments, and revenue per acre; the profitability table adds cost, profit, the headline Total Avg Price, and both breakevens. The collapsible **How this is calculated** panel on the page walks through the same methodology described here.

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

## If something looks wrong

If a crop is missing, it likely has no yield assumption yet — set one on the Marketing Dashboard. If revenue looks too high or low, check the assumed futures and basis there, since they value every unpriced bushel. If a government payment seems absent, confirm which year it was received in; payments count in the year they arrive. Otherwise, contact support.

# Season Summary  (page: /reports/season)

## What this page is for

The Season Summary is the one-table answer to "what did we plant and what did it make?" For a chosen season it shows every crop with its acres — full-season, double-crop, total, irrigated, and dryland — plus total dry bushels and yield per acre, with a grand total row at the bottom. Headline tiles above the table show crops planted, total acres, irrigated acres, and dryland acres at a glance.

## How to use it

Pick the season year at the top. If you run more than one entity, use the entity filter to narrow the report to one of them — acres, production, and yield then reflect that entity's fields only. Leave it on all entities for the whole operation. Both filters are remembered between visits.

When harvest is running, check back as loads come in: the production and yield columns build up as fields finish.

## What the controls do

- **Season** — chooses the crop season the whole page reports on.
- **Entity filter** — narrows acres and production to the fields belonging to that entity's farms.
- **Export Excel / Export PDF / Print** — exports the table exactly as shown, with the season and entity named in the header.

## How the numbers work

- **Acres** count every planted field, split into full-season and double-crop, and into irrigated and dryland where you have entered that breakout.
- **Dry bushels** come from your recorded loads, adjusted to each crop's base moisture — the same dry-bushel rules used everywhere else in Turnrow.
- **Yield per acre** divides production by the acres of fields that are actually finished. Fields that are unharvested or still in progress are left out of both production and yield, so a half-picked field never drags the average down. Their acres still show in the acreage columns.
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

- Pick a **crop year**. The report opens with a summary of bushels owed per crop, then a section per landowner showing each of their share-rent farms.
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

- Pick a **crop year**. The report groups everything by landowner, then by farm, then by field.
- Narrow with the **crop**, **entity**, or **landowner** filters — picking one landowner gives you a clean page for that owner alone.
- Use the **Excel**, **PDF**, or **Print** buttons to produce a copy to hand or email to the landowner. The export mirrors the screen.
- Your filter choices are remembered, so the report opens the same way next time.

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

The Reports page is the front door to every report in Turnrow. It shows one card per report, organized into groups, with a short description of what each one answers. The same list appears in the sidebar on the left, so you can move between reports without coming back here.

The groups cover the main areas of the operation:

- **Main Reports** — the financial picture: Season Summary, Marketing Dashboard, Revenue Projections, Income Sensitivity, Crop Budget Planner, Cash Flow Forecast, and Hedging Summary.
- **Crop Insurance** — the production report formatted for your insurance agent, the Claims Monitor that estimates indemnities, and the bundled settlement statements for a production audit.
- **Production Reports** — yields by field, farm, and landowner, the Share Rent Report, and the cotton Bale Quality Summary.
- **Government Payments** — the ARC/PLC Decision Aid and the Government Payment Tracker.
- **Operational Reports** — the load log, contract tracker, unpaid loads, and bin inventory.

## How to use it

Pick the question you are trying to answer, then open the report that matches it. If you want a season's production story, start with Season Summary. If you want to know where you stand on selling the crop, open the Marketing Dashboard. If a lender wants one page, Revenue Projections or the Hedging Summary is usually what they are after.

Each report keeps its own filters — crop year, entity, and so on — and remembers them between visits, so a report you check often opens the way you left it.

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
- **Why don't I see every report listed?** What you see depends on your role. Read-only users see the reports their access covers; links into operational pages are hidden for them.

## If something looks wrong

If a report card is missing that you believe you should have access to, check with whoever administers your Turnrow account — access is set per user. If a report opens but shows no data, check its crop year and entity filters first; most empty-looking reports are filtered to a year with no activity. If a report will not open at all, contact support.

# Scan Tickets  (page: /loads/scan)

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

# Buyers & Delivery Locations  (page: /settings/buyers)

## What this page is for

Buyers are the businesses you sell and haul to — elevators, river terminals, feed mills, ethanol plants, gins. Each buyer can carry one or more delivery locations (separate elevators, terminals), which contracts and loads then point at. Set them up once here and they're available everywhere a load or contract asks where the grain went.

## How to use it

- Type a name and **Add Buyer** to create one. Expand a buyer to add its delivery locations, each with an optional address.
- **Find buyers near me** searches the web for elevators, terminals, and other buyers that handle your crops near a zip code you enter, within a radius you pick. Results come back as a checklist — tick the ones you actually sell to, edit a name if it isn't quite right, and add them. Anything you don't tick is discarded, and results already in your list are marked so you don't double up.
- To bring in a whole list at once, use the spreadsheet import at the top — one row per buyer, locations in one cell separated by semicolons. There's also an **Upload (AI)** card that reads buyer names and delivery locations out of any document, alongside anything else it finds worth filing elsewhere.
- **Discount schedules live on each buyer.** Expand a buyer and its schedules are right there — crop, effective date, rule count, and a link to the original sheet — with **Upload discount schedule (AI)** on the buyer's own card (photo or PDF; Turnrow reads where drying and test-weight charges start, the rates or bracket scales, rejection points; review and confirm — nothing saves until you do). The Buyer Discount Comparison report, the Grain Dryer Math tool, and the Ask Turnrow assistant all read from this one home. When a buyer posts a new sheet, upload it too — the effective dates keep each one applied to its own period; to replace a bad read, delete it and upload again.

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

# Operation Settings  (page: /settings)

## What this page is for

Settings is the hub where your operation's structure lives — the entities, farms, fields, crops, and people everything else hangs on. Get these right once and the rest of the app mostly fills itself in.

## How to use it

Work top-down the first time: entities, then farms, then fields, then crops and plantings. After that you'll only visit to add a field, a truck, or a new crop year's plantings.

## Setting up from your paperwork

Every setup page here has an **Upload (AI)** card, and the top of Settings has an **Upload any document (AI)** card that takes anything — leases, FSA farm records, plat maps, acreage reports, plain lists. One upload reads the whole document and sorts what it finds into the right places (a lease fills in the landowner, the farm, and the share terms together), grouped for your review — nothing saves until you check it. See the Uploading Documents topic for the full picture.

## Spreadsheet imports: blanks are fine

In every spreadsheet import here, **a blank cell in an optional column never fails the row** — only each import's starred required columns can. Leave what you don't track blank: a blank share-rent cell simply means not share rent, a blank percentage stays empty, a blank landowner leaves the farm unlinked. You can also leave whole optional columns out of the file.

## What the controls do

- **Entities** — your legal entities and the counties they operate in, plus each entity's FSA eligible-persons count for payment limits (set once; the total ARC/PLC cap is persons times the program year's per-person limit). An entity can also be marked a **marketing agent**: one entity that holds the contracts and hedge account on behalf of the whole operation. In entity-filtered reports, the agent's marketing flows down to each farming entity by that entity's share of the crop's planted acres — so income lands where the grain was grown. A farming entity that markets in its own name keeps those contracts whole.
- **Farms** — each farm's entity, county, **FSA number**, and landowner, plus the **share-rent flag and landlord share percentage** that drive the Share Rent Report. The spreadsheet import takes all of it — entity and landowner match by name against what already exists, counties match by **name plus two-letter state** together — the state column is required whenever a county is given, and "Lawrence County" or plain "Lawrence" both match — and share rent comes in as yes/no with the landlord percent. If your operation has one entity, Turnrow fills it in for you: the entity dropdown disappears from the farm form and the spreadsheet can leave the entity column out entirely. Deleting a farm removes its fields too.
- **Fields** — total and irrigated acres (dryland is derived), county, and each field's plantings. Import by CSV or by **AI upload** of a document. A farm filter narrows long lists.
- **Crops** — each crop's base moisture and pounds per bushel (the standards dry-bushel math uses), its **harvest category** (fall or spring — spring-harvest crops like wheat are what make a later planting count as double-crop), and the double-crop designation. This page also holds **"Physical Sales Complete for the Year?"**: when a crop year's grain or cotton is fully sold, mark it here — shrink and small leftovers mean the sold-versus-production numbers rarely land on exactly zero, so this checkbox is how you tell Turnrow the year's selling is truly finished. The same checkboxes sit at the bottom of the Marketing Dashboard, so you can flip it from either place.
- **Plantings** — what's planted where, per field, crop, and season, with one or more varieties per planting. Import by CSV or **AI upload**; both recognize variety-name spellings that differ only by brand prefix and ask you whether to link or keep them separate, so "DG 3644" and "Dyna-Gro 3644" don't become two varieties. Two things worth knowing: **acres default to the whole field** — leave planted acres blank (in the spreadsheet or on the form) and the field's full acres fill in, shown as "from field acres" so you can override it; and **one row per crop** — a field that grew wheat and then double-crop soybeans is two rows for the same field and season year, and both may claim the field's full acres. That overlap is normal; the form points it out as information, not a conflict.
- **Varieties** — every variety with usage counts, inline rename (renaming onto an existing spelling merges them), and a find-similar tool for cleaning up duplicates pair by pair.
- **Bins & Sites** — your storage sites and bins, with current bushels on hand per bin. Add a site's bins right on the same form (type the names, comma-separated), or bring bins in from a spreadsheet — each row names the bin, its site, and optionally the crop it holds and its capacity. Each bin also takes an optional **Capacity (bu)**: set it and Bin Inventory shows a percent-full bar for that bin (bin-to-bin grain transfers are recorded there too).
- **Trucks** — the truck list the load form offers. You can also add a truck without leaving the load form (**+ Add truck…** in its Truck dropdown). Below your own trucks sits the separate **Hauler Trucks** list — buyers' and hired haulers' trucks saved from pickup-contract loads. The two lists never mix; renaming or deleting a hauler truck doesn't change loads already entered.
- **Buyers** — buyers and their delivery locations, used by contracts and settlements. The spreadsheet import takes one row per buyer with all their delivery locations in one cell, separated by semicolons, each with an optional address after an @ sign — re-importing adds new locations to a buyer without touching the rest.
- **Landowners** — names and contact details, linked to farms for the landowner reports. Spreadsheet import with a downloadable template — bring landowners in before farms so the farms import can match their names.
- **Organization** — how your operation appears on documents you send out: display name, logo, address, and contact line. The Rent Settlement statement renders under exactly this identity (your farm's branding, no Turnrow marks).

## Common questions

- **What does deleting cascade to?** Deleting a farm deletes its fields; deleting a field deletes its plantings. The app confirms first.
- **Do I have to use the marketing-agent entity?** No — it's for operations where one entity does the selling for several farming entities. Skip it if each entity markets its own grain.
- **Why does "Physical Sales Complete" matter?** Some year-end checks compare what you produced with what you sold; this flag tells them to stop expecting more sales.

## If something looks wrong

- If reports group things oddly, check the farm's entity, county, and landowner assignments — most report groupings come straight from here.
- If dryland acres look wrong on a field, remember they're total acres minus irrigated acres.
- Anything else, contact support.

# Landowner Shares  (page: /settings/shares)

## What this page is for

Landowner Shares connects a landowner's own software (Turnrow Landowner) to the fields they rent to you — read-only, only their farms, and only what you choose to share. You stay in control: each kind of information is a separate switch, and you can end a share at any moment.

## What's always shared, and what's up to you

Every share includes the landowner's **fields, plantings, and harvest progress** — the basic "what's growing on my ground" picture. Three more things are each their own switch:

- **Actual yields** — harvested results for their fields, as harvest is recorded.
- **Projected prices** — your projected average price per crop. This is **one number per crop and nothing more**: never your contracts, hedges, how much you've priced, or any cost or profit figures. Until you mark a crop year's selling finished (Settings → Crops), the landowner sees it labeled "projected"; after that it's labeled "final".
- **Projected yields** — your expected yield for the shared fields before harvest, with the irrigated/dryland split where a field has both. Once a field's harvest wraps up, the real number takes over, labeled "actual".

**Projected prices and projected yields start OFF on every share** — including shares you created before these switches existed. Nothing you share changes unless you flip a switch yourself, and a change takes effect the next time the landowner's software checks in, usually right away.

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

# Settlements  (page: /settlements)

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

# Uploading Documents  (page: /settings/uploads)

## What this is for

Most of what Turnrow needs to know about your operation is already written down somewhere — leases, FSA farm records, plat maps, acreage reports, handwritten field lists. Instead of retyping them, upload the document and Turnrow reads it for you.

## How to use it

- Every setup page (Entities, Landowners, Farms, Fields, Plantings, Buyers, Bin Sites, Trucks) has an **Upload (AI)** card — use the one closest to what you're holding, or the **Upload any document (AI)** card at the top of Settings when you're not sure where something belongs.
- Upload a PDF, a spreadsheet, or photos (snap multiple pages from your phone). Then review what was found.

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

# Users & Roles  (page: /settings/users)

## What this page is for

This page controls who can sign in and what they can see: invite new people, assign roles, and turn the Cotton module on or off. It's how you give your gin a place to key in loads without seeing your finances, give a landlord read-only access to their own numbers, or give your agronomist the whole operation's yields without any of the money.

## How to use it

- **Invite a user**: enter their email, pick a role (the dropdown starts on Owner — change it if they should see less), and either press **Send invite** (they get an email with a set-your-password link and land in your operation with that role) or press **Invite link** (no email is sent — you get a one-time link to copy and text or email yourself). Inviting a viewer requires picking at least one entity they may see; the other roles need nothing extra.
- **Assign a role to an existing login** with the form below, or **edit any user inline** — press Edit on their row to change the role and, for viewers, the entities they're granted.

## What the controls do

- The four roles, in plain terms:
- **Owner** — full access to everything. This is the default role.
- **Gin** — the gin operator role: only the Cotton intake pages (seed cotton loads, gin receipts, bales and grades). No marketing, no reports, no settings.
- **Viewer** — read-only reports and yields, limited to the entities you grant. A viewer sees only their entities' share of the numbers; whole-operation pages with no entity split (like the bundled settlement statements) are hidden from them. When a viewer tries out what-if values — assumed prices, yield assumptions, county differentials — those changes are **private to that viewer** and never touch your real numbers.
- **Agronomist** — the Yields page only, for the whole operation. They see every entity's production data — yields by field, farm, entity, variety, and landowner, including the load-by-load detail — but nothing financial: no contracts, settlements, hedging, insurance, payments, or budgets, ever. They can look and export, not edit, and they need no entity checkboxes.
- **Entity checkboxes** — which entities a viewer may see. Required for viewers; at least one must be picked. Agronomists don't use these — they always see the whole operation's yields.
- **Cotton module toggle** — turns the Cotton tab on or off for the whole operation. Turning it off hides the cotton pages and reports; it doesn't delete any data.

## Common questions

- **Why can't I change my own role?** Your own row is locked on purpose. If the last owner demoted themselves, nobody could manage roles anymore. Have another owner change your role, or contact support.
- **Email invite or invite link — which should I use?** Send invite is the easy path. Use Invite link when the person's email is unreliable or you'd rather text it — the link is their one-time set-a-password link, so treat it like a key.
- **Can a landlord see other landlords' numbers?** No. A viewer sees only the entities granted to them, and only in read-only reports.
- **What's the difference between a viewer and an agronomist?** A viewer is a stakeholder — they see reports and yields for just the entities you pick. An agronomist is a production advisor — they see yields for the whole operation, but only yields: no reports, no dollars anywhere.
- **What happens to a viewer's what-if numbers?** They live only in that viewer's view. Your saved assumptions and everyone else's screens are untouched, and if you later change the underlying value, the viewer sees a notice that their private value is out of date.
- **Someone needs both cotton intake and reports.** Roles are one per user. Give them owner if you trust them with everything, or set up which access matters more — there's no combined role.

## If something looks wrong

- If an invited user never got the email, re-invite with **Invite link** and send it to them directly.
- If assigning a role says no login exists for that email, use the invite form first — role assignment applies to existing logins.
- If a viewer reports missing numbers, check which entities are granted on their row.
- If your agronomist says a page keeps sending them back to Yields, that's the role working as designed — Yields is their whole app.
- Anything else, contact support.

# Yields  (page: /yields)

## What this page is for

Yields turns your load log into bushels per acre. The same production can be viewed five ways — by field, by farm, by entity, by variety, or by landowner — for any season. It's where you compare fields, settle up with landowners, and see how irrigated ground did against dryland.

## How to use it

- Pick a view from the dropdown: **By field**, **By farm**, **By entity**, **By variety**, or **By landowner**.
- Narrow with the season, crop, farm, entity, and county filters. In the by-field view you can also filter to irrigated or dryland ground. Your filter choices are remembered, so the page comes back the way you left it.
- Toggle between **Total** and **Irrigated / Dryland breakdown** to split the yield columns by practice.
- **Tap any row to open its detail.** A field row shows the loads behind its yield; a farm, entity, or landowner row shows its totals plus a field-by-field breakdown, and each field there opens further into its loads — two taps from a landowner to a scale ticket.
- Export any view to a spreadsheet or a formatted report — the export carries exactly the columns you're showing on screen, and when a row's detail is open the export adds a Load Detail sheet for it.

## Reading the table

- Each view lists **Yield (bu/ac)** right after the acres, with **Dry bu** last — so the number you're usually after is visible without scrolling sideways on a phone or iPad.

## What the controls do

- **Harvest status.** A field that hasn't been harvested, or is only partway through, is left out of the yield math — a half-harvested field would drag every average down. In-progress fields are labeled so you can see they're pending. If a field really is done but Turnrow can't tell (say the last loads went straight to town under a different crop year), tap **Count anyway** on that field. Turnrow asks you to confirm, then treats the field as finished — it looks like every other completed field and its bushels go into the averages. Open the field's detail and tap **Undo** to put it back to automatic. A field whose yield runs well below what's normal for the crop is what earns an in-progress label. "Normal" is the crop's other harvested fields — and early in harvest, when there's little or nothing to compare against yet, it's the yield estimate you entered in the Marketing assumptions, so even the first field cut reads in progress until it's genuinely done. The label is deliberately sticky: cutting a few loads, moving to another field for a while, and coming back later is normal, so loads landing on other fields never mark this one finished — and as long as loads for the crop are still coming in anywhere on the operation, a low field stays in progress no matter how long since its own last load. A low field only counts once you tap **Count anyway** or mark the crop's harvest complete — or after about ten days pass with nothing more hauled from that crop at all, which means harvest is genuinely paused or over. A field yielding in line with the rest is never held back, and a field with nothing to compare against (no harvested neighbors and no yield estimate) counts as finished, with a note in its detail saying so. If a field truly finished with a poor yield — a real crop failure — Turnrow can't tell that apart from a field you'll come back to, so use **Count anyway** to put its number in the averages.
- **Allocate irr/dry.** A field with both irrigated and dryland acres has one pile of bushels but two practices. There are two ways to split it. The easy way: tag each load Irrigated or Dryland as you enter it — when every load on the field carries a tag, the split comes straight from the loads (the row shows **From load tags ✓**) and you're never asked to allocate. Otherwise, once the field's harvest is complete, an **Allocate irr/dry** button lets you split the field's dry bushels between the two — type one side and the other side fills in so the split always totals the field's bushels. If some loads are tagged, the allocation opens pre-filled from those tags so you only complete the remainder. A manual allocation, once saved, stays in charge even if load tags change later — clear it to go back to using the tags. Until the field is split one way or the other, it counts in the overall total but sits out of the irrigated and dryland columns.
- **Allocate bushels (varieties).** A planting with a single variety credits all its bushels to that variety automatically. A planting with two or more varieties shows in the variety view only after you allocate its bushels among them — the page lists the plantings that still need allocation once their harvest is complete.
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
- **A variety I planted isn't in the variety view.** Its planting has multiple varieties and hasn't been allocated, or the variety was never recorded on the planting under Settings → Plantings.

## If something looks wrong

- Check the season and filters first — last visit's filters are remembered and are the usual culprit.
- Compare the field's loads (Loads page, filtered to the field and year) against the bushels shown.
- Verify planted acres and varieties on the planting.
- If the views won't foot after that, contact support.
