# GHL Products API Reference

## Connection Details
- **Base URL**: `https://services.leadconnectorhq.com`
- **Auth**: Bearer token from `.env` `GHL_API_TOKEN` (PIT token)
- **Location ID**: From `.env` `GHL_LOCATION_ID`
- **Headers**: `Authorization: Bearer <TOKEN>`, `Content-Type: application/json`, `Version: 2021-07-28`, `Accept: application/json`

## Products API

### List: GET /products/?locationId=<LOC>&limit=50&offset=0
### Get: GET /products/<id>?locationId=<LOC>
### Create: POST /products/ (body: name, locationId, productType required)
### Update: PUT /products/<id> (body: include locationId)
### Delete: DELETE /products/<id>?locationId=<LOC> (CONFIRM WITH DEREK FIRST)

Product fields: name (required), locationId (required), productType (DIGITAL/PHYSICAL, required), description, image, availableInStore, statementDescriptor (max 22 chars), medias, variants

## Prices API

### List: GET /products/<id>/price?locationId=<LOC>
### Create: POST /products/<id>/price (body: product, name, type, amount, currency, locationId required)
### Get: GET /products/<id>/price/<priceId>?locationId=<LOC>
### Update: PUT /products/<id>/price/<priceId>
### Delete: DELETE /products/<id>/price/<priceId>?locationId=<LOC> (CONFIRM FIRST)

Price fields: product (required, must match URL), name (required), type (one_time/recurring, required), amount (CENTS, required), currency (USD, required), locationId (required), recurring (if type=recurring: interval + intervalCount), trialPeriod, totalCycles, setupFee, sku

**AMOUNT IS IN CENTS.** $299 = 29900. $49.99 = 4999.

## Curl Template
```bash
curl -s --connect-timeout 10 -H "Authorization: Bearer <TOKEN>" -H "Version: 2021-07-28" -H "Accept: application/json" "<URL>"
```

## Error Codes
- 401/403: PIT token lacks Products scope. Derek must enable in GHL > Settings > Integrations > Private Integrations.
- 404: Product/price ID doesn't exist.
- 422: Validation error. Check required fields.
- 429: Rate limited. Wait 5s and retry once.
