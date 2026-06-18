import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const productsPath = resolve(root, "data/products.json");
const fallbackPath = resolve(root, "data/products.js");
const historyPath = resolve(root, "data/price-history.json");
const capturesPath = resolve(root, "data/captured-prices.json");
const productMatchesPath = resolve(root, "data/product-matches.json");
const defaultCsvPath = resolve(root, "feeds/manual-prices.csv");
const defaultMerchantFeedPath = resolve(root, "feeds/merchant-feed-sample.csv");
const defaultMerchantFeedDir = resolve(root, "feeds/retailer-feeds");
const adapterSources = [
  "adapters/jbhifi-feed.mjs",
  "adapters/harvey-norman-feed.mjs",
  "adapters/the-good-guys-feed.mjs",
  "adapters/amazon-paapi.mjs"
];
const requiredHeaders = ["productId", "retailer", "price", "wasPrice", "stock", "note", "productUrl"];
const merchantFeedHeaders = ["retailer", "title", "price", "url", "stock", "wasPrice"];
const trackedRetailers = ["JB Hi-Fi", "Harvey Norman", "The Good Guys", "Amazon AU"];
const matchStopWords = new Set([
  "amazon",
  "au",
  "com",
  "www",
  "product",
  "products",
  "dp",
  "shop",
  "sale",
  "buy",
  "online",
  "australia",
  "jbhifi",
  "harvey",
  "norman",
  "good",
  "guys"
]);
const retailerHosts = [
  { retailer: "JB Hi-Fi", hosts: ["jbhifi.com.au"] },
  { retailer: "Harvey Norman", hosts: ["harveynorman.com.au"] },
  { retailer: "The Good Guys", hosts: ["thegoodguys.com.au"] },
  { retailer: "Amazon AU", hosts: ["amazon.com.au"] }
];

function parseCsv(text) {
  const rows = [];
  let cell = "";
  let row = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some(value => value.trim() !== "")) rows.push(row);
      cell = "";
      row = [];
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some(value => value.trim() !== "")) rows.push(row);
  return rows;
}

function toRecords(csvText) {
  const [headers, ...rows] = parseCsv(csvText);
  if (!headers) return [];

  return rows.map(row => Object.fromEntries(headers.map((header, index) => [
    header.trim(),
    (row[index] || "").trim()
  ])));
}

function validateCsvShape(csvText) {
  const [headers] = parseCsv(csvText);
  const headerSet = new Set((headers || []).map(header => header.trim()));
  return requiredHeaders
    .filter(header => !headerSet.has(header))
    .map(header => `Missing CSV header: ${header}`);
}

function missingHeaders(csvText, headers) {
  const [csvHeaders] = parseCsv(csvText);
  const headerSet = new Set((csvHeaders || []).map(header => header.trim()));
  return headers.filter(header => !headerSet.has(header));
}

function toNumber(value) {
  if (value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function parsePrice(value) {
  if (typeof value === "number") return value;
  if (!value) return null;
  const match = String(value).replace(/,/g, "").match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugify(value) {
  return normalizeText(value)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function defaultImageForCategory(category = "") {
  const normalized = normalizeText(category);
  if (normalized.includes("vacuum")) return "assets/appliance-vacuum.png";
  if (normalized.includes("coffee")) return "assets/appliance-coffee.png";
  if (normalized.includes("tv") || normalized.includes("oled")) return "assets/appliance-tv.png";
  return "assets/appliance-air-fryer.png";
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter(term => term.length > 2 && !matchStopWords.has(term));
}

function detectRetailer(url = "") {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return retailerHosts.find(entry => entry.hosts.some(item => host.endsWith(item)))?.retailer || "";
  } catch {
    return "";
  }
}

function scoreProduct(product, capture) {
  const haystack = new Set(words([
    product.model,
    product.brand,
    product.modelCode,
    ...(product.tags || []),
    ...(product.specs || [])
  ].join(" ")));
  const terms = words([capture.title, capture.selectedText, capture.url].join(" "));
  const matched = terms.filter(term => haystack.has(term));
  const exactModelBonus = normalizeText(capture.title).includes(normalizeText(product.modelCode || product.model)) ? 4 : 0;
  return matched.length + exactModelBonus;
}

function matchCapturedProduct(products, capture) {
  if (capture.productId) {
    const explicit = products.find(product => product.id === capture.productId);
    if (explicit) return { product: explicit, score: 999, confidence: "explicit" };
  }

  const ranked = products
    .map(product => ({ product, score: scoreProduct(product, capture) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 3) return { product: null, score: best?.score || 0, confidence: "none" };
  return {
    product: best.product,
    score: best.score,
    confidence: best.score >= 5 ? "high" : "review"
  };
}

function matchMappedProduct(products, productMatches, source) {
  const retailer = source.retailer || "";
  const sku = String(source.feedSku || source.sku || source.id || "").trim().toLowerCase();
  const url = normalizeText(source.url || source.productUrl || "");
  const title = normalizeText(source.title || source.name || "");

  const mapping = productMatches.find(item => {
    if (item.retailer && item.retailer !== retailer) return false;
    const mappedSku = String(item.sku || "").trim().toLowerCase();
    if (mappedSku && sku && mappedSku === sku) return true;
    if (item.urlContains && url.includes(normalizeText(item.urlContains))) return true;
    return (item.aliases || []).some(alias => {
      const normalizedAlias = normalizeText(alias);
      return normalizedAlias && title.includes(normalizedAlias);
    });
  });

  if (!mapping) return null;
  const product = products.find(item => item.id === mapping.productId);
  if (!product) return null;
  return {
    product,
    score: 1000,
    confidence: "mapped",
    mapping
  };
}

function validateUpdates(products, updates, csvText = "") {
  const errors = validateCsvShape(csvText);
  const warnings = [];
  const productById = new Map(products.map(product => [product.id, product]));
  const expectedKeys = new Set();
  const seenKeys = new Set();

  products.forEach(product => {
    product.offers.forEach(offer => expectedKeys.add(`${product.id}:${offer.retailer}`));
  });

  updates.forEach((update, index) => {
    const rowNumber = index + 2;
    const product = productById.get(update.productId);
    const key = `${update.productId}:${update.retailer}`;

    if (!update.productId) errors.push(`Row ${rowNumber}: productId is required`);
    if (!update.retailer) errors.push(`Row ${rowNumber}: retailer is required`);
    if (seenKeys.has(key)) warnings.push(`Row ${rowNumber}: duplicate update for ${key}; later value wins`);
    seenKeys.add(key);

    if (!product) {
      errors.push(`Row ${rowNumber}: unknown productId ${update.productId}`);
      return;
    }

    if (!product.offers.some(offer => offer.retailer === update.retailer)) {
      errors.push(`Row ${rowNumber}: ${update.retailer} is not an offer for ${update.productId}`);
    }

    try {
      const price = toNumber(update.price);
      const wasPrice = toNumber(update.wasPrice);
      if (typeof price !== "number" || price <= 0) errors.push(`Row ${rowNumber}: price must be a positive number`);
      if (typeof wasPrice === "number" && wasPrice < price) warnings.push(`Row ${rowNumber}: wasPrice is lower than price`);
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error.message}`);
    }

    if (!update.productUrl) warnings.push(`Row ${rowNumber}: productUrl is empty; page will use retailer search`);
  });

  const missingRows = [...expectedKeys].filter(key => !seenKeys.has(key));
  if (missingRows.length) {
    warnings.push(`${missingRows.length} offer rows are not covered by the CSV update`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rowCount: updates.length,
    expectedRowCount: expectedKeys.size,
    coveredRowCount: [...expectedKeys].filter(key => seenKeys.has(key)).length
  };
}

function applyUpdates(products, updates) {
  const byId = new Map(products.map(product => [product.id, product]));
  let changed = 0;

  for (const update of updates) {
    const product = byId.get(update.productId);
    if (!product) throw new Error(`Unknown productId in CSV: ${update.productId}`);

    const offer = product.offers.find(item => item.retailer === update.retailer);
    if (!offer) throw new Error(`Unknown retailer for ${update.productId}: ${update.retailer}`);

    offer.price = toNumber(update.price);
    offer.wasPrice = toNumber(update.wasPrice);
    if ("shipping" in update) offer.shipping = toNumber(update.shipping) || 0;
    if ("fees" in update) offer.fees = toNumber(update.fees) || 0;
    if ("coupon" in update) offer.coupon = toNumber(update.coupon) || 0;
    if ("cashback" in update) offer.cashback = toNumber(update.cashback) || 0;
    offer.stock = update.stock || offer.stock;
    offer.note = update.note || offer.note;
    offer.productUrl = update.productUrl || offer.productUrl || "";
    product.updated = `Manual CSV ${new Date().toISOString().slice(0, 10)}`;
    changed += 1;
  }

  return changed;
}

function jsFallback(products) {
  return `window.APPLIANCE_PRODUCTS = ${JSON.stringify(products, null, 2)};\n`;
}

async function writeProductsAndFallback(products) {
  await writeFile(productsPath, `${JSON.stringify(products, null, 2)}\n`, "utf8");
  await writeFile(fallbackPath, jsFallback(products), "utf8");
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(historyPath, "utf8"));
  } catch {
    return [];
  }
}

async function readCaptures() {
  try {
    return JSON.parse(await readFile(capturesPath, "utf8"));
  } catch {
    return [];
  }
}

async function readProductMatches() {
  try {
    return JSON.parse(await readFile(productMatchesPath, "utf8"));
  } catch {
    return [];
  }
}

function priceSnapshot(products) {
  return {
    capturedAt: new Date().toISOString(),
    products: products.map(product => ({
      id: product.id,
      model: product.model,
      offers: product.offers.map(offer => ({
        retailer: offer.retailer,
        price: offer.price,
        stock: offer.stock
      }))
    }))
  };
}

async function applyCaptureToProduct(products, captures, capture, product, match = {}) {
  const offer = product.offers.find(item => item.retailer === capture.retailer);
  if (!offer) throw new Error(`${capture.retailer} is not tracked for ${product.id}`);

  const previousPrice = offer.price;
  offer.price = capture.price;
  offer.productUrl = capture.url || offer.productUrl || "";
  offer.stock = capture.stock || offer.stock || "Captured live";
  offer.note = `Browser capture ${capture.capturedAt.slice(0, 16).replace("T", " ")}`;
  offer.capturedAt = capture.capturedAt;
  offer.source = "Browser capture";
  product.updated = `Browser capture ${capture.capturedAt.slice(0, 10)}`;

  const history = await readHistory();
  history.push(priceSnapshot(products));
  const recentHistory = history.slice(-120);
  const appliedRecord = {
    ...capture,
    status: "applied",
    productId: product.id,
    previousPrice,
    matchScore: match.score ?? null,
    matchConfidence: match.confidence || "manual"
  };
  captures.push(appliedRecord);

  await writeProductsAndFallback(products);
  await writeFile(historyPath, `${JSON.stringify(recentHistory, null, 2)}\n`, "utf8");
  await writeFile(capturesPath, `${JSON.stringify(captures.slice(-200), null, 2)}\n`, "utf8");

  return {
    applied: true,
    capture,
    productId: product.id,
    productModel: product.model,
    retailer: capture.retailer,
    previousPrice,
    price: capture.price,
    match: { score: match.score ?? null, confidence: match.confidence || "manual" },
    historyPath,
    capturesPath,
    snapshotCount: recentHistory.length
  };
}

function merchantRecordToCapture(record) {
  return {
    capturedAt: new Date().toISOString(),
    url: record.url || record.productUrl || "",
    title: record.title || record.name || "",
    selectedText: record.model || "",
    retailer: record.retailer || detectRetailer(record.url || record.productUrl),
    price: parsePrice(record.price),
    wasPrice: parsePrice(record.wasPrice),
    shipping: parsePrice(record.shipping),
    fees: parsePrice(record.fees),
    coupon: parsePrice(record.coupon),
    cashback: parsePrice(record.cashback),
    stock: record.stock || "",
    feedSku: record.sku || record.id || ""
  };
}

function applyFeedOffer(product, capture) {
  const offer = product.offers.find(item => item.retailer === capture.retailer);
  if (!offer) throw new Error(`${capture.retailer} is not tracked for ${product.id}`);

  const previousPrice = offer.price;
  offer.price = capture.price;
  offer.wasPrice = capture.wasPrice;
  offer.shipping = capture.shipping || 0;
  offer.fees = capture.fees || 0;
  offer.coupon = capture.coupon || 0;
  offer.cashback = capture.cashback || 0;
  offer.productUrl = capture.url || offer.productUrl || "";
  offer.stock = capture.stock || offer.stock || "Feed import";
  offer.note = `Merchant feed ${capture.capturedAt.slice(0, 16).replace("T", " ")}`;
  offer.capturedAt = capture.capturedAt;
  offer.source = "Merchant feed";
  product.updated = `Merchant feed ${capture.capturedAt.slice(0, 10)}`;
  return previousPrice;
}

function feedCaptureKey(capture) {
  return [
    capture.source || "Merchant feed",
    capture.feedSku || "",
    capture.retailer || "",
    capture.url || "",
    capture.title || ""
  ].join("|");
}

function upsertFeedCapture(captures, record) {
  const key = feedCaptureKey(record);
  const existingIndex = captures.findIndex(item => feedCaptureKey(item) === key);
  if (existingIndex >= 0) {
    captures[existingIndex] = {
      ...captures[existingIndex],
      ...record
    };
    return;
  }
  captures.push(record);
}

export async function updatePrices(csvPath = defaultCsvPath) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const csvText = await readFile(csvPath, "utf8");
  const updates = toRecords(csvText);
  const validation = validateUpdates(products, updates, csvText);
  if (!validation.ok) {
    const message = validation.errors.join("; ");
    throw new Error(`Manual price feed failed validation: ${message}`);
  }

  const changed = applyUpdates(products, updates);
  const history = await readHistory();
  history.push(priceSnapshot(products));
  const recentHistory = history.slice(-120);

  await writeProductsAndFallback(products);
  await writeFile(historyPath, `${JSON.stringify(recentHistory, null, 2)}\n`, "utf8");

  return {
    changed,
    csvPath,
    productsPath,
    fallbackPath,
    historyPath,
    snapshotCount: recentHistory.length,
    validation
  };
}

export async function validateManualFeed(csvPath = defaultCsvPath) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const csvText = await readFile(csvPath, "utf8");
  const updates = toRecords(csvText);
  return validateUpdates(products, updates, csvText);
}

export async function importMerchantFeed(csvPath = defaultMerchantFeedPath) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const productMatches = await readProductMatches();
  const csvText = await readFile(csvPath, "utf8");
  const rows = toRecords(csvText);
  const missing = missingHeaders(csvText, merchantFeedHeaders);
  if (missing.length) throw new Error(`Merchant feed missing headers: ${missing.join(", ")}`);

  const captures = await readCaptures();
  const applied = [];
  const pending = [];
  const errors = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    try {
      const capture = merchantRecordToCapture(row);
      if (!capture.retailer) throw new Error("retailer is required or must be detectable from url");
      if (!capture.title) throw new Error("title is required");
      if (typeof capture.price !== "number" || capture.price <= 0) throw new Error("price must be a positive number");

      const match = matchMappedProduct(products, productMatches, capture) || matchCapturedProduct(products, capture);
      if (!match.product || !["high", "mapped", "explicit"].includes(match.confidence)) {
        const pendingRecord = {
          ...capture,
          status: "needs-product-match",
          matchScore: match.score,
          id: `feed-${Date.now()}-${index}`,
          source: "Merchant feed",
          rowNumber
        };
        upsertFeedCapture(captures, pendingRecord);
        pending.push(pendingRecord);
        return;
      }

      const previousPrice = applyFeedOffer(match.product, capture);
      const appliedRecord = {
        ...capture,
        status: "applied",
        productId: match.product.id,
        previousPrice,
        matchScore: match.score,
        matchConfidence: match.confidence,
        source: "Merchant feed",
        rowNumber
      };
      upsertFeedCapture(captures, appliedRecord);
      applied.push(appliedRecord);
    } catch (error) {
      errors.push(`Row ${rowNumber}: ${error.message}`);
    }
  });

  if (applied.length) {
    const history = await readHistory();
    history.push(priceSnapshot(products));
    await writeFile(historyPath, `${JSON.stringify(history.slice(-120), null, 2)}\n`, "utf8");
    await writeProductsAndFallback(products);
  }

  if (applied.length || pending.length) {
    await writeFile(capturesPath, `${JSON.stringify(captures.slice(-200), null, 2)}\n`, "utf8");
  }

  return {
    csvPath,
    rowCount: rows.length,
    appliedCount: applied.length,
    pendingCount: pending.length,
    errorCount: errors.length,
    applied,
    pending,
    errors
  };
}

export async function importMerchantFeeds(directoryPath = defaultMerchantFeedDir) {
  await mkdir(directoryPath, { recursive: true });
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const csvFiles = entries
    .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === ".csv")
    .map(entry => resolve(directoryPath, entry.name))
    .sort((a, b) => a.localeCompare(b));

  const feeds = [];
  for (const csvFile of csvFiles) {
    feeds.push(await importMerchantFeed(csvFile));
  }

  return {
    directoryPath,
    feedCount: feeds.length,
    rowCount: feeds.reduce((total, feed) => total + feed.rowCount, 0),
    appliedCount: feeds.reduce((total, feed) => total + feed.appliedCount, 0),
    pendingCount: feeds.reduce((total, feed) => total + feed.pendingCount, 0),
    errorCount: feeds.reduce((total, feed) => total + feed.errorCount, 0),
    feeds
  };
}

function applyAdapterOffer(product, adapterOffer, capturedAt) {
  const offer = product.offers.find(item => item.retailer === adapterOffer.retailer);
  if (!offer) throw new Error(`${adapterOffer.retailer} is not tracked for ${product.id}`);

  const previousPrice = offer.price;
  offer.price = parsePrice(adapterOffer.price);
  offer.wasPrice = parsePrice(adapterOffer.wasPrice);
  offer.shipping = parsePrice(adapterOffer.shipping) || 0;
  offer.fees = parsePrice(adapterOffer.fees) || 0;
  offer.coupon = parsePrice(adapterOffer.coupon) || 0;
  offer.cashback = parsePrice(adapterOffer.cashback) || 0;
  offer.stock = adapterOffer.stock || offer.stock || "Adapter refresh";
  offer.note = adapterOffer.note || `Adapter refresh ${capturedAt.slice(0, 16).replace("T", " ")}`;
  offer.productUrl = adapterOffer.productUrl || adapterOffer.url || offer.productUrl || "";
  offer.capturedAt = capturedAt;
  offer.source = "Adapter";
  product.updated = `Adapter refresh ${capturedAt.slice(0, 10)}`;
  return previousPrice;
}

export async function refreshFromAdapters(adapterPaths = adapterSources) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const productMatches = await readProductMatches();
  const productById = new Map(products.map(product => [product.id, product]));
  const capturedAt = new Date().toISOString();
  const adapters = [];
  const applied = [];
  const errors = [];

  for (const adapterPath of adapterPaths) {
    const resolvedPath = resolve(root, adapterPath);
    try {
      const module = await import(`${pathToFileURL(resolvedPath).href}?ts=${Date.now()}`);
      if (typeof module.fetchOffers !== "function") throw new Error("Adapter must export fetchOffers()");
      const result = await module.fetchOffers({ products });
      const offers = Array.isArray(result?.offers) ? result.offers : [];
      const adapterSummary = {
        adapter: adapterPath,
        retailer: result?.retailer || "",
        status: result?.status || "unknown",
        diagnostics: result?.diagnostics || null,
        rowCount: offers.length,
        appliedCount: 0,
        errorCount: 0
      };

      offers.forEach((rawOffer, index) => {
        const rowNumber = index + 1;
        try {
          const adapterOffer = {
            ...rawOffer,
            retailer: rawOffer.retailer || result?.retailer || ""
          };
          const mapped = matchMappedProduct(products, productMatches, adapterOffer);
          const product = productById.get(adapterOffer.productId) || mapped?.product;
          if (!product) throw new Error(`unknown productId ${adapterOffer.productId || ""}`.trim());
          if (!adapterOffer.retailer) throw new Error("retailer is required");
          const price = parsePrice(adapterOffer.price);
          if (typeof price !== "number" || price <= 0) throw new Error("price must be a positive number");

          const previousPrice = applyAdapterOffer(product, adapterOffer, capturedAt);
          const appliedRecord = {
            adapter: adapterPath,
            productId: product.id,
            productModel: product.model,
            retailer: adapterOffer.retailer,
            previousPrice,
            price,
            capturedAt
          };
          applied.push(appliedRecord);
          adapterSummary.appliedCount += 1;
        } catch (error) {
          adapterSummary.errorCount += 1;
          errors.push(`${adapterPath} row ${rowNumber}: ${error.message}`);
        }
      });

      adapters.push(adapterSummary);
    } catch (error) {
      adapters.push({
        adapter: adapterPath,
        retailer: "",
        status: "error",
        diagnostics: { error: error.message },
        rowCount: 0,
        appliedCount: 0,
        errorCount: 1
      });
      errors.push(`${adapterPath}: ${error.message}`);
    }
  }

  if (applied.length) {
    const history = await readHistory();
    history.push(priceSnapshot(products));
    await writeFile(historyPath, `${JSON.stringify(history.slice(-120), null, 2)}\n`, "utf8");
    await writeProductsAndFallback(products);
  }

  return {
    adapterCount: adapterPaths.length,
    rowCount: adapters.reduce((total, adapter) => total + adapter.rowCount, 0),
    appliedCount: applied.length,
    errorCount: errors.length,
    adapters,
    applied,
    errors,
    productsPath,
    fallbackPath,
    historyPath
  };
}

export async function capturePrice(rawCapture) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const capturedAt = new Date().toISOString();
  const capture = {
    capturedAt,
    url: rawCapture.url || "",
    title: rawCapture.title || "",
    selectedText: rawCapture.selectedText || "",
    retailer: rawCapture.retailer || detectRetailer(rawCapture.url),
    price: parsePrice(rawCapture.price),
    productId: rawCapture.productId || ""
  };

  if (!capture.retailer) throw new Error("Could not detect retailer from captured URL");
  if (typeof capture.price !== "number" || capture.price <= 0) throw new Error("Could not detect a valid price");

  const match = matchCapturedProduct(products, capture);
  if (!match.product) {
    const captures = await readCaptures();
    captures.push({ ...capture, status: "needs-product-match", matchScore: match.score, id: `${Date.now()}-${captures.length}` });
    await writeFile(capturesPath, `${JSON.stringify(captures.slice(-200), null, 2)}\n`, "utf8");
    return {
      applied: false,
      capture,
      match: { score: match.score, confidence: match.confidence },
      message: "Captured price was saved but did not match a tracked product"
    };
  }

  const captures = await readCaptures();
  return applyCaptureToProduct(products, captures, capture, match.product, match);
}

export async function addTrackedProduct(rawProduct) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const model = String(rawProduct.model || "").trim();
  const category = String(rawProduct.category || "Kitchen").trim() || "Kitchen";
  const brand = String(rawProduct.brand || "").trim();
  const modelCode = String(rawProduct.modelCode || "").trim();
  const targetPrice = parsePrice(rawProduct.targetPrice);

  if (!model) throw new Error("Product model is required");

  const idBase = slugify(rawProduct.id || `${brand} ${modelCode || model}` || model);
  if (!idBase) throw new Error("Could not create product id");
  let id = idBase;
  let suffix = 2;
  while (products.some(product => product.id === id)) {
    id = `${idBase}-${suffix}`;
    suffix += 1;
  }

  const now = new Date().toISOString();
  const product = {
    id,
    model,
    category,
    image: rawProduct.image || defaultImageForCategory(category),
    confidence: "Needs review",
    evidence: "User-created tracked product; capture or feed prices to compare live offers",
    updated: `Created ${now.slice(0, 10)}`,
    tags: [category, brand].filter(Boolean),
    offers: trackedRetailers.map(retailer => ({
      retailer,
      price: null,
      wasPrice: null,
      stock: "Not captured yet",
      note: "Open retailer page and use the capture bookmarklet",
      productUrl: ""
    })),
    brand,
    modelCode: modelCode || model,
    specs: String(rawProduct.specs || "")
      .split(/\n|,/)
      .map(item => item.trim())
      .filter(Boolean),
    matchChecklist: [
      "Confirm exact model code",
      "Confirm capacity/colour/accessories",
      "Confirm AU warranty"
    ]
  };

  products.push(product);
  await writeProductsAndFallback(products);

  return {
    product,
    targetPrice,
    productsPath,
    fallbackPath
  };
}

export async function applyCapturedPrice(captureId, productId) {
  const products = JSON.parse(await readFile(productsPath, "utf8"));
  const captures = await readCaptures();
  const captureIndex = captures.findIndex(item => item.id === captureId || item.capturedAt === captureId);
  if (captureIndex < 0) throw new Error(`Unknown capture id: ${captureId}`);

  const capture = captures[captureIndex];
  if (capture.status !== "needs-product-match") throw new Error("Capture is already applied or not matchable");

  const product = products.find(item => item.id === productId);
  if (!product) throw new Error(`Unknown product id: ${productId}`);

  captures.splice(captureIndex, 1);
  return applyCaptureToProduct(products, captures, capture, product, { score: capture.matchScore, confidence: "manual" });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const csvPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : defaultCsvPath;
  const result = await updatePrices(csvPath);

  console.log(`Updated ${result.changed} offer rows from ${result.csvPath}`);
  console.log(`Wrote ${result.productsPath}`);
  console.log(`Wrote ${result.fallbackPath}`);
  console.log(`Wrote ${result.historyPath}`);
}
