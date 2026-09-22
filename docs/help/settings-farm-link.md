---
page_route: /settings/farm-link
title: Turnrow Farm Link
updated: 2026-09-21
keywords: turnrow farm, farm link, landowners both ways, landowner conflict, merge landowners, archive landowner, lease managed in turnrow farm, withdrawn statement, pairing code, link token, integrations, sync, managed in turnrow farm, not linked, entities, farms, fields, plantings, production, marketing, income, bins, crop insurance premiums, insurance included in cost, cost assumptions, rent statements, revoke, rotate token, conflict
---
## What this page is for

Turnrow Farm and Turnrow Grain are two halves of the same operation. Turnrow Farm keeps your land: entities, farms, fields, boundaries, and what was planted where. Turnrow Grain keeps what happens after: loads, bins, contracts, settlements, hedging, crop insurance, government payments, and marketing. This page connects the two so each side stops re-typing the other's work.

Once connected, Turnrow Farm sends your entities, farms, fields, and plantings here and keeps them current. Turnrow Grain sends back production, marketing, income, bin inventory, and your crop insurance premiums. Because both sides are your own organization, everything is shared unless you turn a switch off.

## How to connect

1. Press **Generate pairing code**. The code appears once — copy it right away. It expires in 7 days if unused.
2. In Turnrow Farm, go to **Settings > Integrations > Turnrow Grain** and paste the code.
3. Turnrow Farm completes the pairing on its own. This page then shows **Connected** with the name of your Turnrow Farm organization.

If the code expires or you lose it, press **New pairing code**; the old one stops working.

## What changes once land is synced

After Turnrow Farm's first land sync lands, the **Entities, Farms, Fields, and Plantings** pages show a "Managed in Turnrow Farm" banner. Rows that came from Turnrow Farm are read-only here (edit them there; the change syncs back). Rows you created here that Turnrow Farm has not matched yet show a **not linked** chip and stay editable until you match them in Turnrow Farm. The spreadsheet and document importers for those four pages stop running and say so. Entities keep their county assignments and payment-limit persons editable here, because Turnrow Farm does not track those.

Deleting a farm, field, or planting in Turnrow Farm archives it here rather than deleting it, and Turnrow Grain refuses to archive a field or planting that already has loads, yields, or settlements; Turnrow Farm shows you that refusal.

If you edit a record here after the last sync and Turnrow Farm later sends a different value for it, Turnrow Grain keeps yours and hands the conflict back to Turnrow Farm to resolve. Nothing is overwritten quietly. The count of conflicts from the last sync shows on this page.

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

## Rotate token and Revoke

- **Rotate token** issues a new link token, shown once. Paste it into Turnrow Farm under the same Integrations page; the old token stops working immediately.
- **Revoke** ends the link. Turnrow Farm loses access at once. Records already synced stay here and become editable again.

## Common questions

- **A farm shows "edit in Turnrow Farm" but I need to change its county.** Change it in Turnrow Farm; the next sync brings it here.
- **A field I created here says "not linked".** Open Turnrow Farm and match it to the field there. Until you do, it stays editable here.
- **The last sync shows conflicts.** Open Turnrow Farm; it lists the records and lets you choose which side is right.
- **Nothing has synced yet.** The land pages stay fully editable until Turnrow Farm sends its first land sync.
- **Turnrow Farm does not offer crop insurance premiums.** This switch is newer than the link. Make sure **Crop insurance premiums to Turnrow Farm** is on above, then pair again from Turnrow Farm and choose **Sync now**.
- **I changed a landowner here and Turnrow Farm still shows the old one.** It arrives on the next sync. If you both changed the same thing, Turnrow Farm shows it as something to settle rather than picking a winner.
- **A landowner shows "from Turnrow Farm" beside a field.** That field was changed over there in the last day. It is only a note; you can edit it here whenever you like.
- **Turnrow Farm wants to merge two landowners.** Merging moves their farms, leases, settlements, and statements onto the one you keep, and archives the other. A landowner with a live Turnrow Landowner share is not merged or archived until you end the share or choose to move it.
- **The premium in Turnrow Farm does not match mine.** It is the total of every policy for that entity, crop, and practice, riders included, and it is the amount you pay after the subsidy. Check the policies under Settings > Crop Insurance for the same crop year.

## If something looks wrong

- Turnrow Farm says the pairing code is invalid or expired: generate a new code here and paste it again.
- Turnrow Farm reports "unauthorized": rotate the token here and paste the new one there.
- The page says the link needs a database update: contact support.
