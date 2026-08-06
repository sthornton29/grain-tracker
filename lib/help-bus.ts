// Tiny client-side event bus so any page can deep-open the help drawer to a
// topic ("Learn more" links) without prop-drilling through layouts. The
// drawer (components/help/help-drawer.tsx) listens.

export const HELP_OPEN_EVENT = 'turnrow:open-help'

export type HelpOpenDetail = { route?: string }

export function openHelp(route?: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<HelpOpenDetail>(HELP_OPEN_EVENT, { detail: { route } }))
}
