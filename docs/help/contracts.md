---
page_route: /contracts
title: Contracts
updated: 2026-08-06
keywords: contracts, forward, cash, HTA, basis, futures, pricing, delivered, contracted, first notice day, delivery window, attachments, entity
---
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

- **Date sold** — an optional date on each contract recording when you made the sale. Informational: it prints on the contract page and exports, and doesn't change any delivery or payment math.

- **Filters** narrow by type, pricing status, crop year, and more; **Hide completed** tucks away finished contracts.
- **Warnings** appear at the top for contracts approaching risk: an HTA or basis contract with pricing still open whose contract month's first notice day is within 30 days (or already past), and contracts whose delivery window ends within 14 days. Both warnings stop once a contract is completed — marked complete or fully delivered — since there's nothing left to price or deliver.
- **Entity** on a contract is optional. Leave it blank when the contract belongs to the operation as a whole. Pick an entity when one company holds the contract in its own name. If your operation markets everyone's grain through a single marketing company, put that company on the contract — entity-filtered reports then share its bushels out to the farming entities by their share of the acres.
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
