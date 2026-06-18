import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const asinMapPath = resolve(root, "data/amazon-asin-map.json");

async function readJson(path, fallback = []) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function hasCredentials() {
  return Boolean(
    process.env.AMAZON_PAAPI_ACCESS_KEY &&
    process.env.AMAZON_PAAPI_SECRET_KEY &&
    process.env.AMAZON_PAAPI_PARTNER_TAG
  );
}

function offerFromFixture(row, asinMap) {
  const mapping = asinMap.find(item => item.asin === row.asin);
  if (!mapping) return null;
  return {
    productId: mapping.productId,
    retailer: "Amazon AU",
    sku: row.asin,
    price: row.price,
    wasPrice: row.wasPrice,
    shipping: row.shipping,
    fees: row.fees,
    coupon: row.coupon,
    cashback: row.cashback,
    stock: row.stock || "Amazon availability returned",
    note: `Amazon PA-API fixture ${row.asin}`,
    productUrl: row.url || `https://www.amazon.com.au/dp/${row.asin}`,
    title: row.title || mapping.title || row.asin
  };
}

export async function fetchOffers() {
  const asinMap = await readJson(asinMapPath, []);
  const configured = hasCredentials();
  const fixturePath = process.env.AMAZON_PAAPI_FIXTURE
    ? resolve(process.cwd(), process.env.AMAZON_PAAPI_FIXTURE)
    : "";
  const fixtureRows = fixturePath ? await readJson(fixturePath, []) : [];
  const offers = fixtureRows
    .map(row => offerFromFixture(row, asinMap))
    .filter(Boolean);

  return {
    retailer: "Amazon AU",
    status: configured ? "configured" : "needs-credentials",
    offers,
    diagnostics: {
      asinMappings: asinMap.length,
      fixtureRows: fixtureRows.length,
      fixtureOffers: offers.length,
      credentialsConfigured: configured,
      missingCredentials: configured ? [] : [
        "AMAZON_PAAPI_ACCESS_KEY",
        "AMAZON_PAAPI_SECRET_KEY",
        "AMAZON_PAAPI_PARTNER_TAG"
      ],
      nextStep: configured
        ? "Replace fixture mode with signed PA-API GetItems calls for mapped ASINs."
        : "Set Amazon PA-API credentials and partner tag, or use AMAZON_PAAPI_FIXTURE for local testing."
    }
  };
}
