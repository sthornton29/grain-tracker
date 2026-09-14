// Schema digest for the data assistant's query_data tool.
//
// GENERATED, not hand-maintained: scripts/build-assistant-schema.mjs parses
// every migration (create table + add/drop column) and takes the tenant
// table list from supabase/054_org_isolation.sql — the same canonical set the
// multi-tenant verify scripts use — so EVERY tenant table is in the digest
// with its columns, key relationships, enum values, unit conventions and a
// one-line description + the page it belongs to. lib/assistant-schema.test.ts
// is the CI gate: a tenant table missing from the digest fails the build.
// Run `npm run schema:build` (part of `npm run help:build`) after a migration.
//
// Isolation note: every query runs as the user via RLS — this text is
// documentation, not a security boundary.

export { ASSISTANT_SCHEMA_SUMMARY, ASSISTANT_SCHEMA_TABLES, ASSISTANT_SCHEMA_GENERATED, type AssistantSchemaTable } from '@/lib/assistant-schema.generated'
