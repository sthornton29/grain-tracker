---
page_route: /settings/farm-link
title: Turnrow Farm Link
updated: 2026-09-17
keywords: turnrow farm, farm link, pairing code, link token, integrations, sync, managed in turnrow farm, not linked, entities, farms, fields, plantings, production, marketing, income, bins, cost assumptions, rent statements, revoke, rotate token, conflict
---
## What this page is for

Turnrow Farm and Turnrow Grain are two halves of the same operation. Turnrow Farm keeps your land: entities, farms, fields, boundaries, and what was planted where. Turnrow Grain keeps what happens after: loads, bins, contracts, settlements, hedging, crop insurance, government payments, and marketing. This page connects the two so each side stops re-typing the other's work.

Once connected, Turnrow Farm sends your entities, farms, fields, and plantings here and keeps them current. Turnrow Grain sends back production, marketing, income, and bin inventory. Because both sides are your own organization, everything is shared unless you turn a switch off.

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
- **Cost assumptions from Turnrow Farm** — Turnrow Farm's planning cost per acre lands in the Marketing report's assumptions (with the irrigated, dryland, and double-crop breakouts) and in any Crop Budget marked to follow Turnrow Farm. The Marketing report labels these "from Turnrow Farm, updated (date)" and has a **Use my own costs** switch per crop that keeps what you type.
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

## If something looks wrong

- Turnrow Farm says the pairing code is invalid or expired: generate a new code here and paste it again.
- Turnrow Farm reports "unauthorized": rotate the token here and paste the new one there.
- The page says the link needs a database update: contact support.
