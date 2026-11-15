# Clarity SMC

A clean, institutional-style **Smart Money Concepts** chart. It shows liquidity, market structure,
order blocks, fair value gaps and volume, and highlights a **BUY SETUP / SELL SETUP** only when
several confirmations line up. The goal is to understand the market in 3–5 seconds, without a
chart full of indicators.

- **Web app** — live at **https://clarity-smc.onrender.com** (free Render web service) with crypto, stock, index, forex and commodity data.
- **TradingView version** — a Pine Script v6 indicator in [`pine/clarity_smc.pine`](pine/clarity_smc.pine) with the same ICT rules plus volume statistics, automatic stop loss and take profit ([how it works](pine/README.md)).

> Setups highlight confluence only. They are not financial advice and outcomes are never guaranteed.

## Reading the chart in 5 seconds

1. **Top-right card → Overall bias** (Bullish / Bearish / Neutral) with Trend, Volume, Structure and the latest Liquidity sweep.
2. **Solid green / red pill** → the newest BUY SETUP / SELL SETUP and the confirmations behind it (e.g. `LS · MSS · HV`). Older setups turn into outlines.
3. **Shaded zones near price** → where price may react: purple order blocks, light-blue (bullish) and light-red (bearish) fair value gaps.
4. **Thin blue lines** → resting liquidity: BSL above highs, SSL below lows.

| Colour | Meaning |
| --- | --- |
| Green | Bullish signals and buying pressure |
| Red | Bearish signals and selling pressure |
| Blue | Buy-side / sell-side liquidity |
| Yellow | High-volume bubbles and volume spikes |
| Purple | Order blocks |
| Light blue | Bullish FVG |
| Light red | Bearish FVG |

| Label | Meaning |
| --- | --- |
| `BSL` | Buy-side liquidity — resting above a swing high |
| `SSL` | Sell-side liquidity — resting below a swing low |
| `LS` | Liquidity sweep — wick through a level that has rested ≥ 10 bars, close back inside |
| `BOS` | Break of structure — close beyond the last swing in the trend's direction |
| `MSS` | Market structure shift — close beyond the last swing against the trend |
| `OB` | Order block — origin candle of the leg that broke structure |
| `FVG` | Fair value gap — three-candle imbalance |
| `HV` | High volume — volume ≥ 2× the previous 20-bar average (adjustable) |

## Setup rules

A setup label appears only when one of the selected confirmation sets is met on a **closed** candle:

| Setup | Rule |
| --- | --- |
| `LS + HV` | Liquidity sweep on a high-volume candle (or right after one) |
| `MSS + FVG` | Market structure shift with a displacement gap (≥ 0.35 ATR) within 3 bars |
| `BOS + OB` | First retest of an order block created by a BOS, rejected by a candle closing in the trend direction |
| `LS + MSS + HV` | Sweep, then a structure shift within 20 bars, with a volume spike in between |

Same-direction setups are spaced at least 10 bars apart unless the new one has more confirmations.
Each set can be switched on or off in **Layers → Setup confirmations**.

## Keeping the chart clean

- Only the nearest live zones and levels per side are drawn (2 by default, adjustable 1–5).
- Filled FVGs, invalidated order blocks and taken liquidity are removed automatically; FVGs shrink as they fill.
- Equal highs / lows within 0.25 ATR are merged into one liquidity pool.
- Labels never stack: lower-priority tags are dropped instead of overlapping, and they stay clear of the dashboard.
- Volume bubbles that would overlap a bigger bubble are skipped.
- Signals are computed on closed candles only, so nothing repaints (verified by a test).

## Display controls

**Layers** toggles each part independently: Volume Bubbles, Liquidity, BOS / MSS, Order Blocks, FVG,
Dashboard and Buy / Sell Setup labels. It also holds the setup confirmation sets and sensitivity
(swing length, high-volume threshold, zones per side). Choices are remembered in the browser; the URL
keeps the symbol and timeframe (`/?symbol=ETHUSDT&tf=4h`) so a view can be shared.

## Data

| Market | Candles | Live updates |
| --- | --- | --- |
| Crypto (`BTCUSDT`, any `…USDT` pair) | Binance public market data (Kraken fallback) | **Real-time**: Binance streams the forming candle (price and volume) about every second |
| Forex, stocks, ETFs, indices | Yahoo Finance chart API | **Real-time** while the market is open: Yahoo Finance streams every traded price (measured ≈1.5 s for forex) |
| Futures (gold `GC=F`, silver, oil) | Yahoo Finance chart API | **Delayed 10 minutes** by the exchange feed (measured); the status bar shows the measured delay |

The status bar always reports what is measured: *Real-time · … stream*, *delayed N min*, or *Market closed*.
Streamed ticks update a candle's price only; candle volume for Yahoo markets always comes from Yahoo's
candles and is never estimated. Forex has no volume, so volume features show N/A.

If every feed is unreachable the server returns clearly labelled **Demo data** so the app still works.
No API keys are required.

### TradingView

The **TradingView** button shows the current market on TradingView's official embedded chart: prices,
data and real-time status come from TradingView. It includes one-click **spot gold (OANDA:XAUUSD)**,
which Yahoo does not offer in real time. TradingView has no public data API and its terms do not allow
copying its data, so the Clarity analysis runs on TradingView data through the Pine Script version
([`pine/clarity_smc.pine`](pine/clarity_smc.pine)) instead.

## Run locally

```bash
npm install
```

```bash
npm start
```

Open http://localhost:10000. Run the tests with:

```bash
npm test
```

## Deploy to Render (free)

The repo includes a [`render.yaml`](render.yaml) Blueprint. In Render choose **New → Blueprint**, pick this
repository and apply, or create a **Web Service** with:

- Runtime: Node · Plan: Free
- Build command: `npm ci --omit=dev`
- Start command: `node server.js`
- Health check path: `/healthz`

Free instances sleep after ~15 minutes without traffic; the first visit afterwards takes up to a minute
while the server wakes (the app shows a message while it waits).

## TradingView

[`pine/clarity_smc.pine`](pine/clarity_smc.pine) is a Pine Script v6 version tuned for XAUUSD (1m–1h). It
has the same ICT features as the web chart, plus:
- statistical volume analysis (time-of-day relative volume, log z-score spikes, money flow, exhaustion);
- volume-proportional bubbles with values;
- volume-confirmed setups;
- an automatic stop loss and three take-profit levels (risk-to-reward or ICT liquidity targets);
- trade lines and tracking, and a full trade dashboard.

See [`pine/README.md`](pine/README.md) for installation and an explanation of every calculation.

### Footprint overlay

[`pine/footprint_overlay.pine`](pine/footprint_overlay.pine) is a separate Pine Script v6 indicator that
draws TradingView's own volume footprint rows on the price chart. It needs a Premium or Ultimate plan.
- sell volume on the left of each candle and buy volume on the right, or a delta column;
- POC, value area, diagonal and stacked imbalances;
- a summary of volume, delta and delta % below each candle;
- alerts on candle close.

Buy and sell are TradingView's intrabar up/down classification, not exchange aggressor data.
See [`pine/FOOTPRINT.md`](pine/FOOTPRINT.md) for installation, limitations and a worked example.

### Pine scripts page

The web app has a **Pine scripts** page at [`/pine`](https://clarity-smc.onrender.com/pine), linked from the top bar.
It shows both indicators with line numbers and has **Copy code** and **Download .pine** buttons. Copy from
there rather than through a chat app: messaging apps turn text such as `8)` into emoji, which breaks
the script.

## Project layout

```
server.js              zero-dependency Node server + market-data proxy
public/index.html      app shell
public/pine.html       Pine scripts page: view, copy and download the indicators
public/js/engine.js    signal engine (pure, shared with tests)
public/js/overlay.js   canvas overlay: zones, lines, bubbles, collision-free labels
public/js/app.js       chart, dashboard, controls, live updates
public/js/theme.js     colour system (dark + light)
pine/clarity_smc.pine  TradingView version (v2: volume statistics, stop loss / take profit)
pine/README.md         how every Pine calculation works
pine/footprint_overlay.pine  TradingView volume footprint overlay (request.footprint)
pine/FOOTPRINT.md      footprint overlay guide: limits, calculations, checklist
test/                  engine and server tests (node --test)
```

Charting by [TradingView Lightweight Charts™](https://www.tradingview.com/lightweight-charts/) (Apache-2.0).
