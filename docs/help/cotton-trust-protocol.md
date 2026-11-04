---
page_route: /cotton/trust-protocol
title: Cotton — Trust Protocol
updated: 2026-11-04
keywords: trust protocol, U.S. Cotton Trust Protocol, Regen, U.S. Regen, regenerative, field partner, bale upload, bale registration, register bales, protocol ID, producer ID, API key, gin code, gin tag, PBI, upload grower bales, bale correction, remove bale, check status, pending, verified, reg_2026.csv, reg file, fixed width, CSV template, The Seam, TextileGenesis, fibrecoin
---
## What this page is for

The Trust Protocol page registers your bales with the **U.S. Cotton Trust Protocol** straight from Turnrow, designates them **U.S. Regen** under your Field Partner program, and shows what the Protocol says about each bale afterwards. Every bale on your gin receipts appears here as the Protocol will receive it — your entity's Protocol ID, the gin's 5-digit USDA code, the 7-digit gin tag, the crop year and the weight — with anything that would stop it from being accepted named on the row. This page is owner-only; gin-operator logins never see it.

## How to use it

**Set up the connection once (the Connection card).**
1. Paste the **API key** the Protocol help desk issued your operation and tap Save. The key stays on Turnrow's server; the card only shows its last four characters afterwards.
2. Tap **Look up producers**. This tests the key and lists the producers the Protocol has under your program for the crop year, each with its Protocol ID, whether it is upload-eligible, its gins and its Regen program. If the Protocol reports a program code, it is filled into the Regen program box for you.
3. Save your **Regen program code** (up to 10 characters). Bales sent with "Designate U.S. Regen" ticked carry it. Leave it blank to register bales as Protocol bales only.
4. Give each **entity its Protocol ID** — the 8-character producer ID from the first page of the enrollment packet (or pick it from the producer list). A bale is registered under the entity on its gin receipt, or the receipt's farm; an operation with one entity needs nothing more.

**Send bales.**
- The crop year at the top right picks the bales. The chips filter the list: **Ready** (everything in place, not sent yet), **Needs a fix**, **Sent**, **Registered**, **Attention**. Filter by entity or gin, or find one PBI number.
- Tap **Select all ready**, tick or untick what you want, then **Send … to the Protocol**. Turnrow asks you to confirm, sends the bales (in batches of a thousand), and records the Protocol's answer under **What was sent**.
- The Protocol checks each bale on its own side afterwards — against the USDA classing records, your producers' gins and your program. The sending answer only says the batch was received, so after a few minutes tap **Check status**. Each row then shows **Registered**, **Pending at the Protocol** or **Needs attention** with the Protocol's own wording, and the Regen column shows the program the Protocol has the bale under.
- **Resend as a correction** is for bales the Protocol already has — registered earlier, or by your gin or merchant. A correction sets the Regen designation and the weight to what Turnrow holds. **Remove** takes bales off your registrations.
- **Download .csv / .txt** builds the same records as a file in the Protocol's own template (named reg_2026.csv or reg_2026.txt) for the platform's **Upload Log → Upload Grower Bales** screen — the manual route when you prefer it, or before an API key is saved. The file holds the selected ready bales, or every ready bale when nothing is selected.

## What the numbers mean

- **Registered** counts bales the Protocol confirmed on the last status check; **sent, awaiting a status check** are bales sent since then.
- **U.S. Regen** counts bales carrying a Regen program at the Protocol (or, until checked, the program they were sent with).
- **Ready to send** are bales with every detail in place that have not been sent; **need a fix first** are bales missing something — the row says what.
- A bale's **gin tag** is its 7-digit number; a 12-digit PBI tag drops the gin code at the front. Leading zeros are added back. The **gin code** comes from the gin receipt, or from the gin under Settings when the statement does not print one.
- Weights are rounded to whole pounds. The Protocol refuses a bale of 1,000 pounds or more, and accepts the current crop year and the two before it.

## Common questions

- **The row says "has no Protocol ID yet."** Enter the entity's 8-character ID on the Connection card. If you are not sure of it, Look up producers lists every producer the Protocol has under your program.
- **The row says the gin has no USDA gin code.** Add the code on the gin receipt (Gin Receipts page) or under the gin itself; a 12-digit PBI tag supplies it on its own.
- **Check status says "not found" for bales I just sent.** The Protocol may still be processing the batch — check again in a few minutes. If it stays not found, the gin code or tag on the receipt may differ from what the gin registered with USDA.
- **A bale shows "Pending at the Protocol."** Usually the producer is not yet associated with your operation as the uploading member for the crop year, or the enrollment is not complete. That is settled on the Protocol platform; the bale clears on the next status check.
- **My gin or merchant already uploaded these bales.** Use Resend as a correction on them to add your Regen designation; a plain send would be refused as already uploaded.
- **Where do I add growers to the program or complete the participation agreement?** On the Protocol platform (the Open the Protocol platform button) — Turnrow only registers bales.
- **Why can't the gin operator see this page?** It is owner-only by design, like Marketing: gin logins get the three intake pages and nothing more.

## If something looks wrong

- "The Protocol did not accept the API key": paste the key again exactly as issued; the help desk can reissue it.
- A batch under What was sent shows a red answer: the Protocol refused the whole batch — the message says why. Nothing in that batch was recorded as sent; fix the cause and send again.
- The status check reports a problem on a bale: the Protocol's own wording is on the row (for example a gin tag not in the USDA classing database, or a gin that is not one of the producer's gins for the crop year). Correct the receipt or the Protocol's producer record, then Resend as a correction or Check status again.
- Anything else, contact support.
