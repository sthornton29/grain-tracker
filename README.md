# Turnrow

Next.js + Supabase farm-operations app for Turnrow Farm (formerly "Grain Tracker" — the repo,
database, and env names keep the old identifiers; the rename is display-layer only).
Mobile-friendly, PWA-installable. Brand assets live in `public/brand/`.

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in the keys — Supabase URL + anon key
   (required), plus `ANTHROPIC_API_KEY` (AI document parsing + lookup fallback),
   `BARCHART_API_KEY` (live futures pricing), and `NASS_API_KEY` (USDA monthly MYA prices —
   free at https://quickstats.nass.usda.gov/api). Each optional key degrades gracefully.
3. In the Supabase SQL editor, run `supabase/schema.sql` to create tables + RLS policies.
4. In Supabase Auth settings, create a user (email/password) — only users in the `auth.users` table can sign in.
5. `npm run dev`

## Help & support content

User-facing documentation lives in `docs/help/` — one markdown file per page, written in plain
farmer language (front-matter: `page_route`, `title`, `updated`, `keywords`). `npm run help:build`
compiles them into `docs/help/_digest.md` (the support chatbot's knowledge) and
`lib/help-content.generated.ts` (bundled into the help drawer and `/help`), stamped with the date
and commit — and **fails if any nav or reports route lacks a help topic**, which the test suite
also enforces in CI. The ritual when behavior changes: update the affected help files (bump
`updated:`), regenerate PROJECT_SUMMARY.md, run `npm run help:build`, commit the outputs.
`docs/help/_limitations.md` is the "what Turnrow does NOT do" list that keeps the chatbot honest.

Support email (`/api/support-request`) sends via Resend — set `RESEND_API_KEY` (and optionally
`SUPPORT_FROM`) in the environment; the chatbot (`/api/support-chat`) uses `ANTHROPIC_API_KEY`.

## Deploy

Works on Vercel out of the box. Set the same env vars in the Vercel project.

## PWA

Open in Safari on iPad → Share → "Add to Home Screen". The manifest + service worker make it behave like a native app.
