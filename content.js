const HOVER_DELAY_MS = 350;
const VISIBLE_BARS = 100;
const popup = document.createElement("div");
popup.id = "tvhp-preview";
popup.hidden = true;
document.documentElement.appendChild(popup);

let hoverTimer;
let hideTimer;
let requestToken = 0;
let activeLink = null;
let activeTimeframe = "day";

document.addEventListener("mouseover", (event) => {
  const link = event.target.closest?.('a[href*="/symbols/"]');
  if (!link || !link.closest("table")) return;
  if (link === activeLink) return;

  activeLink = link;
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hoverTimer = setTimeout(() => showPreview(link), HOVER_DELAY_MS);
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
    const message = error?.message?.includes("Extension context invalidated")
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

function parseSymbol(link) {
  const match = new URL(link.href).pathname.match(/\/symbols\/([A-Z0-9_]+)-([A-Z0-9.\-]+)\/?/i);
  if (!match) return null;
  const exchange = match[1].toUpperCase();
  const ticker = match[2].toUpperCase();
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
