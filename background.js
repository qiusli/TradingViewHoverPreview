const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_RECOVERY_LIMIT = 20;
const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
const memoryCache = new Map();

// Remove the obsolete credential now that news uses public RSS feeds only.
chrome.storage.local.remove("massiveApiKey").catch(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url?.startsWith("https://www.tradingview.com/")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-news-modal" });
  } catch (_error) {
    // A TradingView tab opened before an extension update needs one refresh.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "load-ticker-rss-news") {
    loadTickerRssNews(message.symbol)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "load-ticker-trend") {
    loadTickerTrend(message.symbol)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type !== "load-chart" || !message.symbol) return;

  loadChart(message.symbol, message.timeframe)
    .then((bars) => sendResponse({ ok: true, bars }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function loadTickerRssNews(rawSymbol) {
  const symbol = normalizeNewsSymbol(rawSymbol);
  if (!symbol) throw new Error("Invalid ticker");
  const cacheKey = `rss:v10:${symbol}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < NEWS_CACHE_TTL_MS) return cached.value;

  const aliases = await fetchCompanyAliases(symbol);
  const companyQuery = aliases[0] ? `"${aliases[0]}" OR "$${symbol}" OR "${symbol} stock"` : `"$${symbol}" OR "${symbol} stock"`;
  const query = `(${companyQuery}) (site:marketwatch.com OR site:finance.yahoo.com OR site:cnbc.com OR site:bloomberg.com OR site:reuters.com OR site:apnews.com OR site:businesswire.com OR site:globenewswire.com OR site:prnewswire.com OR site:benzinga.com) -site:finance.yahoo.com/quote -site:finance.yahoo.com/research/reports -site:marketwatch.com/investing/stock -site:cnbc.com/video when:7d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const articles = (await fetchRssFeed(url))
    .filter((article) => isLikelyEnglish(article) && isWithinPastWeek(article.publishedAt) && isRelevantRssArticle(article, symbol, aliases))
    .map((article) => ({ ...article, tickers: [symbol], score: 0, reason: "Company news" }));
  const seen = new Set();
  const unique = articles.filter((article) => {
    const key = article.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const value = { articles: unique, fetchedAt: Date.now() };
  memoryCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

async function fetchCompanyAliases(symbol) {
  const cacheKey = `company:${symbol}`;
  const cached = memoryCache.get(cacheKey);
  if (cached) return cached;
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=8&newsCount=0`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const match = (payload.quotes || []).find((quote) => normalizeNewsSymbol(quote.symbol) === symbol);
    const aliases = [...new Set([match?.longname, match?.shortname, match?.displayName]
      .map(cleanCompanyName)
      .filter(Boolean))];
    memoryCache.set(cacheKey, aliases);
    return aliases;
  } catch (_error) {
    return [];
  }
}

function cleanCompanyName(value) {
  return String(value || "")
    .replace(/\b(?:incorporated|inc|corporation|corp|company|co|limited|ltd|plc|holdings?)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/[,.]+$/g, "")
    .trim();
}

function isWithinPastWeek(value) {
  const published = Date.parse(value);
  return Number.isFinite(published) && published >= Date.now() - 7 * 86400000 && published <= Date.now() + 3600000;
}

function isRelevantRssArticle(article, symbol, aliases = []) {
  const title = String(article.title || "");
  const description = String(article.description || "");
  if (/_TITLE_|_QUOTE|\{\{.*\}\}|\[object Object\]|(?:^|\s)(?:undefined|null)(?:\s|$)/i.test(`${title} ${description}`)) return false;
  if (!isNewsArticleTitle(`${title} ${description}`)) return false;
  if (!isAllowedPublisher(article.publisher)) return false;
  const escaped = escapeRegExp(symbol).replace(/\\-/g, "[-.]?");
  const haystack = `${title} ${description}`;
  const hasSymbol = new RegExp(`(?:^|[^A-Z0-9])\\$?${escaped}(?:[^A-Z0-9]|$)`).test(haystack);
  const normalizedHaystack = haystack.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const hasCompany = aliases.some((alias) => {
    const normalizedAlias = alias.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return normalizedAlias.length >= 3 && normalizedHaystack.includes(normalizedAlias);
  });
  return hasSymbol || hasCompany;
}

function isAllowedPublisher(publisher) {
  const source = String(publisher || "").trim().toLowerCase();
  if (source === "yahoo finance") return true;
  return source.includes("marketwatch")
    || source.includes("cnbc")
    || source.includes("bloomberg")
    || source.includes("reuters")
    || source === "ap news"
    || source.includes("associated press")
    || source.includes("business wire")
    || source.includes("globenewswire")
    || source.includes("pr newswire")
    || source.includes("benzinga");
}

function isNewsArticleTitle(title) {
  const text = String(title || "").trim();
  if (!text || text.length < 12) return false;
  return !/(?:\bvideo\b|watch\s+(?:now|the\s+video)|final\s+trades?|closing\s+bell:\s*overtime|squawk\s+(?:box|on\s+the\s+street)\s+video|argus|quantitative\s+(?:stock\s+)?report|equity\s+research\s+report|premium\s+research|latest\s+(?:stock\s+)?news\s*(?:&|and)\s*headlines|interactive\s+(?:stock\s+)?chart|advanced\s+chart|historical\s+data|option(?:s| chain)?|call\s*\(|put\s*\(|\b(?:call|put)\s+\([A-Z0-9]+\)|stock quote|real-time quote|stock\s+price.*(?:quote|history|news)|(?:quote|history).*stock\s+price|company[-\s]+profile|executive\s+profile|company\s+executives|board\s+members|key statistics|financials|holders|insider transactions|analyst estimates|dividend history|price\s*(?:&|and)\s*news|quote\s*(?:&|and)\s*history|overview$)/i.test(text)
    && !/\b[A-Z]{1,6}\d{6}[CP]\d{8}\b/.test(text);
}

async function loadTickerTrend(rawSymbol) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9.^=\-]{1,20}$/.test(symbol)) throw new Error("Invalid price symbol");
  const bars = await loadChart(symbol, "day");
  if (bars.length < 2) throw new Error("Not enough price data");
  const latest = bars.at(-1).close;
  const baseline = bars.at(-2).close;
  return { changePercent: ((latest / baseline) - 1) * 100 };
}

async function fetchRssFeed(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`RSS request failed: HTTP ${response.status}`);
  return parseRss(await response.text());
}

function parseRss(xml) {
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].flatMap(([item], index) => {
    const title = rssField(item, "title");
    const url = safeNewsUrl(rssField(item, "link"));
    if (!title || !url) return [];
    const source = rssField(item, "source") || title.match(/ - ([^-]+)$/)?.[1] || "RSS";
    const cleanTitle = source !== "RSS" ? title.replace(new RegExp(`\\s+-\\s+${escapeRegExp(source)}$`, "i"), "") : title;
    return [{
      id: `rss-${index}-${url}`,
      title: cleanTitle,
      description: stripRssHtml(rssField(item, "description")),
      url,
      publisher: source,
      publishedAt: rssField(item, "pubDate") || rssField(item, "published") || ""
    }];
  });
}

function rssField(item, tag) {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return decodeXml(String(match?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, "").trim());
}

function stripRssHtml(value) {
  const decoded = decodeXml(value);
  return decodeXml(decoded.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeXml(value) {
  return String(value).replace(/&#(x?[0-9a-f]+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (match, numeric, named) => {
    if (numeric) return String.fromCodePoint(parseInt(numeric.replace(/^x/i, ""), numeric[0].toLowerCase() === "x" ? 16 : 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[named.toLowerCase()] || match;
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeNewsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch (_error) {
    return "";
  }
}

function isLikelyEnglish(raw) {
  const declared = String(raw?.language || raw?.lang || "").toLowerCase();
  if (declared && !/^(?:en|eng)(?:[-_]|$)/.test(declared)) return false;
  const text = `${raw?.title || ""} ${raw?.description || ""}`.trim();
  if (!text) return false;
  const letters = text.match(/\p{L}/gu) || [];
  const nonLatin = text.match(/[^\p{Script=Latin}\p{N}\p{P}\p{Z}\p{S}]/gu) || [];
  if (letters.length && nonLatin.length / letters.length > 0.05) return false;

  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  const english = words.filter((word) => /^(?:the|a|an|and|or|but|for|to|of|in|on|with|as|at|by|from|is|are|was|were|will|has|have|its|this|that)$/.test(word)).length;
  const nonEnglish = words.filter((word) => /^(?:el|la|los|las|del|que|con|para|una|uno|und|der|die|das|den|von|mit|pour|les|des|une|est|sur|dans|et)$/.test(word)).length;
  return nonEnglish < 3 || english >= nonEnglish;
}

function normalizeNewsSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  const ticker = raw.includes(":") ? raw.split(":").at(-1) : raw;
  return /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(ticker) ? ticker.replaceAll(".", "-") : "";
}

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
