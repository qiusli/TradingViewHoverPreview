const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_RECOVERY_LIMIT = 20;
const memoryCache = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "load-chart" || !message.symbol) return;

  loadChart(message.symbol, message.timeframe)
    .then((bars) => sendResponse({ ok: true, bars }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function loadChart(symbol, requestedTimeframe) {
  const timeframe = requestedTimeframe === "week" ? "week" : "day";
  const cacheKey = `${symbol}:${timeframe}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.bars;

  const storageKey = `chart:${cacheKey}`;
  const stored = (await chrome.storage.local.get(storageKey))[storageKey];
  if (stored && Date.now() - stored.savedAt < CACHE_TTL_MS) {
    memoryCache.set(cacheKey, stored);
    return stored.bars;
  }

  const payload = await fetchChartPayload(symbol, timeframe);
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!result?.timestamp || !quote) throw new Error(`No ${timeframe} price history found`);

  const bars = result.timestamp.flatMap((time, index) => {
    const open = quote.open?.[index];
    const high = quote.high?.[index];
    const low = quote.low?.[index];
    const close = quote.close?.[index];
    if (![open, high, low, close].every(Number.isFinite)) return [];

    const adjustedClose = adjusted?.[index];
    const factor = Number.isFinite(adjustedClose) && close !== 0 ? adjustedClose / close : 1;
    return [{
      time,
      open: open * factor,
      high: high * factor,
      low: low * factor,
      close: close * factor
    }];
  });

  if (bars.length < 2) throw new Error("Not enough price history to draw chart");
  const cacheEntry = { savedAt: Date.now(), bars };
  memoryCache.set(cacheKey, cacheEntry);
  // Return fresh data immediately; disk-cache maintenance should not delay the chart.
  persistCache(storageKey, cacheEntry);
  return bars;
}

async function persistCache(storageKey, cacheEntry) {
  try {
    await chrome.storage.local.set({ [storageKey]: cacheEntry });
  } catch (_error) {
    // A full disk cache must never prevent freshly fetched data from rendering.
    try {
      const stored = await chrome.storage.local.get(null);
      const now = Date.now();
      const entries = Object.entries(stored)
        .filter(([key]) => key.startsWith("chart:") && key !== storageKey)
        .sort(([, a], [, b]) => (b?.savedAt || 0) - (a?.savedAt || 0));
      const keysToRemove = entries
        .filter(([, value], index) => now - (value?.savedAt || 0) >= CACHE_TTL_MS || index >= CACHE_RECOVERY_LIMIT - 1)
        .map(([key]) => key);

      if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
      await chrome.storage.local.set({ [storageKey]: cacheEntry });
    } catch (_cacheRecoveryError) {
      // Memory caching still works for the current service-worker session.
    }
  }
}

async function fetchChartPayload(symbol, timeframe) {
  const encoded = encodeURIComponent(symbol);
  const { range, interval } = timeframe === "week"
    ? { range: "10y", interval: "1wk" }
    : { range: "2y", interval: "1d" };
  let lastStatus = "unavailable";

  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    const url = `https://${host}/v8/finance/chart/${encoded}?range=${range}&interval=${interval}&events=div%2Csplits`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
      lastStatus = response.status;
      if (!response.ok) continue;

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) continue;
      return response.json();
    } catch (error) {
      lastStatus = error?.name === "TimeoutError" ? "timed out" : "network error";
    }
  }

  throw new Error(`Price data is temporarily unavailable (${lastStatus}); try again shortly`);
}
