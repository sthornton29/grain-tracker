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

## Deploy

Works on Vercel out of the box. Set the same env vars in the Vercel project.

## PWA

Open in Safari on iPad → Share → "Add to Home Screen". The manifest + service worker make it behave like a native app.
