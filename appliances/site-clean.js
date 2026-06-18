const retailerSearch = {
  "JB Hi-Fi": "https://www.jbhifi.com.au/search?query=",
  "Harvey Norman": "https://www.harveynorman.com.au/catalogsearch/result/?q=",
  "The Good Guys": "https://www.thegoodguys.com.au/search?text=",
  "Amazon AU": "https://www.amazon.com.au/s?k="
};

const retailerTone = {
  "JB Hi-Fi": "jb",
  "Harvey Norman": "hn",
  "The Good Guys": "tgg",
  "Amazon AU": "amazon"
};

let products = [];
let watchlist = [];
let sources = [];
let captures = [];
let alerts = [];
let priceHistory = [];
let validation = null;
let adapterRefresh = null;
let settings = {
  autoRefreshSeconds: 900,
  priceFreshnessWarningMinutes: 60,
  defaultPostcode: "4000"
};
let deliveryRules = [];
let activeCategory = "all";
let searchTerm = "";
let sortBySavings = false;
let feedMode = "loading";
let lastRefreshedAt = "";
let activePostcode = window.localStorage.getItem("appliancePostcode") || "";
let autoRefreshEnabled = false;
let autoRefreshTimer = null;
let autoRefreshRemaining = 0;

function money(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "待采集";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0
  }).format(value);
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchJson(url, fallback) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status}`);
    return await response.json();
  } catch {
    return fallback;
  }
}

function searchUrl(retailer, model) {
  const base = retailerSearch[retailer] || "https://www.google.com/search?q=";
  return `${base}${encodeURIComponent(model)}`;
}

function offerUrl(offer, productItem) {
  return offer.productUrl || searchUrl(offer.retailer, productItem.model);
}

function deliveryRuleFor(offer) {
  return deliveryRules.find(rule => rule.retailer === offer.retailer) || null;
}

function isBulkyProduct(productItem) {
  const category = String(productItem?.category || "").toLowerCase();
  const text = [productItem?.model, productItem?.modelCode, ...(productItem?.specs || [])].join(" ").toLowerCase();
  return category === "tv" || text.includes("55 inch") || text.includes("oled") || text.includes("fridge") || text.includes("washing");
}

function estimatedShipping(offer, productItem) {
  if (typeof offer.shipping === "number" && Number.isFinite(offer.shipping)) return offer.shipping;
  const rule = deliveryRuleFor(offer);
  if (!rule || typeof offer.price !== "number") return 0;
  if (typeof rule.freeShippingOver === "number" && offer.price >= rule.freeShippingOver) return 0;
  const shipping = isBulkyProduct(productItem) ? rule.bulkyShipping : rule.standardShipping;
  return typeof shipping === "number" && Number.isFinite(shipping) ? shipping : 0;
}

function offerTotal(offer, productItem) {
  if (typeof offer.price !== "number" || !Number.isFinite(offer.price)) return null;
  return Math.max(0, offer.price + estimatedShipping(offer, productItem) + numberOrZero(offer.fees) - numberOrZero(offer.coupon) - numberOrZero(offer.cashback));
}

function comparisonPrice(offer, productItem) {
  const total = offerTotal(offer, productItem);
  return typeof total === "number" ? total : offer.price;
}

function bestOffer(productItem) {
  const priced = (productItem.offers || []).filter(offer => typeof comparisonPrice(offer, productItem) === "number" && Number.isFinite(comparisonPrice(offer, productItem)));
  if (!priced.length) return (productItem.offers || [])[0] || null;
  return priced.reduce((best, offer) => comparisonPrice(offer, productItem) < comparisonPrice(best, productItem) ? offer : best, priced[0]);
}

function productSaving(productItem) {
  const prices = (productItem.offers || [])
    .map(offer => comparisonPrice(offer, productItem))
    .filter(value => typeof value === "number" && Number.isFinite(value));
  if (prices.length < 2) return 0;
  return Math.max(...prices) - Math.min(...prices);
}

function freshnessInfo(offer) {
  if (!offer?.capturedAt) return { state: "unknown", label: "时间未知", title: "这个价格没有采集时间，购买前请复核。" };
  const captured = new Date(offer.capturedAt);
  if (Number.isNaN(captured.getTime())) return { state: "unknown", label: "时间未知", title: "采集时间无法识别。" };
  const ageMinutes = Math.max(0, Math.round((Date.now() - captured.getTime()) / 60000));
  const limit = Number(settings.priceFreshnessWarningMinutes || 60);
  if (ageMinutes <= limit) return { state: "fresh", label: "价格新鲜", title: `约 ${formatAge(ageMinutes)} 更新` };
  if (ageMinutes <= limit * 6) return { state: "stale", label: "建议复核", title: `约 ${formatAge(ageMinutes)} 更新` };
  return { state: "empty", label: "可能过期", title: `约 ${formatAge(ageMinutes)} 更新` };
}

function formatAge(minutes) {
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function stockPenalty(offer) {
  const stock = String(offer.stock || "").toLowerCase();
  if (!stock) return 4;
  if (stock.includes("out") || stock.includes("unavailable")) return 35;
  if (stock.includes("check") || stock.includes("varies")) return 8;
  return 0;
}

function confidencePenalty(productItem) {
  const confidence = String(productItem.confidence || "").toLowerCase();
  if (confidence.includes("high")) return 0;
  if (confidence.includes("medium")) return 8;
  return 14;
}

function freshnessPenalty(offer) {
  const state = freshnessInfo(offer).state;
  if (state === "fresh") return 0;
  if (state === "unknown") return 8;
  if (state === "stale") return 14;
  return 22;
}

function offerRecommendation(productItem, offer) {
  const total = comparisonPrice(offer, productItem);
  if (typeof total !== "number" || !Number.isFinite(total)) {
    return { score: 0, tier: "missing", label: "待采集", reasons: ["暂无可用价格"] };
  }

  const prices = (productItem.offers || [])
    .map(item => comparisonPrice(item, productItem))
    .filter(value => typeof value === "number" && Number.isFinite(value));
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const spread = high - low;
  const pricePenalty = spread > 0 ? Math.min(42, Math.round(((total - low) / spread) * 42)) : 0;
  const score = Math.max(0, 100 - pricePenalty - stockPenalty(offer) - freshnessPenalty(offer) - confidencePenalty(productItem));
  const tier = score >= 82 ? "primary" : score >= 64 ? "backup" : "review";
  const reasons = [];

  reasons.push(pricePenalty === 0 ? "最低到手价" : `比最低贵 ${money(total - low)}`);
  if (freshnessInfo(offer).state === "fresh") reasons.push("价格较新");
  if (freshnessInfo(offer).state !== "fresh") reasons.push("下单前复核");
  if (stockPenalty(offer) >= 8) reasons.push("库存需确认");
  if (confidencePenalty(productItem) > 0) reasons.push("确认同款型号");

  return {
    score,
    tier,
    label: tier === "primary" ? "首选" : tier === "backup" ? "备选" : "需复核",
    reasons: reasons.slice(0, 3)
  };
}

function rankedOffers(productItem) {
  return (productItem.offers || [])
    .map(offer => ({ offer, recommendation: offerRecommendation(productItem, offer) }))
    .sort((a, b) => b.recommendation.score - a.recommendation.score);
}

function purchaseDecision(productItem) {
  const best = bestOffer(productItem);
  const bestTotal = best ? comparisonPrice(best, productItem) : null;
  if (typeof bestTotal !== "number" || !Number.isFinite(bestTotal)) return { state: "missing", label: "等待采集价格" };
  const target = productItem.watch?.targetPrice;
  if (typeof target !== "number") return { state: "neutral", label: "未设目标价" };
  const delta = bestTotal - target;
  if (delta <= 0) return { state: "buy", label: `达到目标价，低 ${money(Math.abs(delta))}` };
  return { state: "wait", label: `再等等，还差 ${money(delta)}` };
}

function normaliseProduct(productItem) {
  return {
    ...productItem,
    tags: productItem.tags || [],
    watch: productItem.watch || null,
    offers: (productItem.offers || []).map(offer => ({
      ...offer,
      tone: retailerTone[offer.retailer] || "generic"
    }))
  };
}

function applyWatchlist(feedProducts) {
  const byProduct = new Map(watchlist.map(item => [item.productId, item]));
  return feedProducts.map(product => ({
    ...product,
    watch: byProduct.get(product.id) || product.watch || null
  }));
}

function annotateMovements(feedProducts, previousSnapshot) {
  if (!previousSnapshot?.products) return feedProducts;
  const previous = new Map();
  previousSnapshot.products.forEach(product => {
    (product.offers || []).forEach(offer => previous.set(`${product.id}:${offer.retailer}`, offer.price));
  });
  return feedProducts.map(product => ({
    ...product,
    offers: product.offers.map(offer => {
      const oldPrice = previous.get(`${product.id}:${offer.retailer}`);
      return {
        ...offer,
        previousPrice: oldPrice,
        movement: typeof oldPrice === "number" && typeof offer.price === "number" ? offer.price - oldPrice : null
      };
    })
  }));
}

function productsFromPayload(payload) {
  lastRefreshedAt = payload.refreshedAt || "";
  watchlist = payload.watchlist || watchlist || [];
  sources = payload.sources || sources || [];
  captures = payload.captures || captures || [];
  alerts = payload.alerts || alerts || [];
  validation = payload.validation || validation;
  adapterRefresh = payload.adapterRefresh || adapterRefresh;
  settings = { ...settings, ...(payload.settings || {}) };
  const previous = payload.history?.previous || null;
  return annotateMovements(applyWatchlist((payload.products || []).map(normaliseProduct)), previous);
}

function setFeedStatus(message, mode = feedMode) {
  feedMode = mode;
  const status = document.getElementById("feedStatus");
  const source = document.getElementById("feedSource");
  if (status) status.textContent = message;
  if (source) source.textContent = mode;
}

function feedQualityMessage(refreshedAt, feedValidation, prefix = "已读取价格数据") {
  const time = refreshedAt ? `更新时间：${formatTime(refreshedAt)}` : "更新时间未知";
  const errors = feedValidation?.errors?.length ? `，校验错误 ${feedValidation.errors.length} 个` : "";
  const warnings = feedValidation?.warnings?.length ? `，提醒 ${feedValidation.warnings.length} 个` : "";
  return `${prefix}。${time}${errors}${warnings}`;
}

function formatTime(value) {
  if (!value) return "未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function loadProducts() {
  try {
    const response = await fetch("/api/products", { cache: "no-store" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();
    setFeedStatus(feedQualityMessage(payload.refreshedAt, payload.validation), "Local API");
    return productsFromPayload(payload);
  } catch (error) {
    console.info("API unavailable, using static data:", error.message);
  }

  const feed = await fetchJson("data/products.json", window.APPLIANCE_PRODUCTS || []);
  watchlist = await fetchJson("data/watchlist.json", window.APPLIANCE_WATCHLIST || []);
  sources = await fetchJson("data/sources.json", []);
  settings = { ...settings, ...(await fetchJson("data/settings.json", {})) };
  setFeedStatus("正在使用静态 JSON 数据。启动本地服务后可使用刷新、导入和采集功能。", "Static JSON");
  return applyWatchlist(feed.map(normaliseProduct));
}

async function loadSupportData() {
  deliveryRules = await fetchJson("data/delivery-rules.json", []);
  priceHistory = await fetchJson("/api/history", null);
  priceHistory = Array.isArray(priceHistory) ? priceHistory : priceHistory?.history || await fetchJson("data/price-history.json", []);
  captures = await fetchJson("/api/captures", null);
  captures = Array.isArray(captures) ? captures : captures?.captures || [];
}

function filteredProducts() {
  const query = searchTerm.toLowerCase();
  let result = products.filter(product => {
    const categoryMatch = activeCategory === "all" || product.category === activeCategory;
    const haystack = [
      product.model,
      product.brand,
      product.modelCode,
      product.category,
      ...(product.tags || []),
      ...(product.specs || [])
    ].join(" ").toLowerCase();
    return categoryMatch && (!query || haystack.includes(query));
  });
  if (sortBySavings) result = [...result].sort((a, b) => productSaving(b) - productSaving(a));
  return result;
}

function renderSummary() {
  const modelCount = document.getElementById("modelCount");
  const largestSpread = document.getElementById("largestSpread");
  const heroBest = document.getElementById("heroBest");
  const priced = products
    .map(product => ({ product, offer: bestOffer(product) }))
    .filter(row => row.offer && typeof comparisonPrice(row.offer, row.product) === "number");
  const bestRow = priced.sort((a, b) => comparisonPrice(a.offer, a.product) - comparisonPrice(b.offer, b.product))[0];

  if (modelCount) modelCount.textContent = String(products.length);
  if (largestSpread) largestSpread.textContent = money(Math.max(0, ...products.map(productSaving)));
  if (heroBest) {
    heroBest.textContent = bestRow
      ? `${bestRow.product.model}: ${money(comparisonPrice(bestRow.offer, bestRow.product))} @ ${bestRow.offer.retailer}`
      : "暂无可用价格";
  }
}

function renderSourceStrip() {
  const strip = document.getElementById("sourceStrip");
  if (!strip) return;
  if (!sources.length) {
    strip.innerHTML = `<article class="source-chip manual"><strong>数据源</strong><span>静态演示数据</span><small>连接本地 API 后可刷新</small></article>`;
    return;
  }
  const adapterByPath = new Map((adapterRefresh?.adapters || []).map(item => [item.adapter, item]));
  strip.innerHTML = sources.map(source => {
    const adapter = adapterByPath.get(source.adapter);
    const diagnostic = adapter?.diagnostics?.credentialsConfigured === false ? "Amazon PA-API 需要凭证" : adapter?.diagnostics?.nextStep || "";
    return `
      <article class="source-chip ${escapeHtml(adapter?.status || source.health || source.status || "manual")}">
        <strong>${escapeHtml(source.retailer)}</strong>
        <span>${escapeHtml(source.method || "Feed")}</span>
        <small>${escapeHtml(source.refreshCadence || "按需刷新")}</small>
        ${source.offerCount ? `<em>${source.offerCount} 个报价</em>` : ""}
        ${source.coverage !== null && source.coverage !== undefined ? `<em>${source.coverage}% CSV 覆盖</em>` : ""}
        ${adapter ? `<em>Adapter ${escapeHtml(adapter.status)}: ${adapter.appliedCount}/${adapter.rowCount} applied</em>` : ""}
        ${diagnostic ? `<em>${escapeHtml(diagnostic)}</em>` : ""}
      </article>
    `;
  }).join("");
}

function renderOpportunityPanel() {
  const panel = document.getElementById("opportunityPanel");
  if (!panel) return;
  const rows = filteredProducts().map(product => {
    const best = bestOffer(product);
    return { product, best, decision: purchaseDecision(product) };
  });
  const counts = {
    buy: rows.filter(row => row.decision.state === "buy").length,
    wait: rows.filter(row => row.decision.state === "wait").length,
    missing: rows.filter(row => row.decision.state === "missing").length,
    neutral: rows.filter(row => row.decision.state === "neutral").length
  };
  const topRows = rows
    .sort((a, b) => {
      const order = { buy: 0, wait: 1, neutral: 2, missing: 3 };
      return order[a.decision.state] - order[b.decision.state] || productSaving(b.product) - productSaving(a.product);
    })
    .slice(0, 4);

  panel.innerHTML = `
    <div class="opportunity-head">
      <div>
        <span>购买机会</span>
        <strong>${counts.buy ? `${counts.buy} 个型号达到目标价` : "先设置目标价，再判断该买还是再等"}</strong>
      </div>
      <div class="opportunity-counts">
        <span class="buy">可买 ${counts.buy}</span>
        <span class="wait">再等等 ${counts.wait}</span>
        <span class="missing">待采集 ${counts.missing}</span>
        <span>未设目标 ${counts.neutral}</span>
      </div>
    </div>
    <div class="opportunity-list">
      ${topRows.length ? topRows.map(row => {
        const total = row.best ? comparisonPrice(row.best, row.product) : null;
        return `
          <button class="opportunity-card ${row.decision.state}" type="button" data-product-id="${escapeHtml(row.product.id)}">
            <span>${escapeHtml(row.product.category || "Appliance")}</span>
            <strong>${escapeHtml(row.product.model)}</strong>
            <em>${total ? `${money(total)} @ ${escapeHtml(row.best.retailer)}` : "暂无价格"}</em>
            <small>${escapeHtml(row.decision.label)}；价差 ${money(productSaving(row.product))}</small>
          </button>
        `;
      }).join("") : `<div class="opportunity-empty"><strong>没有匹配商品</strong><span>换一个关键词或清除筛选。</span></div>`}
    </div>
  `;
}

function renderAlerts() {
  const panel = document.getElementById("alertPanel");
  if (!panel) return;
  if (!alerts.length) {
    panel.innerHTML = "";
    return;
  }
  const recent = alerts.slice(0, 3);
  panel.innerHTML = `
    <section class="price-alerts">
      <div class="alert-head">
        <div>
          <span>价格提醒</span>
          <strong>最近 ${alerts.length} 条提醒</strong>
        </div>
        <small>刷新或导入后自动生成</small>
      </div>
      <div class="alert-list">
        ${recent.map(alert => `
          <article class="alert-card ${escapeHtml(alert.type)}">
            <span>${escapeHtml(alert.type === "target-met" ? "达到目标价" : "近期新低")}</span>
            <strong>${escapeHtml(alert.model || alert.productId)}</strong>
            <em>${money(alert.price)} @ ${escapeHtml(alert.retailer)}</em>
            <small>${formatTime(alert.createdAt)}</small>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderCaptureQueue() {
  const queue = document.getElementById("captureQueue");
  if (!queue) return;
  const pending = (captures || []).filter(item => item.status === "needs-product-match");
  if (!pending.length) {
    queue.innerHTML = "";
    return;
  }
  const options = products.map(product => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.model)}</option>`).join("");
  queue.innerHTML = `
    <section class="capture-panel">
      <div>
        <span>待匹配采集</span>
        <strong>${pending.length} 条采集价格需要绑定到追踪商品</strong>
      </div>
      <div class="capture-list">
        ${pending.map(item => `
          <form class="capture-match" data-capture-id="${escapeHtml(item.id || item.capturedAt)}">
            <div>
              <strong>${escapeHtml(item.retailer || "Unknown")} ${money(item.price)}</strong>
              <span>${escapeHtml(item.title || item.url || "Untitled capture")}</span>
              <small>${formatTime(item.capturedAt)}</small>
            </div>
            <select name="productId" aria-label="Choose product">${options}</select>
            <button type="submit">绑定价格</button>
          </form>
        `).join("")}
      </div>
    </section>
  `;
}

function renderMovement(offer) {
  if (typeof offer.price !== "number") return `<span class="movement neutral">等待价格</span>`;
  if (typeof offer.movement !== "number") return `<span class="movement neutral">暂无历史</span>`;
  if (offer.movement === 0) return `<span class="movement neutral">价格未变</span>`;
  const className = offer.movement < 0 ? "down" : "up";
  const label = offer.movement < 0 ? `降价 ${money(Math.abs(offer.movement))}` : `涨价 ${money(offer.movement)}`;
  return `<span class="movement ${className}">${label}</span>`;
}

function renderOffer(productItem, offer, isBest) {
  const total = comparisonPrice(offer, productItem);
  const best = bestOffer(productItem);
  const bestTotal = best ? comparisonPrice(best, productItem) : null;
  const compareText = typeof total !== "number"
    ? "等待采集"
    : isBest
      ? "当前最低到手价"
      : typeof bestTotal === "number"
        ? `比最低贵 ${money(total - bestTotal)}`
        : "等待采集";
  const recommendation = offerRecommendation(productItem, offer);
  const freshness = freshnessInfo(offer);
  const shipping = estimatedShipping(offer, productItem);
  const breakdown = typeof total === "number"
    ? `<span class="landed-total">到手 ${money(total)} <small>${shipping ? `配送 ${money(shipping)}` : "配送 $0"}${numberOrZero(offer.coupon) ? ` 优惠 -${money(offer.coupon)}` : ""}${numberOrZero(offer.cashback) ? ` 返现 -${money(offer.cashback)}` : ""}</small></span>`
    : `<span class="landed-total">到手 待采集</span>`;

  return `
    <section class="offer ${escapeHtml(offer.tone)} ${isBest ? "is-best" : ""}">
      <div class="retailer">
        <strong>${escapeHtml(offer.retailer)}</strong>
        <span>${escapeHtml(compareText)}</span>
      </div>
      <div class="recommendation-badge ${escapeHtml(recommendation.tier)}">
        <strong>${escapeHtml(recommendation.label)} · ${recommendation.score}</strong>
        <small>${escapeHtml(recommendation.reasons.join(" / "))}</small>
      </div>
      <div class="price">
        <strong>${money(offer.price)}</strong>
        ${typeof offer.wasPrice === "number" ? `<s>${money(offer.wasPrice)}</s>` : ""}
      </div>
      ${breakdown}
      ${renderMovement(offer)}
      <span class="freshness-badge ${escapeHtml(freshness.state)}" title="${escapeHtml(freshness.title)}">${escapeHtml(freshness.label)}</span>
      <span class="${/out|unavailable/i.test(offer.stock || "") ? "stock out" : "stock"}">${escapeHtml(offer.stock || "库存待确认")}</span>
      <p>${escapeHtml(offer.note || "购买前请复核零售商页面。")}</p>
      <a href="${escapeHtml(offerUrl(offer, productItem))}" target="_blank" rel="noopener">打开 ${escapeHtml(offer.retailer)}</a>
    </section>
  `;
}

function renderMatchPanel(productItem) {
  const specs = productItem.specs || [];
  const checklist = productItem.matchChecklist || [];
  if (!productItem.modelCode && !specs.length && !checklist.length) return "";
  return `
    <div class="match-panel">
      <div>
        <span>同款核对</span>
        <strong>${escapeHtml(productItem.brand || "Brand")} ${escapeHtml(productItem.modelCode || productItem.model)}</strong>
      </div>
      ${specs.length ? `<ul class="spec-list">${specs.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      ${checklist.length ? `<ol class="check-list">${checklist.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ol>` : ""}
    </div>
  `;
}

function liveCheckSummary(productItem) {
  const offers = productItem.offers || [];
  const needsCheck = offers.filter(offer => ["stale", "unknown", "empty"].includes(freshnessInfo(offer).state) || typeof offer.price !== "number");
  const fresh = offers.length - needsCheck.length;
  const state = !needsCheck.length ? "ready" : fresh ? "partial" : "review";
  return { state, fresh, needsCheck, missing: offers.filter(offer => typeof offer.price !== "number").length };
}

function renderLiveCheck(productItem) {
  const summary = liveCheckSummary(productItem);
  const label = summary.state === "ready" ? "所有价格都可直接参考" : summary.state === "partial" ? "部分商家需要复核" : "建议先采集价格";
  return `
    <div class="live-check ${summary.state}">
      <div>
        <span>下单前复核</span>
        <strong>${label}</strong>
        <small>${summary.needsCheck.length ? summary.needsCheck.map(row => row.retailer).join("、") : "当前卡片没有明显过期价格。"}</small>
      </div>
      <dl>
        <div><dt>新鲜</dt><dd>${summary.fresh}</dd></div>
        <div><dt>需复核</dt><dd>${summary.needsCheck.length}</dd></div>
        <div><dt>待采集</dt><dd>${summary.missing}</dd></div>
      </dl>
      <button class="open-needed-retailers" type="button" data-product-id="${escapeHtml(productItem.id)}">打开需复核</button>
    </div>
  `;
}

function renderHistory(productItem) {
  const snapshots = (priceHistory || []).filter(snapshot => snapshot.products?.some(item => item.id === productItem.id)).slice(-5);
  if (!snapshots.length) return "";
  const values = snapshots
    .map(snapshot => snapshot.products.find(item => item.id === productItem.id))
    .map(product => Math.min(...(product.offers || []).map(offer => offer.price).filter(value => typeof value === "number")))
    .filter(value => Number.isFinite(value));
  if (!values.length) return "";
  return `
    <div class="history-panel">
      <div><span>近期历史</span><strong>${snapshots.length} 次快照</strong></div>
      <dl>
        <div><dt>最低</dt><dd>${money(Math.min(...values))}</dd></div>
        <div><dt>最高</dt><dd>${money(Math.max(...values))}</dd></div>
        <div><dt>最新</dt><dd>${money(values.at(-1))}</dd></div>
      </dl>
    </div>
  `;
}

function renderProductCard(productItem) {
  const best = bestOffer(productItem);
  const bestTotal = best ? comparisonPrice(best, productItem) : null;
  const saving = productSaving(productItem);
  const decision = purchaseDecision(productItem);
  const ranking = rankedOffers(productItem);
  const recommended = ranking[0];

  return `
    <article class="product-card" id="product-${escapeHtml(productItem.id)}">
      <div class="product-head">
        <div class="product-image">
          <img src="${escapeHtml(productItem.image || "assets/appliance-vacuum.png")}" alt="${escapeHtml(productItem.model)}">
        </div>
        <div class="product-title">
          <span class="category">${escapeHtml(productItem.category || "Appliance")}</span>
          <h3>${escapeHtml(productItem.model)}</h3>
          <p>${escapeHtml(productItem.evidence || "按同款型号进行横向比较。")}</p>
          <div class="product-meta">
            <span>${escapeHtml(productItem.confidence || "Needs review")}</span>
            <span>价差 ${money(saving)}</span>
            <span>${escapeHtml(productItem.updated || "Demo feed")}</span>
          </div>
          ${renderMatchPanel(productItem)}
          ${renderLiveCheck(productItem)}
          ${renderHistory(productItem)}
        </div>
        <div class="best-box ${decision.state}">
          <span>建议购买方</span>
          <strong>${typeof bestTotal === "number" ? money(bestTotal) : "待采集"}</strong>
          <small>${best ? escapeHtml(best.retailer) : "No retailer"}</small>
          <em>${saving ? `最高可省 ${money(saving)}` : "暂无价差"}</em>
          <i>${recommended ? `${escapeHtml(recommended.recommendation.label)}：${escapeHtml(recommended.recommendation.reasons.join(" / "))}` : "暂无推荐"}</i>
          <b>${escapeHtml(decision.label)}</b>
          <form class="target-form" data-product-id="${escapeHtml(productItem.id)}">
            <label>
              目标到手价
              <input name="targetPrice" type="number" min="1" step="1" value="${productItem.watch?.targetPrice || ""}" placeholder="例如 999">
            </label>
            <button type="submit">保存</button>
          </form>
        </div>
      </div>
      <div class="offer-grid">
        ${(productItem.offers || []).map(offer => renderOffer(productItem, offer, offer === best)).join("")}
      </div>
      <div class="source-links">
        <span>购物动作</span>
        <button class="open-all-retailers" type="button" data-product-id="${escapeHtml(productItem.id)}">打开四家商家</button>
        <button class="copy-checklist" type="button" data-product-id="${escapeHtml(productItem.id)}">复制下单核对清单</button>
        ${(productItem.offers || []).map(offer => `<a href="${escapeHtml(offerUrl(offer, productItem))}" target="_blank" rel="noopener">${escapeHtml(offer.retailer)}</a>`).join("")}
      </div>
    </article>
  `;
}

function renderProducts() {
  renderSummary();
  renderSourceStrip();
  renderOpportunityPanel();
  renderAlerts();
  renderCaptureQueue();

  const grid = document.getElementById("productGrid");
  if (!grid) return;
  const visible = filteredProducts();
  grid.innerHTML = visible.length
    ? visible.map(renderProductCard).join("")
    : `<section class="empty-state"><h3>没有找到匹配型号</h3><p>试试清除关键词，或新增一个你想追踪的型号。</p></section>`;
}

function shoppingChecklist(productItem) {
  const best = bestOffer(productItem);
  const bestTotal = best ? comparisonPrice(best, productItem) : null;
  const recommendations = rankedOffers(productItem);
  return [
    `Appliance Price Radar 下单核对清单`,
    `型号: ${productItem.model}`,
    `品牌: ${productItem.brand || "待确认"}`,
    `型号代码: ${productItem.modelCode || "待确认"}`,
    `配送邮编: ${activePostcode || settings.defaultPostcode || "4000"}`,
    `当前最低到手价: ${best ? `${money(bestTotal)} @ ${best.retailer}` : "待采集"}`,
    `目标价: ${productItem.watch?.targetPrice ? money(productItem.watch.targetPrice) : "未设置"}`,
    "",
    "推荐排序:",
    ...recommendations.map(({ offer, recommendation }) => `- ${recommendation.label} ${offer.retailer}: score ${recommendation.score}; ${recommendation.reasons.join("; ")}`),
    "",
    "商家价格、到手价与链接:",
    ...(productItem.offers || []).map(offer => `- ${offer.retailer}: price ${money(offer.price)} / landed ${money(comparisonPrice(offer, productItem))}; ${offer.stock || "库存待确认"}; ${offerUrl(offer, productItem)}`),
    "",
    "下单前核对:",
    ...(productItem.matchChecklist || []).map(item => `- ${item}`),
    "- 确认配送费、保修、退货政策、插头/电压和是否为 AU 版本",
    "- 以零售商页面最终显示价格为准"
  ].join("\n");
}

function currentSearchLink() {
  const url = new URL(window.location.href);
  url.hash = "compare";
  return url.toString();
}

function bookmarkletHref() {
  const baseUrl = new URL("appliances/index.html", window.location.href);
  const code = `(function(){var q=window.getSelection().toString().trim()||prompt('输入要比价的型号');if(q){window.open('${baseUrl.origin}${baseUrl.pathname}?q='+encodeURIComponent(q)+'#compare','_blank');}})();`;
  return `javascript:${encodeURIComponent(code)}`;
}

function captureBookmarkletHref() {
  const captureUrl = new URL("/api/capture", window.location.origin);
  const code = `(function(){function pick(){var m=document.querySelector('meta[property="product:price:amount"],meta[itemprop="price"]');if(m&&m.content)return m.content;var nodes=[].slice.call(document.querySelectorAll('[class*="price" i],[data-testid*="price" i],[aria-label*="price" i]')).slice(0,80);var text=nodes.map(function(n){return n.getAttribute('aria-label')||n.textContent||'';}).join(' ');var match=text.replace(/,/g,'').match(/\\$\\s*([0-9]+(?:\\.[0-9]{1,2})?)/);return match?match[1]:prompt('没有自动识别到价格，请输入页面显示价格');}var payload={url:location.href,title:document.title,selectedText:String(getSelection()).trim(),price:pick()};fetch('${captureUrl.href}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}).then(function(r){return r.json();}).then(function(data){alert(data.capture&&data.capture.applied?'已采集价格：'+data.capture.productModel+' '+data.capture.retailer+' $'+data.capture.price:'已保存，但需要手动匹配商品');}).catch(function(err){alert('采集失败：请确认 Appliance Price Radar 服务正在运行。'+err.message);});})();`;
  return `javascript:${encodeURIComponent(code)}`;
}

function updateQuickLinks() {
  const link = document.getElementById("bookmarkletLink");
  const captureLink = document.getElementById("captureBookmarkletLink");
  if (link) link.href = bookmarkletHref();
  if (captureLink) captureLink.href = captureBookmarkletHref();
}

function syncUrlState() {
  const url = new URL(window.location.href);
  if (searchTerm) url.searchParams.set("q", searchTerm);
  else url.searchParams.delete("q");
  if (activeCategory !== "all") url.searchParams.set("category", activeCategory);
  else url.searchParams.delete("category");
  window.history.replaceState({}, "", url);
  updateQuickLinks();
}

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  searchTerm = (params.get("q") || "").trim();
  activeCategory = params.get("category") || "all";
  const input = document.getElementById("searchInput");
  if (input) input.value = searchTerm;
  document.querySelectorAll(".filter").forEach(button => {
    button.classList.toggle("is-active", button.dataset.category === activeCategory);
  });
}

function renderPostcodeStatus() {
  const input = document.getElementById("postcodeInput");
  const status = document.getElementById("postcodeStatus");
  const postcode = activePostcode || settings.defaultPostcode || "4000";
  if (input) input.value = postcode;
  if (status) status.textContent = `按 ${postcode} 估算配送和到手价`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${rest} 秒`;
  return `${minutes} 分 ${String(rest).padStart(2, "0")} 秒`;
}

function resetAutoRefreshCountdown() {
  autoRefreshRemaining = Math.max(60, Number(settings.autoRefreshSeconds || 900));
  renderAutoRefreshStatus();
}

function renderAutoRefreshStatus() {
  const status = document.getElementById("autoRefreshStatus");
  const button = document.getElementById("autoRefreshToggle");
  if (button) {
    button.classList.toggle("is-active", autoRefreshEnabled);
    button.textContent = autoRefreshEnabled ? "自动刷新开" : "自动刷新关";
  }
  if (status) {
    status.textContent = autoRefreshEnabled
      ? `自动刷新已开启，约 ${formatDuration(autoRefreshRemaining)} 后更新`
      : "自动刷新未开启，可手动点击刷新价格";
  }
}

function startAutoRefreshTimer() {
  stopAutoRefreshTimer();
  autoRefreshTimer = window.setInterval(async () => {
    if (!autoRefreshEnabled) return;
    autoRefreshRemaining -= 1;
    if (autoRefreshRemaining <= 0) {
      await refreshProducts();
      resetAutoRefreshCountdown();
    } else {
      renderAutoRefreshStatus();
    }
  }, 1000);
}

function stopAutoRefreshTimer() {
  if (autoRefreshTimer) window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

async function refreshProducts() {
  const button = document.getElementById("refreshPrices");
  if (button) {
    button.disabled = true;
    button.textContent = "刷新中...";
  }
  try {
    const response = await fetch("/api/refresh", { method: "POST", cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Refresh returned ${response.status}`);
    products = productsFromPayload(payload);
    await loadSupportData();
    resetAutoRefreshCountdown();
    setFeedStatus(feedQualityMessage(payload.refreshedAt, payload.validation, "刷新完成"), "Local API");
    renderProducts();
  } catch (error) {
    setFeedStatus(`刷新接口不可用：${error.message}。仍显示当前数据。`, feedMode);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "刷新价格";
    }
  }
}

async function refreshAdapters() {
  const button = document.getElementById("refreshAdapters");
  if (button) {
    button.disabled = true;
    button.textContent = "Adapter...";
  }
  try {
    const response = await fetch("/api/refresh-adapters", { method: "POST", cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Adapter refresh returned ${response.status}`);
    products = productsFromPayload(payload);
    await loadSupportData();
    const result = payload.adapterRefresh || {};
    setFeedStatus(`Adapter 刷新完成：${result.adapterCount || 0} 个 adapter，应用 ${result.appliedCount || 0} 行，错误 ${result.errorCount || 0} 行。`, "Retailer adapters");
    renderProducts();
  } catch (error) {
    setFeedStatus(`Adapter 刷新失败：${error.message}`, feedMode);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "刷新 Adapter";
    }
  }
}

async function addTrackedProduct(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("addProductStatus");
  const button = form.querySelector("button[type='submit']");
  if (button) {
    button.disabled = true;
    button.textContent = "新增中...";
  }
  try {
    const data = Object.fromEntries(new FormData(form).entries());
    const response = await fetch("/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data)
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Create returned ${response.status}`);
    products = productsFromPayload(payload);
    searchTerm = payload.created.model;
    document.getElementById("searchInput").value = searchTerm;
    syncUrlState();
    form.reset();
    if (status) status.textContent = `已新增：${payload.created.model}`;
    renderProducts();
  } catch (error) {
    if (status) status.textContent = `新增失败：${error.message}`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "新增追踪";
    }
  }
}

async function importMerchantFeed(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const status = document.getElementById("feedImportStatus");
  const button = form.querySelector("button[type='submit']");
  if (button) {
    button.disabled = true;
    button.textContent = "导入中...";
  }
  try {
    const csvPath = new FormData(form).get("csvPath");
    const response = await fetch("/api/import-feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ csvPath })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Import returned ${response.status}`);
    products = productsFromPayload(payload);
    await loadSupportData();
    const result = payload.importer || {};
    const message = `已导入 ${result.rowCount || 0} 行，自动匹配 ${result.appliedCount || 0} 行，待匹配 ${result.pendingCount || 0} 行，错误 ${result.errorCount || 0} 行。`;
    if (status) status.textContent = message;
    setFeedStatus(message, "Merchant feed");
    renderProducts();
  } catch (error) {
    if (status) status.textContent = `导入失败：${error.message}`;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "导入 Feed";
    }
  }
}

async function importMerchantFeedBatch(event) {
  const form = event.currentTarget.closest("form");
  const status = document.getElementById("feedImportStatus");
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "导入文件夹中...";
  try {
    const directoryPath = new FormData(form).get("directoryPath");
    const response = await fetch("/api/import-feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directoryPath })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Import returned ${response.status}`);
    products = productsFromPayload(payload);
    await loadSupportData();
    const result = payload.importer || {};
    const message = `已导入 ${result.feedCount || 0} 个 feed，共 ${result.rowCount || 0} 行；应用 ${result.appliedCount || 0} 行，待匹配 ${result.pendingCount || 0} 行。`;
    if (status) status.textContent = message;
    setFeedStatus(message, "Merchant feed batch");
    renderProducts();
  } catch (error) {
    if (status) status.textContent = `导入失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "导入文件夹";
  }
}

async function applyCaptureMatch(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "绑定中...";
  try {
    const response = await fetch("/api/captures/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        captureId: form.dataset.captureId,
        productId: new FormData(form).get("productId")
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Apply returned ${response.status}`);
    products = productsFromPayload(payload);
    await loadSupportData();
    setFeedStatus(`已绑定采集价格：${payload.capture.productModel} ${payload.capture.retailer} ${money(payload.capture.price)}`, "Local API");
    renderProducts();
  } catch (error) {
    button.textContent = `失败`;
    console.error(error);
  } finally {
    window.setTimeout(() => {
      button.disabled = false;
      button.textContent = "绑定价格";
    }, 900);
  }
}

async function updateTargetPrice(event) {
  event.preventDefault();
  const form = event.target.closest(".target-form");
  if (!form) return;
  const button = form.querySelector("button");
  button.disabled = true;
  button.textContent = "保存中...";
  try {
    const response = await fetch("/api/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productId: form.dataset.productId,
        targetPrice: new FormData(form).get("targetPrice"),
        note: "Updated from product card"
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Watchlist returned ${response.status}`);
    products = productsFromPayload(payload);
    setFeedStatus("目标价已更新，购买建议已重新计算。", "Local API");
    renderProducts();
  } catch (error) {
    button.textContent = "失败";
    console.error(error);
  } finally {
    window.setTimeout(() => {
      button.disabled = false;
      button.textContent = "保存";
    }, 900);
  }
}

function openAllRetailers(productId) {
  const productItem = products.find(item => item.id === productId);
  if (!productItem) return;
  (productItem.offers || []).forEach(offer => window.open(offerUrl(offer, productItem), "_blank", "noopener"));
  setFeedStatus(`已打开 ${productItem.model} 的四家商家页面。`, feedMode);
}

function openNeededRetailers(productId) {
  const productItem = products.find(item => item.id === productId);
  if (!productItem) return;
  const summary = liveCheckSummary(productItem);
  const offers = summary.needsCheck.length ? summary.needsCheck : [bestOffer(productItem)].filter(Boolean);
  offers.forEach(offer => window.open(offerUrl(offer, productItem), "_blank", "noopener"));
  setFeedStatus(`已打开 ${offers.length} 个需要复核的页面。`, feedMode);
}

async function copyChecklist(productId, button) {
  const productItem = products.find(item => item.id === productId);
  if (!productItem) return;
  const text = shoppingChecklist(productItem);
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "已复制";
  } catch {
    window.prompt("复制这份核对清单", text);
    button.textContent = "复制下单核对清单";
  }
  window.setTimeout(() => { button.textContent = "复制下单核对清单"; }, 1400);
}

function focusOpportunityProduct(productId) {
  const element = document.getElementById(`product-${productId}`);
  if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindControls() {
  document.querySelectorAll(".filter").forEach(button => {
    button.addEventListener("click", () => {
      activeCategory = button.dataset.category;
      document.querySelectorAll(".filter").forEach(item => item.classList.toggle("is-active", item === button));
      syncUrlState();
      renderProducts();
    });
  });

  document.getElementById("searchInput").addEventListener("input", event => {
    searchTerm = event.target.value.trim();
    syncUrlState();
    renderProducts();
  });

  document.getElementById("clearSearch").addEventListener("click", () => {
    searchTerm = "";
    document.getElementById("searchInput").value = "";
    syncUrlState();
    renderProducts();
  });

  document.getElementById("sortSavings").addEventListener("click", event => {
    sortBySavings = !sortBySavings;
    event.currentTarget.classList.toggle("is-active", sortBySavings);
    event.currentTarget.textContent = sortBySavings ? "恢复默认排序" : "按价差排序";
    renderProducts();
  });

  document.getElementById("refreshPrices").addEventListener("click", refreshProducts);
  document.getElementById("refreshAdapters").addEventListener("click", refreshAdapters);
  document.getElementById("addProductForm").addEventListener("submit", addTrackedProduct);
  document.getElementById("feedImportForm").addEventListener("submit", importMerchantFeed);
  document.getElementById("batchFeedImport").addEventListener("click", importMerchantFeedBatch);
  document.getElementById("postcodeForm").addEventListener("submit", event => {
    event.preventDefault();
    activePostcode = String(new FormData(event.currentTarget).get("postcode") || settings.defaultPostcode || "4000").trim();
    window.localStorage.setItem("appliancePostcode", activePostcode);
    renderPostcodeStatus();
    renderProducts();
  });
  document.getElementById("autoRefreshToggle").addEventListener("click", () => {
    autoRefreshEnabled = !autoRefreshEnabled;
    window.localStorage.setItem("applianceAutoRefresh", autoRefreshEnabled ? "1" : "0");
    if (autoRefreshEnabled) {
      resetAutoRefreshCountdown();
      startAutoRefreshTimer();
    } else {
      stopAutoRefreshTimer();
    }
    renderAutoRefreshStatus();
  });
  document.getElementById("productGrid").addEventListener("submit", updateTargetPrice);
  document.getElementById("productGrid").addEventListener("click", event => {
    const openAll = event.target.closest(".open-all-retailers");
    const openNeeded = event.target.closest(".open-needed-retailers");
    const copy = event.target.closest(".copy-checklist");
    if (openAll) openAllRetailers(openAll.dataset.productId);
    if (openNeeded) openNeededRetailers(openNeeded.dataset.productId);
    if (copy) copyChecklist(copy.dataset.productId, copy);
  });
  document.getElementById("opportunityPanel").addEventListener("click", event => {
    const card = event.target.closest(".opportunity-card");
    if (card) focusOpportunityProduct(card.dataset.productId);
  });
  document.getElementById("captureQueue").addEventListener("submit", applyCaptureMatch);
  document.getElementById("copySearchLink").addEventListener("click", async event => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(currentSearchLink());
      button.textContent = "已复制";
    } catch {
      window.prompt("复制这个链接", currentSearchLink());
      button.textContent = "复制搜索链接";
    }
    window.setTimeout(() => { button.textContent = "复制搜索链接"; }, 1400);
  });
}

async function init() {
  bindControls();
  applyUrlState();
  updateQuickLinks();
  products = await loadProducts();
  await loadSupportData();
  activePostcode = activePostcode || settings.defaultPostcode || "4000";
  renderPostcodeStatus();
  autoRefreshEnabled = window.localStorage.getItem("applianceAutoRefresh") === "1";
  resetAutoRefreshCountdown();
  if (autoRefreshEnabled) startAutoRefreshTimer();
  renderProducts();
}

init();
