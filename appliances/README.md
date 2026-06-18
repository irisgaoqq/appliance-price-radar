# Appliance Price Radar

Local same-model price comparison for Australian appliances across:

- JB Hi-Fi
- Harvey Norman
- The Good Guys
- Amazon AU

Open `index.html` directly, serve the workspace and visit `/appliances/index.html`, or run the local API server:

```powershell
& 'C:\Users\irisl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' appliances\server.mjs
```

Then open:

```text
http://localhost:8091/appliances/index.html
```

## Data Flow

The page first tries to load `data/products.json`. If that is blocked because the file is opened directly from disk, it falls back to `data/products.js`.

Edit products and offers in `data/products.json`, then regenerate the fallback:

```powershell
& 'C:\Users\irisl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' appliances\scripts\update-prices.mjs
```

The script reads `feeds/manual-prices.csv`, updates matching offers, then writes both:

- `data/products.json`
- `data/products.js`
- `data/price-history.json`

The CSV must keep these headers:

```csv
productId,retailer,price,wasPrice,stock,note,productUrl
```

`productId` and `retailer` must match an existing product offer. `price` must be a positive number. Empty `productUrl` values are allowed, but the page will then open a retailer search page instead of a direct product page.

Optional total-cost fields can be included in manual, merchant, or adapter feeds:

```csv
shipping,fees,coupon,cashback
```

The site compares landed cost as `price + shipping + fees - coupon - cashback`. If those fields are missing, landed cost equals the visible product price.

Estimated delivery rules live in:

- `data/delivery-rules.json`

The page uses the postcode field and these rules to estimate shipping when a feed does not provide an explicit `shipping` value. Feed-provided shipping always wins over the estimate.

Merchant or affiliate feed imports can use this looser shape:

```csv
retailer,title,price,url,stock,wasPrice,sku
```

See `feeds/merchant-feed-sample.csv`. The importer auto-matches rows to tracked products using brand/model/spec words. High-confidence rows update prices; uncertain rows are saved as pending captures for manual binding.

For repeated shopping-time updates, place multiple retailer or affiliate CSV files in:

```text
appliances/feeds/retailer-feeds/
```

Then use the page's "导入文件夹" button or call `POST /api/import-feeds`. Every `.csv` in that folder is imported in filename order.

Target buy prices live in:

- `data/watchlist.json`
- `data/watchlist.js`

Price alert history lives in:

- `data/price-alerts.json`

## Local API

The local server exposes:

- `GET /api/products` - returns the current product feed.
- `POST /api/products` - creates a tracked product with four retailer offer placeholders.
- `POST /api/refresh` - runs `scripts/update-prices.mjs`, then returns the updated feed.
- `GET /api/history` - returns saved price snapshots.
- `GET /api/sources` - returns current data-source readiness by retailer.
- `GET /api/settings` - returns refresh settings and server scheduler state.
- `GET /api/validate` - validates `feeds/manual-prices.csv` without writing product data.
- `GET /api/captures` - returns recent browser-bookmarklet captures, including records that need manual matching.
- `POST /api/capture` - accepts a browser-bookmarklet price capture from a retailer product page and applies it to the matched tracked product.
- `POST /api/captures/apply` - manually binds a pending capture to a tracked product when automatic matching is unsure.
- `POST /api/watchlist` - creates or updates the target buy price used for buy/wait recommendations.
- `POST /api/import-feed` - imports `feeds/merchant-feed-sample.csv` or a supplied local CSV path with retailer/title/price/url rows.
- `POST /api/import-feeds` - imports every `.csv` in `feeds/retailer-feeds` or a supplied local folder path.
- `POST /api/refresh-adapters` - runs the retailer adapter slots in `adapters/` and applies normalized offer rows.

The frontend tries `/api/products` first. If it is unavailable, it falls back to `data/products.json`, then to `data/products.js`.

When the API has at least two snapshots, the page compares current prices with the previous snapshot and shows whether each retailer price is unchanged, up, or down.

The page also reads `/api/history` and shows a compact recent-history panel on each product card with recent low, recent high, latest movement, and retailer-level trend notes.

Offer cards show price freshness badges. Prices with `capturedAt` newer than `priceFreshnessWarningMinutes` in `data/settings.json` are marked fresh; older or untimestamped prices are marked for re-check before buying.

Each product card also has a live-check summary. It counts fresh, re-check, and missing retailer prices, explains whether the current best price is safe enough to consider, and opens only the retailer pages that still need a final check.

The API also returns `validation` and source-health fields so the UI can show CSV coverage, missing rows, empty product URLs, and feed errors before you rely on the numbers while shopping.

When `watchlist` target prices are available, the page compares the current best offer with the target and shows a buy/wait signal on each product card.

Each product card also has a target-price input, so you can adjust the buy threshold from the shopping page without editing JSON.

Recommendations, savings, watchlist decisions, and shopping checklists use landed cost when delivery, fee, coupon, or cashback data is available.

The product card also ranks retailer offers with a practical recommendation score. The score starts from landed-cost position, then adjusts for price freshness, stock uncertainty, and same-model confidence. This creates a clearer `首选 / 备选 / 需复核` signal before you open the final checkout page.

The comparison page also includes a watchlist opportunity summary. It groups tracked models into buy, wait, missing-price, and no-target states, then highlights the best current opportunities above the product grid. Clicking a summary card filters the page to that exact model for final retailer-page checks.

When refreshes, imports, captures, or adapter updates produce a best price at or below a watchlist target, the API records a `target-met` price alert. It also records `new-low` alerts when the best visible price drops below the previous snapshot. The page shows recent alerts above the product grid.

Product records can include same-model verification fields:

- `brand`
- `modelCode`
- `specs`
- `matchChecklist`

These fields help avoid comparing similar-looking but different appliances, such as different capacities, colours, included accessories, or warranty variants.

Exact retailer mappings live in `data/product-matches.json`. Use this file to map retailer SKU, URL fragments, or trusted aliases to a local `productId` before fuzzy matching runs. This is the safest path for live feeds because it prevents similar-looking appliance variants from being merged just because their titles share brand words.

Amazon AU ASIN mappings live in `data/amazon-asin-map.json`. The Amazon adapter can run in local fixture mode with `AMAZON_PAAPI_FIXTURE=appliances/feeds/amazon-paapi-fixture.json`, then later move to signed PA-API calls once `AMAZON_PAAPI_ACCESS_KEY`, `AMAZON_PAAPI_SECRET_KEY`, and `AMAZON_PAAPI_PARTNER_TAG` are configured.

## Retailer Source Adapters

Retailer source status lives in `data/sources.json`.

Adapter slots live in `adapters/`:

- `jbhifi-feed.mjs`
- `harvey-norman-feed.mjs`
- `the-good-guys-feed.mjs`
- `amazon-paapi.mjs`

The current MVP is intentionally manual/feed-ready. Replace these adapter stubs with approved product feeds, affiliate exports, or official APIs rather than relying on browser-only scraping.

The page's "刷新 Adapter" button runs the same adapter pipeline as `POST /api/refresh-adapters`. `adapters/jbhifi-feed.mjs` includes a local CSV example: set `JBHIFI_ADAPTER_CSV` to `appliances/feeds/adapter-jbhifi-sample.csv` before starting the server to simulate an approved JB Hi-Fi feed.

## Auto Refresh

Refresh settings live in `data/settings.json`.

- `autoRefreshSeconds` controls the frontend countdown interval.
- `serverAutoRefresh` can enable server-side scheduled refresh.
- `priceFreshnessWarningMinutes` is reserved for freshness warnings.

To force server-side scheduled refresh without editing JSON:

```powershell
$env:SERVER_AUTO_REFRESH='true'
& 'C:\Users\irisl\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' appliances\server.mjs
```

## Shopping-Time Shortcuts

The page supports deep links:

```text
http://localhost:8094/appliances/index.html?q=Dyson%20V15#compare
```

Supported query parameters:

- `q` - search term, model name, or category text.
- `category` - one of `Vacuum`, `Coffee`, `Kitchen`, `TV`, or `all`.

Use the "复制搜索链接" button to copy the current filtered view. The "比价书签" link is a bookmarklet: drag it to the browser bookmarks bar, then click it on a retailer page after selecting a model name.

Use the "新增追踪型号" form when you want to track a product that is not already in the local list. The app creates placeholder offers for JB Hi-Fi, Harvey Norman, The Good Guys, and Amazon AU. Those offers show as `待采集` until you update them through CSV, an adapter, or the capture bookmarklet.

Use the "导入商家 Feed" form to import a retailer or affiliate CSV from the workspace. The default path points to `appliances/feeds/merchant-feed-sample.csv`; replace it with another local CSV when you have a real export.

Use the "导入文件夹" button when you have several retailer exports ready at once, for example one CSV each from JB Hi-Fi, Harvey Norman, The Good Guys, and Amazon AU. Drop them in `appliances/feeds/retailer-feeds/` with the same `retailer,title,price,url,stock,wasPrice,sku` columns.

Each product card also has shopping actions: "打开四家" opens the four retailer pages/searches for the current model, and "复制核对清单" copies the current prices, links, target price, and same-model checklist.

The "采集价格" bookmarklet is for shopping-time updates:

1. Keep the local server running.
2. Drag "采集价格" to the browser bookmarks bar.
3. Open a product page on JB Hi-Fi, Harvey Norman, The Good Guys, or Amazon AU.
4. Click the bookmarklet. It tries to read the page title and displayed price, then posts the capture to `/api/capture`.
5. Return to Appliance Price Radar and refresh. The matching offer will show `Browser capture` metadata.

This is a user-triggered capture helper, not unattended scraping. If the page price cannot be detected, the bookmarklet prompts you to type the visible price.

If a captured page cannot be matched to an existing product, the capture is saved as `needs-product-match`. The comparison page then shows a pending-capture panel where you can choose the correct tracked product and bind that price manually.

To test merchant feed import:

```powershell
Invoke-WebRequest -Uri 'http://localhost:8091/api/import-feed' -Method POST -ContentType 'application/json' -Body '{}'
```

You can also pass a workspace CSV path:

```json
{"csvPath":"appliances/feeds/my-affiliate-feed.csv"}
```

To test batch feed import:

```powershell
Invoke-WebRequest -Uri 'http://localhost:8091/api/import-feeds' -Method POST -ContentType 'application/json' -Body '{}'
```

You can also pass a workspace folder path:

```json
{"directoryPath":"appliances/feeds/retailer-feeds"}
```

## Live Price Path

For real or near-real-time prices, connect a compliant source into the same JSON shape:

- Amazon Product Advertising API for Amazon AU
- Approved affiliate/product feeds where available
- Retailer-approved data exports
- A backend scheduled updater that respects each retailer's terms

Avoid relying on browser-only scraping. Retail pages can block direct requests, change markup, render prices dynamically, or restrict automated collection.
