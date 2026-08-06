// Pure assembly of the support email (/api/support-request sends it via
// Resend). Kept pure so the payload — every context field, the transcript on
// escalation — is unit-tested.

export type SupportContext = {
  userEmail: string
  orgName: string
  role: string
  route: string
  version: string
  browser: string
}

export type SupportInput = {
  subject: string
  message: string
  transcript?: string
}

export function buildSupportEmail(input: SupportInput, ctx: SupportContext): { subject: string; text: string } {
  const subject = `[Turnrow support] ${input.subject || 'Support request'} — ${ctx.orgName}`
  const lines = [
    input.message.trim(),
    '',
    '--------------------------------',
    `From:    ${ctx.userEmail} (${ctx.role})`,
    `Farm:    ${ctx.orgName}`,
    `Page:    ${ctx.route}`,
    `Build:   ${ctx.version}`,
    `Browser: ${ctx.browser}`,
  ]
  if (input.transcript && input.transcript.trim()) {
    lines.push('', '---- Assistant conversation ----', input.transcript.trim())
  }
  return { subject, text: lines.join('\n') }
}
