# TradingView Ticker Hover Preview

A Chrome extension for TradingView Pine Screener. Hover a ticker to see a compact daily or weekly candlestick chart with:

- EMA 9: solid green
- EMA 20: solid red
- EMA 50: dotted green
- EMA 200: dotted red

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.
5. Reload the TradingView Pine Screener page.

Use the **Day** and **Week** tabs in the preview to change timeframes. The extension fetches two years of daily data or ten years of weekly data so longer weekly EMAs can be shown when the symbol has enough history. Results are cached for 15 minutes, including across extension service-worker restarts. If Chrome's storage limit is reached, older chart entries are removed automatically and the current preview still renders. Common Canadian, UK, Australian, Hong Kong, Japanese, and Indian exchange symbols are translated to Yahoo Finance notation. Other symbol coverage and availability depend on Yahoo Finance.

The chart's x-axis follows TradingView's calendar style. Day view marks each month, while Week view marks every other month. January is labeled with the new year instead of the month name.
