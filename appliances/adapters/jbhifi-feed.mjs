import { readFile } from "node:fs/promises";

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

export async function fetchOffers() {
  if (!process.env.JBHIFI_ADAPTER_CSV) {
    return {
      retailer: "JB Hi-Fi",
      status: "manual",
      offers: []
    };
  }

  const csvText = await readFile(process.env.JBHIFI_ADAPTER_CSV, "utf8");
  const offers = toRecords(csvText).map(row => ({
    productId: row.productId,
    retailer: "JB Hi-Fi",
    sku: row.sku,
    price: row.price,
    wasPrice: row.wasPrice,
    shipping: row.shipping,
    fees: row.fees,
    coupon: row.coupon,
    cashback: row.cashback,
    stock: row.stock,
    note: row.note || "JB Hi-Fi approved feed",
    productUrl: row.productUrl || row.url
  }));

  return {
    retailer: "JB Hi-Fi",
    status: "feed",
    offers
  };
}
