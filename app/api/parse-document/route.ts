import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 4096

// Server-side cap on the decoded PDF size. The browser also enforces 20 MB on
// the raw file; this is the corresponding base64-payload check so we don't ship
// oversized blobs to Anthropic.
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_BASE64_LEN = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 16

const SETTLEMENT_PROMPT = `This is a grain settlement sheet from a grain buyer. Extract every line item from this document. For each line item, extract:
- ticket_number (the scale ticket or load ticket number)
- net_bushels (the net bushels paid for on this line)
- gross_revenue (the gross dollar amount before any discounts or deductions for this line)
- discounts (the total dollar amount of all discounts, deductions, checkoff fees, or adjustments subtracted from gross revenue for this line — if there are multiple discount types, sum them into one number)

Also extract these document-level fields:
- buyer_name (the company name of the buyer/elevator)
- settlement_date (the date on the settlement, format YYYY-MM-DD)
- settlement_number (any reference number, check number, or settlement ID — null if not found)

Respond ONLY in JSON with no other text, no markdown backticks. Use this exact format:
{
  "buyer_name": "string",
  "settlement_date": "YYYY-MM-DD",
  "settlement_number": "string or null",
  "line_items": [
    {
      "ticket_number": "string",
      "net_bushels": number,
      "gross_revenue": number,
      "discounts": number
    }
  ]
}`

const TICKETS_PROMPT = `This PDF contains one or more scanned grain hauling tickets or scale tickets. Each ticket represents one truck load of grain. Extract every individual ticket/load from the document. For each ticket, extract:
- ticket_number (the ticket number if printed or handwritten on the ticket — null if not visible)
- date (the date on the ticket, format YYYY-MM-DD — null if not visible)
- time (the time on the ticket, format HH:MM in 24hr — null if not visible)
- truck (truck number or truck identifier — null if not visible)
- crop (the crop or commodity name if listed — null if not visible)
- gross_weight (gross weight in pounds — null if not visible)
- tare_weight (tare weight in pounds — null if not visible)
- net_weight (net weight in pounds — null if not visible. If gross and tare are present but net is not, calculate it)
- moisture (moisture percentage as a decimal number like 14.5 — null if not visible)
- test_weight (test weight in lbs per bushel — null if not visible)
- from_type ("field" or "bin" — infer from context if possible, null if unclear)
- from_name (field name/number or bin name/number for where the grain is coming from — null if not visible)
- to_type ("bin" or "buyer" — infer from context if possible, null if unclear)
- to_name (bin name/number or buyer name for where the grain is going — null if not visible)

Respond ONLY in JSON with no other text, no markdown backticks. Use this exact format:
{
  "tickets": [
    {
      "ticket_number": "string or null",
      "date": "YYYY-MM-DD or null",
      "time": "HH:MM or null",
      "truck": "string or null",
      "crop": "string or null",
      "gross_weight": number or null,
      "tare_weight": number or null,
      "net_weight": number or null,
      "moisture": number or null,
      "test_weight": number or null,
      "from_type": "field or bin or null",
      "from_name": "string or null",
      "to_type": "bin or buyer or null",
      "to_name": "string or null"
    }
  ]
}`

type ParseBody = {
  pdf_base64?: unknown
  document_type?: unknown
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

function serverError(message: string) {
  return NextResponse.json({ error: message }, { status: 500 })
}

// Strip any stray markdown fences / leading prose. Anthropic occasionally
// wraps JSON in ```json … ``` even when told not to.
function extractJson(text: string): string {
  let s = text.trim()
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first >= 0 && last > first) return s.slice(first, last + 1)
  return s
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return serverError('ANTHROPIC_API_KEY is not configured on the server.')

  let body: ParseBody
  try {
    body = (await req.json()) as ParseBody
  } catch {
    return badRequest('Request body must be JSON.')
  }

  const pdfBase64 = typeof body.pdf_base64 === 'string' ? body.pdf_base64 : ''
  const documentType = body.document_type
  if (!pdfBase64) return badRequest('pdf_base64 is required.')
  if (documentType !== 'settlement' && documentType !== 'tickets') {
    return badRequest('document_type must be "settlement" or "tickets".')
  }
  if (pdfBase64.length > MAX_BASE64_LEN) {
    return badRequest('PDF exceeds the 20 MB size limit.')
  }

  const prompt = documentType === 'settlement' ? SETTLEMENT_PROMPT : TICKETS_PROMPT

  const client = new Anthropic({ apiKey })

  let resp
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    })
  } catch (e: any) {
    const msg = e?.error?.error?.message ?? e?.message ?? 'Anthropic API call failed.'
    return serverError(`Anthropic API error: ${msg}`)
  }

  const textBlock = resp.content.find((c: any) => c.type === 'text') as { type: 'text'; text: string } | undefined
  if (!textBlock) return serverError('Anthropic returned no text content.')

  const jsonStr = extractJson(textBlock.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return serverError("Couldn't parse the response as JSON. The PDF may be unclear.")
  }

  return NextResponse.json({ data: parsed })
}
