// SINGLE SOURCE OF TRUTH for the Settings area: group order, page order, the
// one display name each page uses (tile, rail, H1, breadcrumb, help topic
// title), and the one-line description on the hub tile. The hub
// (app/settings/page.tsx) and the left rail (app/settings/layout.tsx) both
// render from this, so they cannot drift. Every href here needs a
// docs/help topic.

export type SettingsNavItem = {
  href: string
  label: string
  /** One plain-language line for the hub tile. */
  description: string
}

export type SettingsNavGroup = { title: string; items: SettingsNavItem[] }

export const SETTINGS_GROUPS: SettingsNavGroup[] = [
  {
    title: 'Your operation',
    items: [
      { href: '/settings/entities', label: 'Entities', description: 'The companies and people that farm — LLCs, partnerships, individuals — and their counties.' },
      { href: '/settings/landowners', label: 'Landowners', description: 'Who you rent from: contact details, who the rent check is made out to.' },
      { href: '/settings/farms', label: 'Farms', description: 'Each FSA farm — its entity, county, farm number, landowner, and share-rent terms.' },
      { href: '/settings/fields', label: 'Fields', description: 'The fields on each farm, with total and irrigated acres.' },
      { href: '/settings/plantings', label: 'Field Plantings', description: 'What was planted where — by field, crop, and season, with varieties.' },
      { href: '/settings/crops', label: 'Crops', description: 'Your crops, their harvest season, and the “sold out for the year” checkbox.' },
      { href: '/settings/varieties', label: 'Varieties', description: 'Every seed variety across your plantings — rename and merge duplicates.' },
    ],
  },
  {
    title: 'Storage & hauling',
    items: [
      { href: '/settings/bin-sites', label: 'Bin Sites & Bins', description: 'Where grain is stored — sites, bins, and bin capacities.' },
      { href: '/settings/trucks', label: 'Trucks', description: 'Your trucks, plus the hired hauler trucks the load form offers.' },
    ],
  },
  {
    title: 'Buyers & contracts',
    items: [
      { href: '/settings/buyers', label: 'Buyers & Delivery Locations', description: 'Elevators, terminals, and gins you sell and haul to, with their discount schedules.' },
      { href: '/settings/contracts', label: 'Contract list (bulk edit)', description: 'Every grain contract in one editable list — for cleanup and imports. Day-to-day work lives on the Contracts tab.' },
    ],
  },
  {
    title: 'Programs',
    items: [
      { href: '/settings/crop-insurance', label: 'Crop Insurance', description: 'Your policies — plan, coverage, APH, acres, premium — that the insurance reports run on.' },
      { href: '/settings/government-payments', label: 'Government Payments', description: 'Base acres, ARC/PLC elections, and the program prices behind the payment projections.' },
    ],
  },
  {
    title: 'People & sharing',
    items: [
      { href: '/settings/users', label: 'Users', description: 'Who can sign in and what each person is allowed to see.' },
      { href: '/settings/organization', label: 'Organization', description: 'Your name and logo on documents you send out, and the Cotton switch.' },
      { href: '/settings/shares', label: 'Landowner Shares', description: 'Give a landowner read-only access to their own farms in their software.' },
      { href: '/settings/farm-link', label: 'Turnrow Farm Link', description: 'Connect to Turnrow Farm so land records and results flow between the two.' },
    ],
  },
]

/** Every settings page in display order (for the coverage check and lookups). */
export const SETTINGS_ITEMS: SettingsNavItem[] = SETTINGS_GROUPS.flatMap((g) => g.items)

/** The settings page a pathname belongs to (longest matching href), or null
 *  for the hub itself and unknown routes. */
export function settingsItemFor(pathname: string | null | undefined): SettingsNavItem | null {
  if (!pathname) return null
  let best: SettingsNavItem | null = null
  for (const item of SETTINGS_ITEMS) {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (best == null || item.href.length > best.href.length) best = item
    }
  }
  return best
}
