---
name: ghl-products
description: >-
  Create, list, and manage products and prices in GoHighLevel. Use when Derek
  asks about products, pricing, product catalog, creating offers, setting up
  packages, or managing GHL store items. Also triggered by /products.
allowed-tools:
  - Bash
  - Read
context: fork
user-invocable: true
argument-hint: "[list | create <name> <price> | show <name>]"
---
# GHL Products & Prices

Manage products and pricing in GoHighLevel via Products API (v2). Read `.env` for `GHL_API_TOKEN` and `GHL_LOCATION_ID`. See `references/api-reference.md` for full API docs.

## Handling $ARGUMENTS

- `list` or no args: List all products with prices
- `create <name>, <price>`: Create product + price (parse price from natural language)
- `show <name>`: Search and display product details
- `delete <name>`: Confirm with Derek, then delete

## Price Parsing
- "$497" or "one-time" -> type: one_time, amount: 49700
- "$297/month" or "monthly" -> type: recurring, interval: month, amount: 29700
- "$997/year" or "annually" -> type: recurring, interval: year, amount: 99700
- "$49/week" -> type: recurring, interval: week, amount: 4900

**Amount is always in CENTS.** Multiply dollars by 100.

## Product Type Inference
- Courses, programs, memberships, consultations, coaching -> DIGITAL
- Supplements, kits, equipment, physical goods -> PHYSICAL
- Default: DIGITAL (most PV products are services)

## Workflow: Create Product with Price
1. Confirm details with Derek
2. POST /products/ (create product)
3. Capture returned `_id`
4. POST /products/{_id}/price (add pricing)
5. Report: product ID, price ID, confirmation

## Workflow: List Catalog
1. GET /products/?locationId=...&limit=100
2. For each product, GET /products/{id}/price
3. Format cleanly with product names and price tiers

## Known Limitation
PIT token may lack Products scope. If 401/403 with scope error, tell Derek to enable Products scope in GHL > Settings > Integrations > Private Integrations.

## Troubleshooting

### Error: 401 Unauthorized
PIT token expired or lacks Products scope. Derek needs to regenerate in GHL > Settings > Integrations > Private Integrations. Ensure Products read/write scope is enabled.

### Error: 403 Forbidden
Location ID mismatch or token doesn't have access to this location. Verify `GHL_LOCATION_ID` in .env matches the active location.

### Error: 422 Unprocessable Entity
Missing required fields. Common causes:
- Product creation: `name` is required
- Price creation: `amount` (in cents), `currency` ("USD"), and `type` ("one_time" or "recurring") are required
- Recurring price: must include `interval` ("month", "year", "week")

### Error: Product created but no price attached
The two-step workflow (create product, then add price) can fail on step 2. If this happens:
1. Note the product ID from step 1
2. Retry the price creation with POST /products/{id}/price
3. Don't create a duplicate product

### Error: Amount displays wrong
Remember amounts are in CENTS. $497 = 49700. If a price shows as $4.97, the amount was passed in dollars instead of cents.

See `references/api-reference.md` for full API error codes and retry patterns.

## Test Script
```bash
bun run .claude/skills/ghl-products/test-api.mjs
```
Read-only, safe to run anytime to verify API connection.
