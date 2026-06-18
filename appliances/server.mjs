import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addTrackedProduct, applyCapturedPrice, capturePrice, importMerchantFeed, importMerchantFeeds, refreshFromAdapters, updatePrices, validateManualFeed } from "./scripts/update-prices.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(root, "..");
const port = Number(process.env.PORT || 8091);
let scheduler = null;
let schedulerState = {
  enabled: false,
  intervalSeconds: 0,
  lastRunAt: null,
  lastError: null
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendOptions(response) {
  response.writeHead(204, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400"
  });
  response.end();
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safePath(urlPath) {
  const requested = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  const resolved = resolve(projectRoot, requested === "/" ? "appliances/index.html" : requested.slice(1));
  if (!resolved.startsWith(projectRoot)) return null;
  return resolved;
}

async function readProducts() {
  const raw = await readFile(join(root, "data/products.json"), "utf8");
  return JSON.parse(raw);
}

async function readHistory() {
  try {
    const raw = await readFile(join(root, "data/price-history.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readWatchlist() {
  try {
    const raw = await readFile(join(root, "data/watchlist.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeWatchlist(watchlist) {
  await writeFile(join(root, "data/watchlist.json"), `${JSON.stringify(watchlist, null, 2)}\n`, "utf8");
  await writeFile(join(root, "data/watchlist.js"), `window.APPLIANCE_WATCHLIST = ${JSON.stringify(watchlist, null, 2)};\n`, "utf8");
}

async function updateWatchTarget(productId, targetPrice, note = "") {
  const products = await readProducts();
  if (!products.some(product => product.id === productId)) throw new Error(`Unknown product id: ${productId}`);

  const parsedTarget = Number(targetPrice);
  if (!Number.isFinite(parsedTarget) || parsedTarget <= 0) throw new Error("Target price must be a positive number");

  const watchlist = await readWatchlist();
  const existing = watchlist.find(item => item.productId === productId);
  if (existing) {
    existing.targetPrice = parsedTarget;
    existing.note = note || existing.note || "User target price";
  } else {
    watchlist.push({
      productId,
      targetPrice: parsedTarget,
      note: note || "User target price"
    });
  }

  await writeWatchlist(watchlist);
  return watchlist;
}

async function readSources() {
  try {
    const raw = await readFile(join(root, "data/sources.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readCaptures() {
  try {
    const raw = await readFile(join(root, "data/captured-prices.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readAlerts() {
  try {
    const raw = await readFile(join(root, "data/price-alerts.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeAlerts(alerts) {
  await writeFile(join(root, "data/price-alerts.json"), `${JSON.stringify(alerts.slice(-200), null, 2)}\n`, "utf8");
}

async function readSettings() {
  try {
    const raw = await readFile(join(root, "data/settings.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      autoRefreshSeconds: 900,
      serverAutoRefresh: false,
      priceFreshnessWarningMinutes: 60
    };
  }
}

function historySummary(history) {
  return {
    snapshotCount: history.length,
    latest: history.at(-1) || null,
    previous: history.at(-2) || null
  };
}

function bestOffer(product) {
  const priced = (product.offers || []).filter(offer => typeof offer.price === "number" && Number.isFinite(offer.price));
  if (!priced.length) return null;
  return priced.reduce((best, offer) => offer.price < best.price ? offer : best, priced[0]);
}

function previousBestPrice(previousSnapshot, productId) {
  const product = previousSnapshot?.products?.find(item => item.id === productId);
  if (!product) return null;
  const offers = (product.offers || []).filter(offer => typeof offer.price === "number" && Number.isFinite(offer.price));
  if (!offers.length) return null;
  return Math.min(...offers.map(offer => offer.price));
}

function alertKey(alert) {
  return [alert.type, alert.productId, alert.retailer, alert.price].join("|");
}

async function generatePriceAlerts(products, history, watchlist, source = "refresh") {
  const previous = history.at(-2) || null;
  const existingAlerts = await readAlerts();
  const existingKeys = new Set(existingAlerts.map(alertKey));
  const watchByProduct = new Map(watchlist.map(item => [item.productId, item]));
  const createdAt = new Date().toISOString();
  const created = [];

  products.forEach(product => {
    const best = bestOffer(product);
    if (!best) return;
    const watch = watchByProduct.get(product.id);
    const previousBest = previousBestPrice(previous, product.id);

    if (watch && typeof watch.targetPrice === "number" && best.price <= watch.targetPrice) {
      created.push({
        id: `${Date.now()}-${created.length}`,
        type: "target-met",
        createdAt,
        source,
        productId: product.id,
        model: product.model,
        retailer: best.retailer,
        price: best.price,
        targetPrice: watch.targetPrice,
        message: `${product.model} is at or below target: ${best.retailer} ${best.price}`
      });
    }

    if (typeof previousBest === "number" && best.price < previousBest) {
      created.push({
        id: `${Date.now()}-${created.length}`,
        type: "new-low",
        createdAt,
        source,
        productId: product.id,
        model: product.model,
        retailer: best.retailer,
        price: best.price,
        previousBest,
        message: `${product.model} has a new recent low: ${best.retailer} ${best.price}`
      });
    }
  });

  const uniqueCreated = created.filter(alert => !existingKeys.has(alertKey(alert)));
  if (uniqueCreated.length) {
    await writeAlerts([...existingAlerts, ...uniqueCreated]);
  }

  return {
    created: uniqueCreated,
    recent: uniqueCreated.length ? [...existingAlerts, ...uniqueCreated].slice(-20).reverse() : existingAlerts.slice(-20).reverse()
  };
}

function sourceHealth(sources, products, validation) {
  const offerCounts = new Map();
  products.forEach(product => {
    product.offers.forEach(offer => {
      offerCounts.set(offer.retailer, (offerCounts.get(offer.retailer) || 0) + 1);
    });
  });

  return sources.map(source => {
    const offerCount = offerCounts.get(source.retailer) || 0;
    const manualCoverage = validation?.expectedRowCount
      ? Math.round((validation.coveredRowCount / validation.expectedRowCount) * 100)
      : null;

    return {
      ...source,
      offerCount,
      health: validation?.ok === false ? "error" : source.status,
      coverage: source.method === "Manual CSV" ? manualCoverage : null,
      warnings: source.method === "Manual CSV" ? validation?.warnings || [] : []
    };
  });
}

async function readValidation() {
  try {
    return await validateManualFeed();
  } catch (error) {
    return {
      ok: false,
      errors: [error.message],
      warnings: [],
      rowCount: 0,
      expectedRowCount: 0,
      coveredRowCount: 0
    };
  }
}

async function buildProductPayload(source, extras = {}, alertSource = source) {
  const history = await readHistory();
  const products = await readProducts();
  const sources = await readSources();
  const validation = extras.validation || await readValidation();
  const watchlist = await readWatchlist();
  const alertResult = extras.skipAlerts
    ? { created: [], recent: (await readAlerts()).slice(-20).reverse() }
    : await generatePriceAlerts(products, history, watchlist, alertSource);

  return {
    source,
    refreshedAt: new Date().toISOString(),
    ...extras,
    alerts: alertResult.recent,
    newAlerts: alertResult.created,
    captures: await readCaptures(),
    history: historySummary(history),
    watchlist,
    sources: sourceHealth(sources, products, validation),
    validation,
    settings: await readSettings(),
    scheduler: schedulerState,
    products
  };
}

async function handleApi(request, response, pathname) {
  if (request.method === "OPTIONS") {
    sendOptions(response);
    return true;
  }

  if (pathname === "/api/products") {
    if (request.method === "POST") {
      const body = await readRequestJson(request);
      const result = await addTrackedProduct(body);
      if (typeof result.targetPrice === "number" && result.targetPrice > 0) {
        const watchlist = await readWatchlist();
        watchlist.push({
          productId: result.product.id,
          targetPrice: result.targetPrice,
          note: "User-created target price"
        });
        await writeWatchlist(watchlist);
      }

      sendJson(response, 201, await buildProductPayload("user-created-product", { created: result.product, skipAlerts: true }));
      return true;
    }

    sendJson(response, 200, await buildProductPayload("data/products.json", { skipAlerts: true }));
    return true;
  }

  if (pathname === "/api/history") {
    const history = await readHistory();
    sendJson(response, 200, {
      source: "data/price-history.json",
      refreshedAt: new Date().toISOString(),
      history
    });
    return true;
  }

  if (pathname === "/api/sources") {
    const products = await readProducts();
    const sources = await readSources();
    const validation = await readValidation();
    sendJson(response, 200, {
      source: "data/sources.json",
      refreshedAt: new Date().toISOString(),
      sources: sourceHealth(sources, products, validation),
      validation
    });
    return true;
  }

  if (pathname === "/api/validate") {
    sendJson(response, 200, {
      source: "feeds/manual-prices.csv",
      refreshedAt: new Date().toISOString(),
      validation: await readValidation()
    });
    return true;
  }

  if (pathname === "/api/captures") {
    sendJson(response, 200, {
      source: "data/captured-prices.json",
      refreshedAt: new Date().toISOString(),
      captures: await readCaptures()
    });
    return true;
  }

  if (pathname === "/api/captures/apply") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/captures/apply" });
      return true;
    }

    const body = await readRequestJson(request);
    const result = await applyCapturedPrice(body.captureId, body.productId);
    sendJson(response, 200, await buildProductPayload("manual-capture-match", { capture: result }, "capture-match"));
    return true;
  }

  if (pathname === "/api/watchlist") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/watchlist" });
      return true;
    }

    const body = await readRequestJson(request);
    const watchlist = await updateWatchTarget(body.productId, body.targetPrice, body.note);
    sendJson(response, 200, await buildProductPayload("watchlist", { watchlist }, "watchlist"));
    return true;
  }

  if (pathname === "/api/import-feed") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/import-feed" });
      return true;
    }

    const body = await readRequestJson(request);
    const result = await importMerchantFeed(body.csvPath);
    sendJson(response, 200, await buildProductPayload("merchant-feed", { importer: result }, "merchant-feed"));
    return true;
  }

  if (pathname === "/api/import-feeds") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/import-feeds" });
      return true;
    }

    const body = await readRequestJson(request);
    const result = await importMerchantFeeds(body.directoryPath);
    sendJson(response, 200, await buildProductPayload("merchant-feed-directory", { importer: result }, "merchant-feed-directory"));
    return true;
  }

  if (pathname === "/api/settings") {
    sendJson(response, 200, {
      source: "data/settings.json",
      refreshedAt: new Date().toISOString(),
      settings: await readSettings(),
      scheduler: schedulerState
    });
    return true;
  }

  if (pathname === "/api/capture") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/capture" });
      return true;
    }

    const capture = await readRequestJson(request);
    const result = await capturePrice(capture);
    sendJson(response, 200, await buildProductPayload("browser-capture", { capture: result }, "browser-capture"));
    return true;
  }

  if (pathname === "/api/refresh") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/refresh" });
      return true;
    }

    const result = await updatePrices();
    const validation = result.validation || await readValidation();
    sendJson(response, 200, await buildProductPayload("feeds/manual-prices.csv", { updater: result, validation }, "manual-refresh"));
    return true;
  }

  if (pathname === "/api/refresh-adapters") {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Use POST /api/refresh-adapters" });
      return true;
    }

    const result = await refreshFromAdapters();
    sendJson(response, 200, await buildProductPayload("retailer-adapters", { adapterRefresh: result }, "adapter-refresh"));
    return true;
  }

  return false;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (await handleApi(request, response, url.pathname)) return;

    const filePath = safePath(url.pathname);
    if (!filePath || !existsSync(filePath)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
});

async function runScheduledRefresh() {
  try {
    await updatePrices();
    schedulerState.lastRunAt = new Date().toISOString();
    schedulerState.lastError = null;
  } catch (error) {
    schedulerState.lastError = error.message;
  }
}

async function startScheduler() {
  const settings = await readSettings();
  const enabled = process.env.SERVER_AUTO_REFRESH === "true" || settings.serverAutoRefresh === true;
  const intervalSeconds = Math.max(60, Number(settings.autoRefreshSeconds || 900));

  schedulerState.enabled = enabled;
  schedulerState.intervalSeconds = intervalSeconds;

  if (!enabled) return;
  scheduler = setInterval(runScheduledRefresh, intervalSeconds * 1000);
  scheduler.unref?.();
}

await startScheduler();

server.listen(port, () => {
  console.log(`Appliance Price Radar running at http://localhost:${port}/appliances/index.html`);
  console.log(`API feed available at http://localhost:${port}/api/products`);
  if (schedulerState.enabled) {
    console.log(`Server auto-refresh enabled every ${schedulerState.intervalSeconds}s`);
  }
});
