# Retailer Adapter Slot

Each adapter should return normalized offer rows:

```js
{
  productId: "dyson-v15-detect",
  retailer: "JB Hi-Fi",
  price: 1299,
  wasPrice: 1499,
  stock: "In stock",
  note: "Optional short display note",
  productUrl: "https://..."
}
```

The current MVP uses `feeds/manual-prices.csv`. These files are ready for official product feeds, affiliate exports, or approved APIs.

## Local Feed Adapter Example

`jbhifi-feed.mjs` can read an approved local CSV when `JBHIFI_ADAPTER_CSV` points to a file with:

```csv
productId,price,wasPrice,stock,note,productUrl
```

`productId` is preferred, but adapters may also return `sku`, `url`/`productUrl`, or a trusted title alias. The refresh pipeline checks `data/product-matches.json` before fuzzy matching.

Example:

```powershell
$env:JBHIFI_ADAPTER_CSV='C:\Users\irisl\Documents\New project\appliances\feeds\adapter-jbhifi-sample.csv'
& 'C:\Users\irisl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' appliances\server.mjs
```

Then click "刷新 Adapter" or call `POST /api/refresh-adapters`.

## Amazon AU PA-API Slot

`amazon-paapi.mjs` reads ASIN mappings from:

```text
data/amazon-asin-map.json
```

For local testing before live PA-API credentials are available, set:

```powershell
$env:AMAZON_PAAPI_FIXTURE='appliances/feeds/amazon-paapi-fixture.json'
```

For live PA-API work, configure:

```powershell
$env:AMAZON_PAAPI_ACCESS_KEY='...'
$env:AMAZON_PAAPI_SECRET_KEY='...'
$env:AMAZON_PAAPI_PARTNER_TAG='...'
```

The adapter currently reports credential and ASIN-map diagnostics. Replace fixture mode with signed `GetItems` calls when credentials are ready.
