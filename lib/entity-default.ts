// The single seam for auto-assigning the entity on data entry.
//
// A single-entity operation should never be asked to pick an entity — every
// form and import resolves the entity through here so the behavior is uniform:
//   - exactly one entity → that entity's id (auto-assigned, field hidden or
//     shown pre-filled/disabled);
//   - zero or 2+ entities → null (explicit selection required, exactly the
//     behavior multi-entity operations have always had).
//
// IMPORTANT: always call this with the entity list you just fetched/rendered —
// never cache its answer across navigation. The moment a second entity is
// created the answer flips to null and every surface reverts to explicit
// selection on its next render.
//
// resolveUploadEntityId (lib/crop-insurance.ts) layers choice/fallback
// precedence on top of this same rule for the policy upload flows.

export function defaultEntityId(
  entities: ReadonlyArray<{ id: string }> | null | undefined,
): string | null {
  if (!entities || entities.length !== 1) return null
  return entities[0].id
}
