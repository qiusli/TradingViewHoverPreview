# TradingView Hover Preview

Build a browser extension that displays a compact daily or weekly candlestick chart when hovering over a ticker across TradingView, including Pine Screener and chart watchlists.

## Agreed requirements

- Draw the chart directly; using a saved TradingView layout is no longer required.
- EMA 9: solid green.
- EMA 20: solid red.
- EMA 50: dotted green.
- EMA 200: dotted red.
- Keep the interface simple, with a short hover delay and cached previews.
- Resolve symbols with their exchange to avoid ticker ambiguity.
- Select and verify a historical OHLC data source, including enough warm-up history for EMA 200 and consistent split adjustments.

## Status

The Chrome extension is implemented across TradingView pages. It recognizes symbol links and chart-watchlist rows, with separate daily and weekly data for EMA warm-up.
