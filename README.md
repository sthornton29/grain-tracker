# Grain Tracker

Next.js + Supabase app for tracking grain truck loads. Mobile-friendly, PWA-installable.

## Setup

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill in your Supabase URL and anon key.
3. In the Supabase SQL editor, run `supabase/schema.sql` to create tables + RLS policies.
4. In Supabase Auth settings, create a user (email/password) — only users in the `auth.users` table can sign in.
5. `npm run dev`

## Deploy

Works on Vercel out of the box. Set the two env vars in the Vercel project.

## PWA

Open in Safari on iPad → Share → "Add to Home Screen". The manifest + service worker make it behave like a native app.
