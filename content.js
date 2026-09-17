const HOVER_DELAY_MS = 350;
const VISIBLE_BARS = 100;
const NEWS_REQUEST_CACHE_TTL_MS = 90 * 60 * 1000;
const TREND_REQUEST_CACHE_TTL_MS = 15 * 60 * 1000;
const KNOWN_LEVERAGED_SINGLE_STOCK_ETFS = new Set([
  "AAPD", "AAPU", "AMDD", "AMDL", "AMDS", "AMZU", "AMZD", "CONI", "CONL",
  "GGLL", "GGLS", "METD", "METU", "MSFD", "MSFU", "MSTU", "MSTZ", "NVDD",
  "NVDL", "NVDU", "PLTD", "PLTU", "PTID", "PTIR", "TSLL", "TSLQ"
]);
const popup = document.createElement("div");
popup.id = "tvhp-preview";
popup.hidden = true;
document.documentElement.appendChild(popup);

let hoverTimer;
let hideTimer;
let requestToken = 0;
let activeLink = null;
let activeTimeframe = "day";
let newsModalHost = null;
const tickerNewsRequests = new Map();
const tickerTrendRequests = new Map();
const seenTodayTickers = new Set();
const todayNewsFingerprints = new Map();
let savedTodayNews = {};

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "toggle-news-modal") toggleNewsModal();
});

document.addEventListener("mouseover", (event) => {
  const hoverTarget = findHoverTarget(event.target);
  if (!hoverTarget) return;
  if (hoverTarget === activeLink) return;

  activeLink = hoverTarget;
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hoverTimer = setTimeout(() => showPreview(hoverTarget), HOVER_DELAY_MS);
});

document.addEventListener("mouseout", (event) => {
  if (!activeLink) return;
  if (activeLink.contains(event.relatedTarget)) return;
  if (popup.contains(event.relatedTarget)) return;
  clearTimeout(hoverTimer);
  scheduleHide();
});

popup.addEventListener("mouseenter", () => clearTimeout(hideTimer));
popup.addEventListener("mouseleave", (event) => {
  if (activeLink?.contains(event.relatedTarget)) return;
  scheduleHide();
});

popup.addEventListener("click", (event) => {
  const button = event.target.closest?.("button[data-timeframe]");
  if (!button || !activeLink || button.dataset.timeframe === activeTimeframe) return;
  activeTimeframe = button.dataset.timeframe;
  showPreview(activeLink, activeTimeframe);
});

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    activeLink = null;
    requestToken += 1;
    popup.hidden = true;
  }, 180);
}

async function showPreview(link, timeframe = activeTimeframe) {
  const identity = parseSymbol(link);
  if (!identity) return;

  const token = ++requestToken;
  positionPopup(link.getBoundingClientRect());
  popup.hidden = false;
  popup.innerHTML = `${renderHeader(identity.label, timeframe)}<div class="tvhp-loading">Loading…</div>`;

  let response;
  try {
    response = await sendChartRequest({
      type: "load-chart",
      symbol: identity.yahoo,
      timeframe
    });
  } catch (error) {
    if (token !== requestToken || link !== activeLink) return;
    const message = isInvalidExtensionContext(error)
      ? "Extension updated. Refresh the TradingView page."
      : error?.message || "Unable to contact the extension";
    popup.innerHTML = `${renderHeader(identity.label, timeframe)}<div class="tvhp-error">${escapeHtml(message)}</div>`;
    return;
  }
  if (token !== requestToken || link !== activeLink) return;

  if (!response?.ok) {
    popup.innerHTML = `${renderHeader(identity.label, timeframe)}<div class="tvhp-error">${escapeHtml(response?.error || "Unable to load chart")}</div>`;
    return;
  }

  popup.innerHTML = renderChart(identity.label, response.bars, timeframe);
}

async function sendChartRequest(message) {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("Extension context unavailable");
  }

  let timeout;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Chart request timed out; hover again to retry")), 15000);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function isInvalidExtensionContext(error) {
  const message = error?.message || "";
  return message.includes("Extension context invalidated")
    || message.includes("Extension context unavailable")
    || message.includes("Cannot read properties of undefined");
}

function findHoverTarget(element) {
  if (location.hostname === "seekingalpha.com" && location.pathname.startsWith("/screeners/")) {
    const tickerLink = element.closest?.('[data-test-id="top-rated-ticker-link"][href*="/symbol/"]');
    return tickerLink && parseSymbol(tickerLink) ? tickerLink : null;
  }

  // Keep the hover chart exclusive to Pine Screener. The content script still
  // runs on chart pages so the toolbar-triggered watchlist news modal works.
  if (!location.pathname.startsWith("/pine-screener")) return null;

  const symbolRow = element.closest?.("[data-symbol-full]");
  if (symbolRow && parseSymbol(symbolRow)) return symbolRow;

  const symbolLink = element.closest?.('a[href*="/symbols/"]');
  return symbolLink && parseSymbol(symbolLink) ? symbolLink : null;
}

function parseSymbol(element) {
  const fullSymbol = element.getAttribute?.("data-symbol-full");
  const attributeMatch = fullSymbol?.match(/^([A-Z0-9_]+):([A-Z0-9.\-]+)$/i);
  if (attributeMatch) return symbolIdentity(attributeMatch[1], attributeMatch[2]);

  if (!element.href) return null;
  const url = new URL(element.href, location.href);
  if (url.hostname === "seekingalpha.com") {
    const seekingAlphaMatch = url.pathname.match(/^\/symbol\/([A-Z0-9.\-]+)\/?$/i);
    if (!seekingAlphaMatch) return null;
    const ticker = seekingAlphaMatch[1].toUpperCase();
    return { label: ticker, yahoo: ticker.replaceAll(".", "-") };
  }

  const match = url.pathname.match(/\/symbols\/([A-Z0-9_]+)-([A-Z0-9.\-]+)\/?/i);
  if (!match) return null;
  return symbolIdentity(match[1], match[2]);
}

function symbolIdentity(rawExchange, rawTicker) {
  const exchange = rawExchange.toUpperCase();
  const ticker = rawTicker.toUpperCase();
  return { label: `${exchange}:${ticker}`, yahoo: toYahooSymbol(exchange, ticker) };
}

function toYahooSymbol(exchange, ticker) {
  const normalized = ticker.replaceAll(".", "-");
  const exchangeSuffixes = {
    TSX: ".TO",
    TSXV: ".V",
    LSE: ".L",
    ASX: ".AX",
    HKEX: ".HK",
    TSE: ".T",
    NSE: ".NS"
  };
  return `${normalized}${exchangeSuffixes[exchange] || ""}`;
}

function positionPopup(rect) {
  const width = 520;
  const height = 330;
  let left = rect.right + 12;
  if (left + width > innerWidth - 8) left = rect.left - width - 12;
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(rect.top - 40, innerHeight - height - 8));
  Object.assign(popup.style, { left: `${left}px`, top: `${top}px` });
}

function ema(values, period) {
  const output = new Array(values.length).fill(null);
  if (values.length < period) return output;
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  output[period - 1] = value;
  const multiplier = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * multiplier + value * (1 - multiplier);
    output[i] = value;
  }
  return output;
}

function renderChart(label, allBars, timeframe) {
  const closes = allBars.map((bar) => bar.close);
  const series = [
    { period: 9, color: "#16c784", dash: "" },
    { period: 20, color: "#f23645", dash: "" },
    { period: 50, color: "#16c784", dash: "3 5" },
    { period: 200, color: "#f23645", dash: "3 5" }
  ]
    .filter((item) => closes.length >= item.period)
    .map((item) => ({ ...item, values: ema(closes, item.period) }));
  const start = Math.max(0, allBars.length - VISIBLE_BARS);
  const bars = allBars.slice(start);
  const plottedValues = bars.flatMap((bar) => [bar.low, bar.high]);
  for (const item of series) {
    for (const value of item.values.slice(start)) if (Number.isFinite(value)) plottedValues.push(value);
  }

  let min = Math.min(...plottedValues);
  let max = Math.max(...plottedValues);
  const padding = Math.max((max - min) * 0.06, max * 0.002);
  min -= padding;
  max += padding;

  const width = 496;
  const height = 280;
  const left = 8;
  const right = 50;
  const top = 8;
  const bottom = 28;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = (index) => left + ((index + 0.5) / bars.length) * plotWidth;
  const y = (value) => top + ((max - value) / (max - min)) * plotHeight;
  const candleWidth = Math.max(1, Math.min(5, plotWidth / bars.length * 0.64));

  const grid = Array.from({ length: 5 }, (_, i) => {
    const value = max - ((max - min) * i) / 4;
    const py = y(value);
    return `<line x1="${left}" y1="${py}" x2="${width - right}" y2="${py}" stroke="#24262d"/><text x="${width - right + 5}" y="${py + 4}" fill="#787b86">${formatPrice(value)}</text>`;
  }).join("");

  const dateLabels = renderDateAxis(bars, timeframe, x, height, left, width - right);

  const candles = bars.map((bar, index) => {
    const color = bar.close >= bar.open ? "#16c784" : "#f23645";
    const px = x(index);
    const bodyTop = y(Math.max(bar.open, bar.close));
    const bodyHeight = Math.max(1, Math.abs(y(bar.open) - y(bar.close)));
    return `<line x1="${px}" y1="${y(bar.high)}" x2="${px}" y2="${y(bar.low)}" stroke="${color}"/><rect x="${px - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}"/>`;
  }).join("");

  const lines = series.map((item) => {
    let path = "";
    item.values.slice(start).forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      path += `${path ? " L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    });
    return `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="1.5" stroke-dasharray="${item.dash}"/>`;
  }).join("");

  const latest = bars.at(-1);
  const change = ((latest.close / bars.at(-2).close) - 1) * 100;
  const intervalLabel = timeframe === "week" ? "Weekly" : "Daily";
  return `${renderHeader(label, timeframe, latest, change)}<svg viewBox="0 0 ${width} ${height}" aria-label="${intervalLabel} candlestick preview"><g>${grid}${candles}${lines}${dateLabels}</g></svg>`;
}

function renderHeader(label, timeframe, latest, change) {
  const price = latest
    ? `<span>${formatPrice(latest.close)} <span class="tvhp-muted">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span></span>`
    : "";
  return `<div class="tvhp-header"><span>${escapeHtml(label)}</span><div class="tvhp-tabs" role="tablist" aria-label="Chart timeframe"><button type="button" role="tab" data-timeframe="day" aria-selected="${timeframe === "day"}">Day</button><button type="button" role="tab" data-timeframe="week" aria-selected="${timeframe === "week"}">Week</button></div>${price}</div>`;
}

function formatPrice(value) {
  if (value >= 1000) return value.toFixed(0);
  if (value >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function renderDateAxis(bars, timeframe, x, height, plotLeft, plotRight) {
  const markers = [];
  let previousMonth = null;

  bars.forEach((bar, index) => {
    const date = new Date(bar.time * 1000);
    const month = date.getUTCMonth();
    const monthKey = `${date.getUTCFullYear()}-${month}`;
    if (monthKey === previousMonth) return;
    previousMonth = monthKey;

    // Daily charts mark every month. Weekly charts mirror TradingView's
    // roomier Jan/Mar/May/Jul/Sep/Nov cadence.
    if (timeframe === "week" && month % 2 !== 0) return;
    markers.push({ index, date });
  });

  return markers.map(({ index, date }) => {
    const px = x(index);
    const label = date.getUTCMonth() === 0
      ? String(date.getUTCFullYear())
      : date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const anchor = px < plotLeft + 24 ? "start" : px > plotRight - 24 ? "end" : "middle";
    return `<line x1="${px}" y1="${height - 24}" x2="${px}" y2="${height - 20}" stroke="#363a45"/><text x="${px}" y="${height - 5}" text-anchor="${anchor}" fill="#787b86">${label}</text>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

async function toggleNewsModal() {
  if (newsModalHost) {
    closeNewsModal();
    return;
  }

  newsModalHost = document.createElement("div");
  todayNewsFingerprints.clear();
  newsModalHost.id = "tvhp-news-host";
  document.documentElement.appendChild(newsModalHost);
  const shadow = newsModalHost.attachShadow({ mode: "open" });
  shadow.innerHTML = `${newsModalStyles()}<div class="backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="news-title"><header><h1 id="news-title">Watchlist news</h1><button class="close" type="button" aria-label="Close">×</button></header><main><div class="loading">Reading watchlist…</div></main></section></div>`;
  shadow.querySelector(".close").addEventListener("click", closeNewsModal);
  shadow.querySelector(".backdrop").addEventListener("click", (event) => {
    if (event.target.classList.contains("backdrop")) closeNewsModal();
  });
  const modal = shadow.querySelector(".modal");
  for (const eventName of ["keydown", "keyup", "keypress", "paste", "copy", "cut", "beforeinput", "input"]) {
    modal.addEventListener(eventName, (event) => {
      event.stopPropagation();
      if (eventName === "keydown" && event.key === "Escape") closeNewsModal();
    });
  }
  document.addEventListener("keydown", handleNewsEscape);
  shadow.querySelector(".close").focus();
  await loadSavedTodayNews();
  await loadNewsModal(shadow);
}

function closeNewsModal() {
  document.removeEventListener("keydown", handleNewsEscape);
  newsModalHost?.remove();
  newsModalHost = null;
}

function handleNewsEscape(event) {
  if (event.key === "Escape") closeNewsModal();
}

async function loadNewsModal(shadow) {
  const main = shadow.querySelector("main");
  const watchlist = await extractActiveWatchlist();
  if (!watchlist.items.length) {
    main.innerHTML = `<div class="empty"><strong>No active watchlist found.</strong><span>Open the Watchlist panel on TradingView, then click the extension again.</span></div>`;
    return;
  }

  const included = watchlist.items.filter((item) => !item.excludedReason);
  renderNewsResults(main, included);
}

function renderNewsResults(main, included) {
  const articles = [];
  const sections = new Map();
  for (const item of included) {
    if (!sections.has(item.sector)) sections.set(item.sector, []);
    sections.get(item.sector).push(item);
  }
  const sectionEntries = [...sections];
  const sectionButtons = sectionEntries.map(([sector, items], index) => `<button type="button" class="sector-select${index === 0 ? " selected" : ""}" data-section-index="${index}" aria-pressed="${index === 0}">${escapeHtml(sector)}<span>${items.length}</span></button>`).join("");
  const sectionHtml = sectionEntries.map(([sector, items], sectionIndex) => {
    const tickerButtons = items.map((item, index) => {
      const priceSymbol = toYahooSymbol(item.exchange, item.symbol);
      return `<button type="button" class="ticker-select${index === 0 ? " selected" : ""}" data-symbol="${escapeHtml(item.symbol)}" data-price-symbol="${escapeHtml(priceSymbol)}" aria-pressed="${index === 0}">${escapeHtml(item.symbol)}<span class="news-count">…</span><span class="ticker-trend pending">…</span></button>`;
    }).join("");
    const firstSymbol = items[0]?.symbol || "";
    return `<section class="sector-panel" data-section-panel="${sectionIndex}"${sectionIndex === 0 ? "" : " hidden"}><div class="ticker-row" role="group" aria-label="${escapeHtml(sector)} tickers">${tickerButtons}</div><div class="ticker-news">${renderTickerNews(firstSymbol, articles)}</div></section>`;
  }).join("");
  main.innerHTML = `<nav class="sector-row" aria-label="Watchlist sections">${sectionButtons}</nav>${sectionHtml}`;
  main.addEventListener("click", (event) => {
    const sectorButton = event.target.closest?.("button.sector-select");
    if (sectorButton) {
      for (const sibling of main.querySelectorAll("button.sector-select")) {
        const selected = sibling === sectorButton;
        sibling.classList.toggle("selected", selected);
        sibling.setAttribute("aria-pressed", String(selected));
      }
      for (const panel of main.querySelectorAll(".sector-panel")) {
        panel.hidden = panel.dataset.sectionPanel !== sectorButton.dataset.sectionIndex;
        if (!panel.hidden) panel.querySelector(".ticker-news").scrollTop = 0;
      }
      return;
    }
    const button = event.target.closest?.("button.ticker-select");
    if (!button) return;
    markTodayNewsSeen(button);
    const section = button.closest(".sector-panel");
    for (const sibling of section.querySelectorAll("button.ticker-select")) {
      const selected = sibling === button;
      sibling.classList.toggle("selected", selected);
      sibling.setAttribute("aria-pressed", String(selected));
    }
    section.querySelector(".ticker-news").innerHTML = renderTickerNews(button.dataset.symbol, articles);
    loadTickerNews(section, button.dataset.symbol);
  });
  preloadTickerCounts(main);
}

async function loadTickerNews(section, symbol) {
  const container = section.querySelector(".ticker-news");
  container.insertAdjacentHTML("beforeend", '<div class="rss-status">Loading news…</div>');
  const response = await requestTickerNews(symbol);
  if (section.querySelector("button.ticker-select.selected")?.dataset.symbol !== symbol) return;
  renderTickerResponse(section, symbol, response);
}

function requestTickerNews(symbol) {
  const cached = tickerNewsRequests.get(symbol);
  if (cached && Date.now() - cached.savedAt < NEWS_REQUEST_CACHE_TTL_MS) return cached.request;
  const request = sendExtensionRequest({ type: "load-ticker-rss-news", symbol }, 20000)
    .catch((error) => ({ ok: false, error: error.message }));
  tickerNewsRequests.set(symbol, { savedAt: Date.now(), request });
  return request;
}

function requestTickerTrend(symbol) {
  const cached = tickerTrendRequests.get(symbol);
  if (cached && Date.now() - cached.savedAt < TREND_REQUEST_CACHE_TTL_MS) return cached.request;
  const request = sendExtensionRequest({ type: "load-ticker-trend", symbol }, 20000)
    .catch((error) => ({ ok: false, error: error.message }));
  tickerTrendRequests.set(symbol, { savedAt: Date.now(), request });
  return request;
}

async function preloadTickerCounts(main) {
  const buttons = [...main.querySelectorAll("button.ticker-select")]
    .sort((a, b) => Number(b.classList.contains("selected")) - Number(a.classList.contains("selected")));
  let next = 0;
  const worker = async () => {
    while (next < buttons.length) {
      const button = buttons[next++];
      const [response, trend] = await Promise.all([
        requestTickerNews(button.dataset.symbol),
        requestTickerTrend(button.dataset.priceSymbol)
      ]);
      button.querySelector(".news-count").textContent = response?.ok ? String((response.articles || []).length) : "?";
      updateTodayNewsIndicator(button, response?.ok ? response.articles || [] : []);
      renderTickerTrend(button.querySelector(".ticker-trend"), trend);
      const section = button.closest(".sector-panel");
      if (button.classList.contains("selected")) renderTickerResponse(section, button.dataset.symbol, response);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, buttons.length) }, worker));
}

function updateTodayNewsIndicator(button, articles) {
  const symbol = button.dataset.symbol;
  const todayArticles = articles.filter((article) => isToday(article.publishedAt));
  const fingerprint = fingerprintTodayNews(todayArticles);
  if (fingerprint) todayNewsFingerprints.set(symbol, fingerprint);
  const saved = savedTodayNews[symbol];
  const alreadyRead = saved?.date === localDateKey() && saved?.fingerprint === fingerprint;
  const show = Boolean(fingerprint) && !alreadyRead && !seenTodayTickers.has(symbol);
  button.classList.toggle("has-today-news", show);
  if (show) button.title = "New story published today";
  else button.removeAttribute("title");
  if (fingerprint && seenTodayTickers.has(symbol) && !alreadyRead) saveTodayNewsSeen(symbol, fingerprint);
}

function markTodayNewsSeen(button) {
  const symbol = button.dataset.symbol;
  seenTodayTickers.add(symbol);
  button.classList.remove("has-today-news");
  button.removeAttribute("title");
  const fingerprint = todayNewsFingerprints.get(symbol);
  if (fingerprint) saveTodayNewsSeen(symbol, fingerprint);
}

async function loadSavedTodayNews() {
  try {
    const stored = await chrome.storage.local.get("todayNewsSeenV1");
    const today = localDateKey();
    savedTodayNews = Object.fromEntries(Object.entries(stored.todayNewsSeenV1 || {}).filter(([, value]) => value?.date === today));
    await chrome.storage.local.set({ todayNewsSeenV1: savedTodayNews });
  } catch (_error) {
    savedTodayNews = {};
  }
}

function saveTodayNewsSeen(symbol, fingerprint) {
  savedTodayNews[symbol] = { date: localDateKey(), fingerprint };
  chrome.storage.local.set({ todayNewsSeenV1: savedTodayNews }).catch(() => {});
}

function fingerprintTodayNews(articles) {
  if (!articles.length) return "";
  const input = articles.map((article) => `${article.id || ""}|${article.url || ""}|${article.title || ""}`).sort().join("\n");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function isToday(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function renderTickerTrend(element, response) {
  const change = Number(response?.changePercent);
  if (!response?.ok || !Number.isFinite(change)) {
    element.className = "ticker-trend unavailable";
    element.textContent = "—";
    return;
  }
  const direction = change > 0.005 ? "up" : change < -0.005 ? "down" : "flat";
  element.className = `ticker-trend ${direction}`;
  element.textContent = `${direction === "up" ? "▲" : direction === "down" ? "▼" : "→"} ${Math.abs(change).toFixed(1)}%`;
  element.title = "Change from the previous trading session";
}

function renderTickerResponse(section, symbol, response) {
  const container = section.querySelector(".ticker-news");
  const rssArticles = response?.ok ? response.articles || [] : [];
  const status = response?.ok ? "" : "Unable to load news.";
  const button = section.querySelector("button.ticker-select.selected .news-count");
  if (button) button.textContent = response?.ok ? String(rssArticles.length) : "?";
  container.innerHTML = renderTickerNews(symbol, rssArticles, status);
}

function renderTickerNews(symbol, articles, status = "") {
  const tickerArticles = getTickerArticles(symbol, articles);
  const stories = tickerArticles.map(renderNewsCard).join("");
  return `<div class="ticker-news-heading"><strong>${escapeHtml(symbol)}</strong><span>${tickerArticles.length} ${tickerArticles.length === 1 ? "story" : "stories"}</span></div>${status ? `<div class="rss-status">${escapeHtml(status)}</div>` : ""}${stories || '<div class="no-news">No news found.</div>'}`;
}

function getTickerArticles(symbol, articles) {
  let lowPriorityCount = 0;
  return articles.filter((article) => {
    if (!article.tickers.includes(symbol)) return false;
    if (!/zacks|motley fool/i.test(article.publisher)) return true;
    lowPriorityCount += 1;
    return lowPriorityCount <= 2;
  });
}

function renderNewsCard(article) {
  return `<article><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.title)}</a><div class="source">${escapeHtml(article.publisher)} · ${escapeHtml(formatNewsTime(article.publishedAt))}</div></article>`;
}

async function extractActiveWatchlist() {
  const selectors = ['[data-name*="watchlist" i]', '[aria-label*="watchlist" i]', '[class*="watchlist" i]'];
  const candidates = [...document.querySelectorAll(selectors.join(","))]
    .filter((element) => element.getBoundingClientRect().width > 120 && element.getBoundingClientRect().height > 120);
  const container = candidates
    .map((element) => ({ element, count: collectSymbolElements(element).length }))
    .sort((a, b) => b.count - a.count)[0]?.element;
  if (!container) return { items: [] };

  const scrollContainer = [...container.querySelectorAll("*")]
    .filter((element) => element.scrollHeight > element.clientHeight + 100 && element.clientHeight > 150)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!scrollContainer) return { items: collectVisibleWatchlistItems(container) };

  const originalTop = scrollContainer.scrollTop;
  const itemsByKey = new Map();
  const step = Math.max(200, Math.floor(scrollContainer.clientHeight * 0.8));
  try {
    for (let top = 0; top <= scrollContainer.scrollHeight; top += step) {
      scrollContainer.scrollTop = Math.min(top, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      await waitForWatchlistRender();
      for (const item of collectVisibleWatchlistItems(container)) {
        const existing = itemsByKey.get(item.key);
        if (!existing || existing.sector === "Uncategorized") itemsByKey.set(item.key, item);
      }
      if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 2) break;
    }
  } finally {
    scrollContainer.scrollTop = originalTop;
  }
  return { items: [...itemsByKey.values()] };
}

function collectVisibleWatchlistItems(container) {
  const items = [];
  const seen = new Set();
  let sector = "Uncategorized";
  for (const element of container.querySelectorAll("*")) {
    const sectionName = readSectionName(element);
    if (sectionName) sector = sectionName;
    const identity = parseWatchlistElement(element);
    if (!identity || seen.has(identity.key)) continue;
    seen.add(identity.key);
    const context = element.closest('[role="row"], [data-role="list-item"], [class*="symbolRow" i], li, tr') || element;
    const descriptiveText = `${context.textContent || ""} ${context.getAttribute("aria-label") || ""} ${context.getAttribute("title") || ""} ${element.getAttribute("data-tooltip") || ""}`;
    const excludedReason = isLeveragedSingleStockEtf(identity.symbol, descriptiveText)
      ? "Leveraged/inverse single-stock ETF"
      : "";
    items.push({ ...identity, sector, excludedReason });
  }
  return items;
}

function waitForWatchlistRender() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function collectSymbolElements(container) {
  return [...container.querySelectorAll('[data-symbol-full], [data-symbol], a[href*="/symbols/"]')].filter(parseWatchlistElement);
}

function parseWatchlistElement(element) {
  let full = element.getAttribute("data-symbol-full") || element.getAttribute("data-symbol") || "";
  if (!full && element.matches('a[href*="/symbols/"]')) {
    const match = new URL(element.href).pathname.match(/\/symbols\/([A-Z0-9_]+)-([A-Z0-9.\-]+)\/?/i);
    if (match) full = `${match[1]}:${match[2]}`;
  }
  const match = String(full).toUpperCase().match(/^(?:([A-Z0-9_]+):)?([A-Z0-9.\-]+)$/);
  if (!match) return null;
  const exchange = match[1] || "";
  const rawTicker = match[2];
  if (!/^[A-Z][A-Z0-9.\-]{0,14}$/.test(rawTicker)) return null;
  return { key: `${exchange}:${rawTicker}`, exchange, symbol: rawTicker.replaceAll(".", "-"), label: exchange ? `${exchange}:${rawTicker}` : rawTicker };
}

function readSectionName(element) {
  if (!element.matches('[data-role*="section" i], [data-name*="section" i], [class*="sectionTitle" i], [class*="sectionHeader" i], [class*="separator" i], [role="heading"]')) return "";
  if (element.querySelector('[data-symbol-full], [data-symbol], a[href*="/symbols/"]')) return "";
  const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
  return text && text.length <= 60 ? text : "";
}

function isLeveragedSingleStockEtf(symbol, text) {
  if (KNOWN_LEVERAGED_SINGLE_STOCK_ETFS.has(symbol)) return true;
  const normalized = String(text).toUpperCase();
  const leveraged = /\b(?:2X|3X|BULL|BEAR|INVERSE|ULTRA|DAILY TARGET|LEVERAGED)\b/.test(normalized);
  const fundLike = /\b(?:ETF|ETN|FUND|SHARES)\b/.test(normalized);
  const singleStock = /\b(?:SINGLE[ -]STOCK|DAILY (?:LONG|SHORT)|BULL \dX|BEAR \dX)\b/.test(normalized);
  return leveraged && (fundLike || singleStock);
}

async function sendExtensionRequest(message, timeoutMs = 15000) {
  let timeout;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Extension request timed out")), timeoutMs); })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function formatNewsTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function newsModalStyles() {
  return `<style>
    :host { all: initial; } * { box-sizing: border-box; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 8px; background: rgba(0,0,0,.64); font: 14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #d1d4dc; }
    .modal { width:min(1320px,90vw); height:96vh; display:flex; flex-direction:column; overflow:hidden; border:1px solid #363a45; border-radius:14px; background:#101114; box-shadow:0 24px 80px rgba(0,0,0,.7); }
    header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid #24262d; } h1,h2,p { margin:0; } h1 { font-size:20px; color:#f0f3fa; }
    .close { width:34px; height:34px; padding:0; border:0; border-radius:7px; background:transparent; color:#b2b5be; font-size:27px; line-height:28px; cursor:pointer; } .close:hover { background:#1e222d; color:#fff; }
    main { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden; padding:12px 16px 16px; } .loading,.empty { min-height:280px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px; color:#9598a1; text-align:center; } .empty strong { color:#d1d4dc; font-size:16px; }
    button { padding:9px 13px; border:0; border-radius:6px; background:#2962ff; color:#fff; font:inherit; font-weight:600; cursor:pointer; }
    .sector-row { flex:none; display:flex; flex-wrap:wrap; gap:7px; padding:0 0 11px; border-bottom:1px solid #2a2e39; } .sector-select { display:flex; align-items:center; gap:6px; padding:7px 10px; border:1px solid #363a45; border-radius:16px; background:#191b20; color:#b2b5be; font-size:12px; } .sector-select span { color:#787b86; font-size:10px; } .sector-select:hover { border-color:#5d606b; background:#20232a; } .sector-select.selected { border-color:#2962ff; background:#1d3266; color:#fff; } .sector-select.selected span { color:#b8c9ff; }
    .sector-panel { flex:1; min-height:0; display:flex; flex-direction:column; } .sector-panel[hidden] { display:none; }
    .ticker-row { flex:none; display:flex; flex-wrap:wrap; gap:7px; padding:11px 2px 12px; border-bottom:1px solid #24262d; background:#101114; } .ticker-select { position:relative; display:flex; gap:6px; align-items:center; padding:6px 9px; border:1px solid #363a45; background:#191b20; color:#b2b5be; font-size:12px; } .ticker-select.has-today-news::before { content:""; position:absolute; top:-3px; right:-3px; width:8px; height:8px; border:2px solid #101114; border-radius:50%; background:#f6c344; box-shadow:0 0 7px rgba(246,195,68,.8); } .ticker-select span { color:#787b86; font-size:10px; } .ticker-select:hover { border-color:#5d606b; background:#20232a; } .ticker-select.selected { border-color:#2962ff; background:#1d3266; color:#fff; } .ticker-select.selected .news-count { color:#b8c9ff; } .ticker-trend.up,.ticker-select.selected .ticker-trend.up { color:#16c784; } .ticker-trend.down,.ticker-select.selected .ticker-trend.down { color:#f23645; } .ticker-trend.flat,.ticker-select.selected .ticker-trend.flat { color:#b2b5be; } .ticker-trend.pending,.ticker-trend.unavailable { color:#787b86; }
    .ticker-news { flex:1; min-height:0; overflow:auto; padding:16px 3px 4px; } .ticker-news-heading { display:flex; justify-content:space-between; align-items:baseline; padding:0 2px 8px; border-bottom:1px solid #20232a; } .ticker-news-heading strong { color:#8fb1ff; font-size:21px; font-weight:800; letter-spacing:.025em; } .ticker-news-heading span,.rss-status { color:#787b86; font-size:12px; } .rss-status { padding:7px 2px; }
    article { padding:14px 15px; margin:8px 0; border:1px solid #2a2e39; border-radius:9px; background:#15171c; } article>a { display:block; margin:7px 0 6px; color:#dbe5ff; font-size:15px; font-weight:650; line-height:1.35; text-decoration:none; } article>a:hover { color:#7da0ff; }
    .source { margin-top:8px; color:#787b86; font-size:11px; } .no-news { padding:18px 14px; color:#787b86; border:1px dashed #2a2e39; border-radius:8px; }
  </style>`;
}
