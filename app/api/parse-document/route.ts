import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const maxDuration = 60

const MODEL = 'claude-sonnet-4-6'
// Headroom for multi-record documents (e.g. a 156EZ packet or a multi-crop
// insurance summary) so a batch with several records doesn't truncate the JSON.
const MAX_TOKENS = 8192

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

const BROKERAGE_PROMPT = `This is a daily brokerage statement from a commodity futures broker (such as StoneX / FCStone, R.J. O'Brien, or a similar FCM). These statements share a common layout regardless of which broker issued them. Extract all positions and trades from the document.

The statement has up to three sections, identified by their headings rather than the broker name:
1. CONFIRMATION - today's new trades
2. PURCHASE & SALE - closed/offset positions, each offset group ending in a single GROSS PROFIT/LOSS total
3. OPEN POSITIONS - currently held positions

CRITICAL RULES FOR DETERMINING LONG VS SHORT:

1. The OPEN POSITIONS section has two quantity columns: LONG and SHORT. The number of contracts appears in ONE of these columns. The other column is blank for that row.

2. PRIMARY METHOD: Look at the DEBIT(DR)/CREDIT column and compare to the current market price vs trade price:
   - If the current settlement price (shown on the subtotal line with an asterisk like "30*" followed by a price) is HIGHER than the trade_price AND the P&L shows "DR" (debit/loss), the position is SHORT. This is because a short seller loses money when prices go up.
   - If the settlement price is HIGHER than the trade_price AND the P&L shows a credit (no DR), the position is LONG. A long buyer gains money when prices go up.
   - If the settlement price is LOWER than the trade_price AND the P&L shows "DR", the position is LONG (long buyer loses when prices drop).
   - If the settlement price is LOWER than the trade_price AND the P&L shows a credit, the position is SHORT (short seller gains when prices drop).

3. FARMER CONTEXT: This is a farmer's hedging account. Farmers almost always SHORT (sell) futures to lock in prices for crops they are growing. If ambiguous, default to SHORT, but still apply rule #2 above.

4. For the PURCHASE & SALE section, do NOT use rules #2/#3 — determine each offset group's side from CHRONOLOGY + COLUMN alone:
   - The lots with the EARLIEST trade dates in the group are the OPENING lots; the latest-dated transaction is the CLOSING one.
   - Opening lots' quantities in the SELL column, closing transaction in the BUY column -> side = "short" (sold first, bought back).
   - Opening lots in the BUY column, closing transaction in the SELL column -> side = "long".
   - NEVER infer the side from the sign of the GROSS PROFIT/LOSS (a short can lose money and a long can gain), and NEVER from which line is printed first — print order does not follow trade order.
   WORKED EXAMPLE: a NOV 26 SOYBEANS group shows quantities 2 and 4 dated 3/18 in the SELL column at 11.43 1/2 and 11.43 3/4, and quantity 6 dated 7/06 in the BUY column at 11.91 3/4, followed by "GROSS PROFIT/LOSS FROM TRADES 14,425.00DR". The earliest-dated lots (3/18) are in the SELL column, so this group is side "short": lots = [{ open_date "2026-03-18", open_price 11.435, contracts 2 }, { open_date "2026-03-18", open_price 11.4375, contracts 4 }], close_date "2026-07-06", close_price 11.9175, statement_reported_total -14425.00 (the DR suffix means a loss, so the value is negative — the short was bought back higher than it was sold).

For each OPEN POSITION, extract:
- trade_date (format YYYY-MM-DD — the statement may show dates as M/DD/Y like "3/09/6" meaning 2026-03-09)
- side ("long" or "short" — determine using the CRITICAL RULES above; apply them to every line and do NOT default to "long")
- num_contracts (the number of contracts)
- contract_description (exactly as shown, e.g., "DEC 26 CORN", "NOV 26 SOYBEANS", "JUL 27 WHEAT", "DEC 26 ICE COTTON 2")
- commodity (parsed from description: "CORN", "SOYBEANS", "WHEAT", or "COTTON" — ICE Cotton No. 2 lines like "DEC 26 ICE COTTON 2" are COTTON; cotton prices stay in cents/lb exactly as printed, e.g. 72.65)
- contract_month (parsed from description, e.g., "DEC 26", "NOV 26", "JUL 27")
- trade_price (as a decimal number. CBT GRAINS ONLY: convert fractional prices — "4.93 1/4" = 4.9325, "11.43 1/2" = 11.435. ICE COTTON 2 prices are already plain decimals in cents/lb (72.65, 78.30) — copy them EXACTLY, never apply fractional conversion or unit conversion to cotton)
- unrealized_pnl (the DEBIT(DR)/CREDIT amount — negative if DR, positive if credit)

PURCHASE & SALE — CLOSED OFFSET GROUPS (read this carefully):

The Purchase & Sale section lists, for each offset, one or more OPENING lots (often at different prices and on different dates) and one or more CLOSING transactions, followed by a SINGLE "GROSS PROFIT/LOSS FROM TRADES" line. That GROSS PROFIT/LOSS line is the TOTAL for the WHOLE offset group — it is NOT a per-lot value and must NOT be split across or attached to individual lots. When several opening lots are offset by one closing transaction, the SAME closing price applies to every lot in that group.

Extract ONLY the raw facts for each offset group — do NOT compute, split, or guess any profit/loss yourself. Emit one object per offset group:
- commodity ("Corn", "Soybeans", "Chicago Wheat", or "Cotton")
- contract_month (e.g., "DEC 26")
- side ("short" if the opening lots are in the SELL column and closed by a BUY; "long" if bought first and sold to close — see CRITICAL RULE #4)
- close_date (the closing transaction date, format YYYY-MM-DD)
- close_price (the closing price as a decimal — grains: convert fractional, e.g. "4.42 3/4" = 4.4275; cotton: plain decimal ¢/lb as printed)
- lots (an array with ONE entry per opening lot in this group, each: { open_date (YYYY-MM-DD), open_price (decimal; grains fractional-converted, cotton plain ¢/lb), contracts (the number of contracts in THIS lot only) }). Capture each lot's OWN contract count — three lots of ten contracts each are 10, 10, 10, never 30 and never the group's grand total.
- statement_reported_total (the group's printed GROSS PROFIT/LOSS total, as a decimal. SIGN MATTERS: a total suffixed DR is a debit/LOSS and MUST be negative; CR or no suffix is a gain and positive. "14,425.00DR" -> -14425.00). This is for reconciliation ONLY.

ALSO extract any OPTIONS positions from the statement. Options appear in the OPEN POSITIONS section and may look like:
- "DEC 26 CORN 480 PUT" (a put option on DEC 26 Corn with strike price 480, meaning $4.80/bu)
- "NOV 26 SOYBEANS 1150 CALL" (a call option on NOV 26 Soybeans with strike 1150, meaning $11.50/bu)
- The strike price is typically shown as a whole number that needs to be converted to dollars per bushel (480 = $4.80, 1150 = $11.50, 650 = $6.50)

For each OPTIONS position, extract:
- trade_date (format YYYY-MM-DD)
- side ("buy" if the position shows a debit/premium paid, "sell" if credit/premium received. Use the same long/short column logic: if quantity is in the LONG column it was bought, SHORT column means it was sold)
- option_type ("put" or "call")
- num_contracts (number)
- commodity ("Corn", "Soybeans", "Chicago Wheat", or "Cotton")
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

IMPORTANT: Extract COTTON (ICE Cotton No. 2) positions too — commodity "Cotton", prices in cents/lb exactly as printed (72.65 means 72.65 cents/lb; do NOT convert).

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "statement_date": "YYYY-MM-DD",
  "open_positions": [
    {
      "trade_date": "YYYY-MM-DD",
      "side": "long or short",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat or Cotton",
      "contract_month": "string like DEC 26",
      "trade_price": number,
      "unrealized_pnl": number
    }
  ],
  "closed_groups": [
    {
      "commodity": "Corn or Soybeans or Chicago Wheat or Cotton",
      "contract_month": "string like DEC 26",
      "side": "long or short",
      "close_date": "YYYY-MM-DD",
      "close_price": number,
      "lots": [
        { "open_date": "YYYY-MM-DD", "open_price": number, "contracts": number }
      ],
      "statement_reported_total": number
    }
  ],
  "open_options": [
    {
      "trade_date": "YYYY-MM-DD",
      "side": "buy or sell",
      "option_type": "put or call",
      "num_contracts": number,
      "commodity": "Corn or Soybeans or Chicago Wheat or Cotton",
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
      "commodity": "Corn or Soybeans or Chicago Wheat or Cotton",
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

const CROP_INSURANCE_POLICY_PROMPT = `This is a crop insurance policy summary, premium billing statement, or coverage confirmation document. Extract all policy information from it.

Crop insurance summaries and schedules of insurance list a SEPARATE line item per PRACTICE: the same crop in a county often appears TWICE — once irrigated, once non-irrigated (dryland) — each with its OWN APH yield, insured acres, coverage level, and premium. Emit ONE policy object per crop × county × practice line you find. If a crop/county shows only one practice, emit just that one.

For each crop × county × practice line found in the document, extract:
- crop (e.g., "Corn", "Soybeans", "Wheat")
- county (the county name)
- state (the state)
- crop_year (the crop year)
- plan_type ("RP" for Revenue Protection, "RP_HPE" for Revenue Protection with Harvest Price Exclusion, "YP" for Yield Protection, "ARP" for Area Revenue Protection, "AYP" for Area Yield Protection — area/county plans may appear by plan code 04/05/06 or names like "Area Risk Protection")
- practice ("irrigated" or "non_irrigated"). Practice indicators: "IRR" / "Irrigated" / "IR" = irrigated; "NIRR" / "Non-Irrigated" / "NFAC" / "Dryland" / "Non-Irr" / "DRY" = non_irrigated. If a line clearly shows a practice, set it; if the document does not distinguish practice for this crop/county, use null.
- coverage_level (as a decimal, e.g., 0.80 for 80%)
- unit_structure ("enterprise", "basic", or "optional")
- aph_yield (the APH or approved yield PER PRACTICE, the value on this line — bushels per acre for grains, POUNDS of lint per acre for cotton, e.g. 1200)
- projected_price (the spring/projected price in DOLLARS per unit — $ per bushel for grains, $ per POUND for cotton. RMA cotton prices are dollars like 0.68; NEVER report a cotton price in cents (68.00) — if the document prints cents per pound, divide by 100)
- insured_acres (insured acres for THIS practice line)
- premium_per_acre (the producer-paid premium per acre for this line, after subsidy)
- total_premium (total producer premium for this crop/county/practice line)
- premium_subsidy_pct (the federal subsidy percentage if shown)
- policy_number (if shown)
- expected_county_yield (the RMA EXPECTED COUNTY yield if shown — ARP/AYP lines always show it; null otherwise)
- expected_county_revenue (the expected county revenue $/acre if shown)
- protection_factor (ARP/AYP/STAX protection factor 0.8-1.2 if shown)

Also check for SCO (Supplemental Coverage Option) endorsements:
- sco_present (true/false)
- sco_coverage_trigger (decimal, typically 0.86)
- sco_expected_county_yield (bushels per acre if shown)
- sco_premium_per_acre (if shown)
- sco_total_premium (if shown)

Also check for ECO (Enhanced Coverage Option) endorsements:
- eco_present (true/false)
- eco_trigger_level (0.90 or 0.95)
- eco_expected_county_yield (if shown)
- eco_premium_per_acre (if shown)
- eco_total_premium (if shown)

Also check for STAX (Stacked Income Protection — upland cotton only; plan name "STAX" or "Stacked Income Protection"):
- stax_present, coverage_range_top (typically 0.90), coverage_pct (0.05-0.20), protection_factor, expected_county_revenue ($/acre), premiums

Also check for MCO (Margin Coverage Option) endorsements (margin protection bands, 86% to 90/95%):
- mco_present, trigger_level (0.90 or 0.95), expected_margin ($/acre), input_cost_adjustment, expected_county_yield, premiums

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "policies": [
    {
      "crop": "string",
      "county": "string",
      "state": "string",
      "crop_year": number,
      "plan_type": "RP or RP_HPE or YP or ARP or AYP",
      "practice": "irrigated or non_irrigated or null",
      "coverage_level": number,
      "unit_structure": "enterprise or basic or optional",
      "aph_yield": number,
      "projected_price": number,
      "insured_acres": number,
      "premium_per_acre": number or null,
      "total_premium": number or null,
      "premium_subsidy_pct": number or null,
      "policy_number": "string or null",
      "expected_county_yield": number or null,
      "expected_county_revenue": number or null,
      "protection_factor": number or null,
      "sco": {
        "present": true/false,
        "coverage_trigger": number or null,
        "expected_county_yield": number or null,
        "premium_per_acre": number or null,
        "total_premium": number or null
      },
      "eco": {
        "present": true/false,
        "trigger_level": number or null,
        "expected_county_yield": number or null,
        "premium_per_acre": number or null,
        "total_premium": number or null
      },
      "stax": {
        "present": true/false,
        "coverage_range_top": number or null,
        "coverage_pct": number or null,
        "protection_factor": number or null,
        "expected_county_revenue": number or null,
        "premium_per_acre": number or null,
        "total_premium": number or null
      },
      "mco": {
        "present": true/false,
        "trigger_level": number or null,
        "expected_margin": number or null,
        "input_cost_adjustment": number or null,
        "expected_county_yield": number or null,
        "premium_per_acre": number or null,
        "total_premium": number or null
      }
    }
  ]
}`

const FSA_BASE_ACRES_PROMPT = `This is an FSA document — either a Form 156EZ (Farm Record), a Base and Yield Notice, or a Base Allocation Summary from the USDA Farm Service Agency. Extract all farm base acre and yield information.

For each farm found in the document, extract:
- fsa_farm_number (the FSA farm serial number)
- county (county name if shown)
- state (state if shown)

For each covered commodity on that farm, extract:
- commodity_name (e.g., "Corn", "Soybeans", "Wheat", "Seed Cotton", "Grain Sorghum". Some farms may have base in less common covered commodities such as Oats, Barley, Peanuts, Crambe, Safflower, or Sesame — include those by name too. For generic base not tied to a commodity, use "Unassigned".)
- base_acres (the number of base acres for this commodity on this farm)
- plc_yield (the PLC payment yield in bushels per acre or pounds per acre)
- arc_plc_election (if shown: "PLC", "ARC-CO", or "ARC-IC" — null if not on this document)
- is_unassigned (true if these acres are labeled "unassigned", "unassigned generic", or "generic base" — i.e. base acres retained on the farm but NOT assigned to a covered commodity for payment. false for normal assigned base.)

If the document is a Base Allocation Summary (the newer OBBBA format), also extract:
- new_base_acres (any additional base acres being allocated)
- total_base_acres (existing + new)

Respond ONLY in JSON with no other text, no markdown backticks:
{
  "farms": [
    {
      "fsa_farm_number": "string",
      "county": "string or null",
      "state": "string or null",
      "commodities": [
        {
          "commodity_name": "string",
          "base_acres": number,
          "plc_yield": number,
          "arc_plc_election": "PLC or ARC-CO or ARC-IC or null",
          "is_unassigned": true or false,
          "new_base_acres": number or null,
          "total_base_acres": number or null
        }
      ]
    }
  ]
}`

type DocumentType = 'settlement' | 'tickets' | 'brokerage_statement' | 'contract' | 'fields' | 'plantings' | 'crop_insurance_policy' | 'fsa_base_acres' | 'cotton_weight_ticket' | 'gin_receipt' | 'cotton_marketing_document'


const COTTON_TICKET_PROMPT = `This document contains cotton MODULE/LOAD weight tickets (a gin's "Module List" or seed cotton weight tickets). Multi-page PDFs contain ONE LOAD PER PAGE - extract every load from every page.

For each load extract:
- load_number (the gin's module/load number, exactly as printed)
- producer (the producer/farmer name)
- farm_number (the FSA farm number if printed - null if not)
- field (the field name/description exactly as printed, e.g. "JOE MCCOULOUGH IRR")
- picked_date, delivered_date (YYYY-MM-DD; null when absent)
- truck (truck/trailer identifier text)
- gross_weight, tare_weight, net_weight (POUNDS of seed cotton, plain numbers, no commas)
- crop_year (the crop year if printed, else null)

Respond ONLY in JSON, no other text, no markdown fences:
{"loads": [{"load_number": "...", "producer": "...", "farm_number": "... or null", "field": "... or null", "picked_date": "YYYY-MM-DD or null", "delivered_date": "YYYY-MM-DD or null", "truck": "... or null", "gross_weight": number or null, "tare_weight": number or null, "net_weight": number or null, "crop_year": number or null}]}`

const GIN_RECEIPT_PROMPT = `This is a STATEMENT OF GINNING from a cotton gin (a gin receipt). Extract the full statement:

- gin_name (the gin's name), gin_address, gin_phone (null when absent)
- receipt_number (the statement/gin number, e.g. "040614" from "Gin 040614")
- receipt_date (YYYY-MM-DD)
- producer (producer/farmer name)
- farm_number (FSA farm number if printed), farm_name
- field (field name/description)
- crop_year (number, else null)
- Statement totals: modules_count, total_seed_cotton_weight (lbs), bales_count, total_bale_weight (lbs lint), avg_bale_weight, seed_lbs (cottonseed produced), lint_turnout_pct, lint_lbs_per_bale
- loads: the statement's load table - one entry per line: {"load_number": "...", "rolls": number or null, "gross": number or null, "tare": number or null, "net": number or null}
- bales: the FULL bale list - it may span multiple pages; extract EVERY bale row: {"pbi_number": "...", "net_weight_lbs": number}. Do not truncate or summarize the list.

Respond ONLY in JSON, no other text, no markdown fences:
{"gin_name": "...", "gin_address": null, "gin_phone": null, "receipt_number": "...", "receipt_date": "YYYY-MM-DD or null", "producer": "...", "farm_number": "... or null", "farm_name": "... or null", "field": "... or null", "crop_year": number or null, "modules_count": number or null, "total_seed_cotton_weight": number or null, "bales_count": number or null, "total_bale_weight": number or null, "avg_bale_weight": number or null, "seed_lbs": number or null, "lint_turnout_pct": number or null, "lint_lbs_per_bale": number or null, "loads": [...], "bales": [...]}`

// ---------------------------------------------------------------------------
// Cotton marketing documents — ONE upload point classifies the document AND
// extracts the category-specific fields in the same call. On low confidence
// the UI asks the user to pick the category and re-parses with that category's
// focused prompt (COTTON_MARKETING_CATEGORY_PROMPTS below, selected via the
// request's `category` field). All prices are ¢/lb here (marketing convention);
// dollars are plain dollar amounts.
// ---------------------------------------------------------------------------

// Per-category extraction field definitions, shared verbatim between the
// classify-and-extract prompt and each focused re-extract prompt so the two
// paths always emit the same shape.
const COTTON_MARKETING_FIELDS: Record<string, string> = {
  sales_contract: `"extracted" fields for sales_contract (a cotton sales/purchase contract or pool agreement between the producer and a merchant/coop):
- contract_type: "spot" (immediate sale), "fixed_price" (forward at a fixed ¢/lb), "on_call" (basis contract against a futures month, price fixed later), or "pool" (seasonal pool / marketing pool agreement)
- buyer (the merchant/buyer/coop name), contract_number, contract_date (YYYY-MM-DD), crop_year
- committed_bales (number) or committed_acres (number) — whichever the contract commits
- price_cents_per_lb (spot/fixed price in ¢/lb, e.g. 74.25 — convert $/lb to ¢/lb by multiplying by 100)
- basis_cents (on-call basis in ¢/lb, may be negative, e.g. -2.50), futures_month (e.g. "DEC 26")
- delivery_start, delivery_end (YYYY-MM-DD), notes`,
  pool_payment: `"extracted" fields for pool_payment (a pool advance / progress payment / final settlement notice from a marketing pool):
- buyer (the pool/coop name), contract_number (the pool contract/account number if shown)
- payment_type: "initial_advance", "progress", or "final_settlement"
- amount (total dollars of this payment), cents_per_lb_equivalent (¢/lb if stated), payment_date (YYYY-MM-DD), crop_year`,
  ccc_loan: `"extracted" fields for ccc_loan (a CCC/marketing assistance loan schedule or receipt from FSA or the loan servicing agent):
- loan_number (exactly as printed), entry_date (YYYY-MM-DD), maturity_date (YYYY-MM-DD, if shown)
- loan_rate_base_cents (the base loan rate in ¢/lb, e.g. 55.00), principal_total (total loan amount in dollars)
- crop_year
- bale_pbis: EVERY bale/PBI number in the document's bale list, as strings, exactly as printed. The list may span many pages — do not truncate or summarize; extract every row.`,
  ldp_notice: `"extracted" fields for ldp_notice (a Loan Deficiency Payment application/notice from FSA):
- ldp_date (YYYY-MM-DD), awp_cents (the Adjusted World Price in ¢/lb), ldp_rate_cents (the LDP rate in ¢/lb), total_payment (dollars), crop_year
- bale_pbis: EVERY bale/PBI number listed, as strings, exactly as printed — the full list, never truncated.`,
  equity_sale: `"extracted" fields for equity_sale (a confirmation of selling the equity in loan cotton to a merchant):
- loan_number (the CCC loan the equity was sold on), buyer (the merchant buying the equity)
- equity_cents_per_lb (the equity in ¢/lb over the loan), equity_total (dollars, if shown), sale_date (YYYY-MM-DD), crop_year`,
  storage_invoice: `"extracted" fields for storage_invoice (a warehouse/storage/receiving/fee invoice for stored cotton):
- invoice_number, fee_type: one of "warehouse_receiving", "storage_monthly", "classing", "checkoff", "loan_interest", "loan_servicing", "pool_deduction", "merchant_fee", "other" (best fit for the main charge)
- amount_total (total dollars invoiced), fee_date (invoice date, YYYY-MM-DD), bales_count (bales billed, if shown)
- loan_number (if the invoice references a CCC loan), notes (a one-line description of the charge), crop_year`,
  bale_list: `"extracted" fields for bale_list (a gin or merchant recap sheet whose substance is a long column of bale/PBI numbers):
- bale_pbis: EVERY bale/PBI number, as strings, exactly as printed. The list may span many pages — extract every row, never truncate.`,
}

const COTTON_MARKETING_JSON_SHAPE = `Respond ONLY in JSON, no other text, no markdown fences:
{"document_category": "sales_contract" | "pool_payment" | "ccc_loan" | "ldp_notice" | "equity_sale" | "storage_invoice" | "bale_list", "confidence": "high" | "medium" | "low", "extracted": { ...the category's fields, null for anything not shown... }}`

const COTTON_MARKETING_PROMPT = `This is a document from a cotton producer's MARKETING file. First classify it as exactly one of these categories, then extract that category's fields:

1. sales_contract — a sales/purchase contract with a merchant or a pool agreement (spot, fixed price, on-call/basis, or pool)
2. pool_payment — a pool advance, progress payment, or final settlement notice
3. ccc_loan — a CCC/marketing assistance loan schedule or receipt (FSA or loan servicing agent; carries a loan number, a bale list, and principal)
4. ldp_notice — a Loan Deficiency Payment application/notice (AWP, LDP rate, bales)
5. equity_sale — a confirmation of selling loan-cotton equity to a merchant
6. storage_invoice — a warehouse/storage/receiving or other fee invoice
7. bale_list — a recap sheet that is essentially just a long list of bale/PBI numbers

Set "confidence" to "high" only when the document unambiguously fits one category; "medium" when it mostly fits; "low" when you are guessing — the user will be asked to pick the category on low confidence.

${Object.values(COTTON_MARKETING_FIELDS).join('\n\n')}

All ¢/lb prices are plain numbers like 74.25 (convert $/lb by ×100). All dates are YYYY-MM-DD. Use null for anything the document does not show.

${COTTON_MARKETING_JSON_SHAPE}`

// Focused re-extract prompts, one per category (used when the user picks the
// category after a low-confidence classification).
const COTTON_MARKETING_CATEGORY_PROMPTS: Record<string, string> = Object.fromEntries(
  Object.entries(COTTON_MARKETING_FIELDS).map(([category, fields]) => [
    category,
    `This is a cotton marketing document the user has identified as: ${category}. Extract that category's fields.

${fields}

All ¢/lb prices are plain numbers like 74.25 (convert $/lb by ×100). All dates are YYYY-MM-DD. Use null for anything the document does not show.

Respond ONLY in JSON, no other text, no markdown fences:
{"document_category": "${category}", "confidence": "high" | "medium" | "low", "extracted": { ...the fields above, null when absent... }}`,
  ]),
)

const PROMPTS: Record<DocumentType, string> = {
  settlement: SETTLEMENT_PROMPT,
  tickets: TICKETS_PROMPT,
  brokerage_statement: BROKERAGE_PROMPT,
  contract: CONTRACT_PROMPT,
  fields: FIELDS_PROMPT,
  plantings: PLANTINGS_PROMPT,
  crop_insurance_policy: CROP_INSURANCE_POLICY_PROMPT,
  fsa_base_acres: FSA_BASE_ACRES_PROMPT,
  cotton_weight_ticket: COTTON_TICKET_PROMPT,
  gin_receipt: GIN_RECEIPT_PROMPT,
  cotton_marketing_document: COTTON_MARKETING_PROMPT,
}

type ParseBody = {
  pdf_base64?: unknown
  pdf_url?: unknown
  images?: unknown
  document_type?: unknown
  // cotton_marketing_document only: a user-picked category selects the focused
  // re-extract prompt instead of classify-and-extract.
  category?: unknown
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

  // Build the document content block(s): a PDF by URL (the default path — keeps
  // the request body tiny so it clears Vercel's 4.5 MB serverless limit; the
  // PDF can be up to our 20 MB cap), a base64 PDF (legacy/fallback), or one or
  // more compressed photos. The text prompt is identical either way.
  const pdfUrl = typeof body.pdf_url === 'string' ? body.pdf_url : ''
  const pdfBase64 = typeof body.pdf_base64 === 'string' ? body.pdf_base64 : ''
  let docBlocks: Anthropic.ContentBlockParam[]
  if (body.images !== undefined) {
    const v = validateImages(body.images)
    if ('error' in v) return badRequest(v.error)
    docBlocks = v.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type as 'image/jpeg', data: img.data },
    }))
  } else if (pdfUrl) {
    if (!/^https:\/\//i.test(pdfUrl)) return badRequest('pdf_url must be an https URL.')
    docBlocks = [
      { type: 'document', source: { type: 'url', url: pdfUrl } },
    ]
  } else if (pdfBase64) {
    if (pdfBase64.length > MAX_BASE64_LEN) return badRequest('PDF exceeds the 20 MB size limit.')
    docBlocks = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
    ]
  } else {
    return badRequest('pdf_url, pdf_base64, or images is required.')
  }

  let prompt = PROMPTS[docType]
  if (docType === 'cotton_marketing_document' && typeof body.category === 'string') {
    const focused = COTTON_MARKETING_CATEGORY_PROMPTS[body.category]
    if (!focused) {
      return badRequest('category must be one of: ' + Object.keys(COTTON_MARKETING_CATEGORY_PROMPTS).join(', ') + '.')
    }
    prompt = focused
  }

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
