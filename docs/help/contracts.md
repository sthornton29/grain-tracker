---
page_route: /contracts
title: Contracts
updated: 2026-09-30
keywords: contracts, forward, cash, HTA, basis, futures, pricing, delivered, contracted, first notice day, delivery window, attachments, entity, seed, seed contract, seed production
---
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
