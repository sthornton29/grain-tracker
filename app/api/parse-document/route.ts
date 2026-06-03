import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-6'
const MAX_TOKENS = 4096

// Server-side cap on the decoded PDF size. The browser also enforces 20 MB on
// the raw file; this is the corresponding base64-payload check so we don't ship
// oversized blobs to Anthropic.
const MAX_PDF_BYTES = 20 * 1024 * 1024
const MAX_BASE64_LEN = Math.ceil((MAX_PDF_BYTES * 4) / 3) + 16

// Photos are compressed client-side (longest edge 2000px, JPEG q0.85), so each
// page is well under a megabyte. Cap the combined base64 across all pages and
// the page count as a backstop against a runaway payload.
const MAX_IMAGES = 20
const MAX_IMAGES_BASE64_LEN = Math.ceil((25 * 1024 * 1024 * 4) / 3) + 16
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

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

const BROKERAGE_PROMPT = `This is a daily brokerage statement from a commodity futures broker (likely R.J. O'Brien). Extract all positions and trades from the document.

The statement has up to three sections:
1. CONFIRMATION - today's new trades
2. PURCHASE & SALE - closed positions with realized profit/loss
3. OPEN POSITIONS - currently held positions

CRITICAL RULES FOR DETERMINING LONG VS SHORT:

1. The OPEN POSITIONS section has two quantity columns: LONG and SHORT. The number of contracts appears in ONE of these columns. The other column is blank for that row.

2. PRIMARY METHOD: Look at the DEBIT(DR)/CREDIT column and compare to the current market price vs trade price:
   - If the current settlement price (shown on the subtotal line with an asterisk like "30*" followed by a price) is HIGHER than the trade_price AND the P&L shows "DR" (debit/loss), the position is SHORT. This is because a short seller loses money when prices go up.
   - If the settlement price is HIGHER than the trade_price AND the P&L shows a credit (no DR), the position is LONG. A long buyer gains money when prices go up.
   - If the settlement price is LOWER than the trade_price AND the P&L shows "DR", the position is LONG (long buyer loses when prices drop).
   - If the settlement price is LOWER than the trade_price AND the P&L shows a credit, the position is SHORT (short seller gains when prices drop).

3. FARMER CONTEXT: This is a farmer's hedging account. Farmers almost always SHORT (sell) futures to lock in prices for crops they are growing. If ambiguous, default to SHORT, but still apply rule #2 above.

4. For the PURCHASE & SALE section (closed trades): if the SELL column has the quantity on the opening trade date (first line) and the BUY column has the quantity on the closing date (second line), the position was originally SHORT (sold first, bought back to close). If BUY is first and SELL is second, it was LONG.

For each OPEN POSITION, extract:
- trade_date (format YYYY-MM-DD — the statement may show dates as M/DD/Y like "3/09/6" meaning 2026-03-09)
- side ("long" or "short" — determine using the CRITICAL RULES above; apply them to every line and do NOT default to "long")
- num_contracts (the number of contracts)
- contract_description (exactly as shown, e.g., "DEC 26 CORN", "NOV 26 SOYBEANS", "JUL 27 WHEAT")
- commodity (parsed from description: "CORN", "SOYBEANS", or "WHEAT" — ignore COTTON or other commodities)
- contract_month (parsed from description, e.g., "DEC 26", "NOV 26", "JUL 27")
- trade_price (as a decimal number — convert fractional prices: "4.93 1/4" = 4.9325, "11.43 1/2" = 11.435, "6.16 1/2" = 6.165)
- unrealized_pnl (the DEBIT(DR)/CREDIT amount — negative if DR, positive if credit)

For each PURCHASE & SALE (closed trade), extract:
- open_trade_date (format YYYY-MM-DD)
- close_trade_date (format YYYY-MM-DD)
- side ("long" or "short" — determine using CRITICAL RULE #4 above: sold first then bought back = short; bought first then sold = long)
- num_contracts (the number of contracts)
- contract_description (e.g., "JUL 26 CORN")
- commodity (parsed from description)
- contract_month (e.g., "JUL 26")
- open_price (decimal, converted from fractional)
- close_price (decimal, converted from fractional)
- realized_pnl (the GROSS PROFIT/LOSS amount — negative if DR)

ALSO extract any OPTIONS positions from the statement. Options appear in the OPEN POSITIONS section and may look like:
- "DEC 26 CORN 480 PUT" (a put option on DEC 26 Corn with strike price 480, meaning $4.80/bu)
- "NOV 26 SOYBEANS 1150 CALL" (a call option on NOV 26 Soybeans with strike 1150, meaning $11.50/bu)
- The strike price is typically shown as a whole number that needs to be converted to dollars per bushel (480 = $4.80, 1150 = $11.50, 650 = $6.50)

For each OPTIONS position, extract:
- trade_date (format YYYY-MM-DD)
- side ("buy" if the position shows a debit/premium paid, "sell" if credit/premium received. Use the same long/short column logic: if quantity is in the LONG column it was bought, SHORT column means it was sold)
- option_type ("put" or "call")
- num_contracts (number)
- commodity ("Corn", "Soybeans", or "Chicago Wheat" — ignore COTTON)
- underlying_contract_month (e.g., "DEC 26")
- strike_price (decimal dollars per bushel — convert from the whole number shown: 480 = 4.80)
- premium_cents (the trade price shown, in cents per bushel — e.g., if price shows "15 1/2" that means 15.5 cents)
- unrealized_pnl (the debit/credit amount — negative if DR)

For each CLOSED option (offset in PURCHASE & SALE), extract open_trade_date, close_trade_date, side, option_type, num_contracts, commodity, underlying_contract_month, strike_price, open_premium_cents, close_premium_cents, and realized_pnl (GROSS, negative if DR).

Also extract the account summary:
- statement_date (format YYYY-MM-DD)
- beginning_balance (decimal)
- ending_balance (decimal)
- open_trade_equity (decimal — negative if DR)
- total_equity (decimal)
- margin_requirement (decimal)
- excess_equity (decimal)

IMPORTANT: Dates on these statements use abbreviated years. "3/09/6" means March 9, 2026. "5/05/6" means May 5, 2026. Use the statement date's year as context for interpreting 2-digit years.

IMPORTANT: Ignore any COTTON positions — only extract CORN, SOYBEANS, and WHEAT.

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "statement_date": "YYYY-MM-DD",
  "open_positions": [
    {
      "trade_date": "YYYY-MM-DD",
      "side": "long or short",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat",
      "contract_month": "string like DEC 26",
      "trade_price": number,
      "unrealized_pnl": number
    }
  ],
  "closed_trades": [
    {
      "open_trade_date": "YYYY-MM-DD",
      "close_trade_date": "YYYY-MM-DD",
      "side": "long or short",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat",
      "contract_month": "string like JUL 26",
      "open_price": number,
      "close_price": number,
      "realized_pnl": number
    }
  ],
  "open_options": [
    {
      "trade_date": "YYYY-MM-DD",
      "side": "buy or sell",
      "option_type": "put or call",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat",
      "underlying_contract_month": "string like DEC 26",
      "strike_price": number,
      "premium_cents": number,
      "unrealized_pnl": number
    }
  ],
  "closed_options": [
    {
      "open_trade_date": "YYYY-MM-DD",
      "close_trade_date": "YYYY-MM-DD",
      "side": "buy or sell",
      "option_type": "put or call",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat",
      "underlying_contract_month": "string like DEC 26",
      "strike_price": number,
      "open_premium_cents": number,
      "close_premium_cents": number,
      "realized_pnl": number
    }
  ],
  "account_summary": {
    "beginning_balance": number,
    "ending_balance": number,
    "open_trade_equity": number,
    "total_equity": number,
    "margin_requirement": number,
    "excess_equity": number
  }
}`

const CONTRACT_PROMPT = `This is a grain purchase contract between a farmer and a grain buyer or elevator. Extract the contract details. For any field you cannot determine, use null — do not guess.

First determine the contract type:
- "forward" — a flat cash price per bushel is locked in (most common).
- "hta" — Hedge-to-Arrive: the futures price is locked now, the basis is set later.
- "basis" — the basis is locked now, the futures price is set later.

Extract these fields:
- contract_number (the contract or confirmation number)
- buyer_name (the grain buyer / elevator company name)
- crop (the commodity, e.g. "Corn", "Soybeans", "Wheat")
- contract_type ("forward", "hta", or "basis")
- contract_month (the futures contract month referenced, formatted as a 3-letter month + 2-digit year like "DEC 26", "JUL 27", "NOV 26")
- crop_year (the production/crop year as a 4-digit number, e.g. 2026)
- contracted_bushels (total bushels on the contract, as a number)
- futures_price (futures reference price in DOLLARS per bushel — convert fractional grain prices: "4.93 1/4" = 4.9325, "11.43 1/2" = 11.435)
- basis (basis in DOLLARS per bushel — this equals cash_price minus futures_price). SIGN MATTERS: a basis "over" the futures (cash ABOVE futures) is POSITIVE (e.g. +0.10); a basis "under" the futures (cash BELOW futures) is NEGATIVE (e.g. -0.30). When both a futures price and a cash price are present, compute basis = cash_price − futures_price so the sign is correct — do not just copy a number whose sign you are unsure of.
- cash_price (the flat cash price in DOLLARS per bushel; for a forward contract this is the locked price)
- IMPORTANT consistency check: futures_price + basis must equal cash_price (minus any service_fee). If your extracted values don't satisfy this, re-read the basis sign.
- service_fee (any per-bushel service or elevator fee in DOLLARS, if stated; otherwise null)
- delivery_type ("delivered" if the producer delivers to a location, "pickup" if picked up at the farm)
- delivery_start_date and delivery_end_date (the delivery window, format YYYY-MM-DD)
- notes (any other notable terms worth recording — keep brief)

Respond ONLY in JSON with no other text and no markdown backticks:
{
  "contract_number": "string or null",
  "buyer_name": "string or null",
  "crop": "string or null",
  "contract_type": "forward or hta or basis or null",
  "contract_month": "string like DEC 26 or null",
  "crop_year": number or null,
  "contracted_bushels": number or null,
  "futures_price": number or null,
  "basis": number or null,
  "cash_price": number or null,
  "service_fee": number or null,
  "delivery_type": "delivered or pickup or null",
  "delivery_start_date": "YYYY-MM-DD or null",
  "delivery_end_date": "YYYY-MM-DD or null",
  "notes": "string or null"
}`

const FIELDS_PROMPT = `This document lists a farm operation's fields and their acreage — it may be an FSA-578 Report of Acreage, a crop-insurance acreage report, or an informal field/acreage list. Extract every distinct field (or tract/field combination). For any value you cannot determine, use null — do not guess.

For each field, extract:
- field_name (the field's name or number. If only a tract and field number are shown, combine them like "T1234 F2". Prefer a plain field name when one is present)
- farm_name (the farm or operation name this field belongs to, if shown — else null)
- total_acres (the field's total farmland/cropland acres as a number — else null)
- irrigated_acres (acres under irrigation if the document distinguishes irrigated vs dryland practice — else null)

List each physical field once. If the same field appears on multiple crop lines, still report it a single time with its total acreage.

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "fields": [
    {
      "field_name": "string",
      "farm_name": "string or null",
      "total_acres": number or null,
      "irrigated_acres": number or null
    }
  ]
}`

const PLANTINGS_PROMPT = `This document lists crops planted on fields for a season — it may be an FSA-578 Report of Acreage, a crop-insurance acreage report, or a planting schedule. Extract every planting line (one row per field + crop). For any value you cannot determine, use null — do not guess.

For each planting, extract:
- field_name (the field name or number the crop is planted on. Combine tract + field like "T1234 F2" if no plain name is shown)
- crop (the commodity name, e.g. "Corn", "Soybeans", "Wheat", "Cotton")
- season_year (the 4-digit crop/harvest year if shown — else null)
- planted_acres (planted/reported acres for this field+crop as a number)
- irrigated_acres (irrigated acres for this line if the practice is distinguished — else null)
- planting_date (the planting/seeding date, format YYYY-MM-DD — else null)
- varieties (a list of {variety, acres} for any hybrid/variety/seed names shown on this field+crop line. Use the per-variety acres when shown; if a single variety is listed without its own acres, set acres to the planted_acres; if no variety information is shown, return []. Example variety names: "P2089", "DKC65-95", "AG46X9", "Croplan 5380".)
- notes (any short note worth keeping, e.g. an intended-use or practice code — else null)

Multiple varieties on the same field+crop+year belong on the SAME row, inside the varieties array. Do not split a single field+crop line into multiple rows just because more than one variety is listed.

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "plantings": [
    {
      "field_name": "string",
      "crop": "string or null",
      "season_year": number or null,
      "planted_acres": number or null,
      "irrigated_acres": number or null,
      "planting_date": "YYYY-MM-DD or null",
      "varieties": [{"variety": "string", "acres": number or null}],
      "notes": "string or null"
    }
  ]
}`

type DocumentType = 'settlement' | 'tickets' | 'brokerage_statement' | 'contract' | 'fields' | 'plantings'

const PROMPTS: Record<DocumentType, string> = {
  settlement: SETTLEMENT_PROMPT,
  tickets: TICKETS_PROMPT,
  brokerage_statement: BROKERAGE_PROMPT,
  contract: CONTRACT_PROMPT,
  fields: FIELDS_PROMPT,
  plantings: PLANTINGS_PROMPT,
}

type ParseBody = {
  pdf_base64?: unknown
  images?: unknown
  document_type?: unknown
}

type ImageInput = { media_type: string; data: string }

// Validate the images[] payload into well-typed image blocks, or return an
// error string describing the first problem found.
function validateImages(raw: unknown): { images: ImageInput[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'images must be a non-empty array.' }
  if (raw.length > MAX_IMAGES) return { error: `Too many photos — ${MAX_IMAGES} pages max per document.` }
  const out: ImageInput[] = []
  let totalLen = 0
  for (const item of raw) {
    const media_type = (item as { media_type?: unknown })?.media_type
    const data = (item as { data?: unknown })?.data
    if (typeof media_type !== 'string' || !ALLOWED_IMAGE_TYPES.has(media_type)) {
      return { error: 'Each image needs a media_type of image/jpeg, png, webp, or gif.' }
    }
    if (typeof data !== 'string' || data.length === 0) {
      return { error: 'Each image needs base64 data.' }
    }
    totalLen += data.length
    out.push({ media_type, data })
  }
  if (totalLen > MAX_IMAGES_BASE64_LEN) return { error: 'Photos exceed the 25 MB combined size limit.' }
  return { images: out }
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

  const documentType = body.document_type
  if (typeof documentType !== 'string' || !(documentType in PROMPTS)) {
    return badRequest('document_type must be one of: ' + Object.keys(PROMPTS).join(', ') + '.')
  }
  const docType = documentType as DocumentType

  // Build the document content block(s): either a single PDF (existing path) or
  // one or more compressed photos. The text prompt is identical either way.
  const pdfBase64 = typeof body.pdf_base64 === 'string' ? body.pdf_base64 : ''
  let docBlocks: Anthropic.ContentBlockParam[]
  if (body.images !== undefined) {
    const v = validateImages(body.images)
    if ('error' in v) return badRequest(v.error)
    docBlocks = v.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type as 'image/jpeg', data: img.data },
    }))
  } else if (pdfBase64) {
    if (pdfBase64.length > MAX_BASE64_LEN) return badRequest('PDF exceeds the 20 MB size limit.')
    docBlocks = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
    ]
  } else {
    return badRequest('pdf_base64 or images is required.')
  }

  const prompt = PROMPTS[docType]

  const client = new Anthropic({ apiKey })

  let resp
  try {
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [...docBlocks, { type: 'text', text: prompt }],
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
