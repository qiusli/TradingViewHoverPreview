# TradingView Hover Preview

Build a browser extension that displays a compact daily candlestick chart when hovering over a ticker in TradingView Pine Screener.

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

The initial Chrome extension prototype is implemented. It draws the preview directly and retrieves two years of daily history through Yahoo Finance so EMA 200 has sufficient warm-up data.
