# Footprint Overlay for TradingView (Pine Script v6)

[`footprint_overlay.pine`](footprint_overlay.pine) draws TradingView's own volume footprint rows on
the price chart. Each recent candle shows sell volume on the left and buy volume on the right (or
one delta column), with its Point of Control (POC), value area, diagonal imbalances, stacked
imbalances and a summary below the candle.

> **Status: not yet compiled.** The script was written against the official Pine v6 documentation
> (November 2026), but the TradingView compiler was not available while writing it. Run the
> [first-run checks](#5-verification-checklist) before relying on it.

## 1. Feasibility and limitations

**Feasible.** Pine v6 has a native footprint API (added January 2026). The script uses only these
documented calls:

| Call | Returns | Used for |
| --- | --- | --- |
| `request.footprint(ticks_per_row, va_percent, imbalance_percent)` | `series footprint` or `na` | The only data request |
| `footprint.rows()` | `array<volume_row>`, lowest price first | Every row of the candle |
| `footprint.poc()` / `.vah()` / `.val()` | `volume_row` | POC row and value area bounds |
| `footprint.buy_volume()` / `.sell_volume()` / `.total_volume()` | `float` | Candle totals |
| `volume_row.up_price()` / `.down_price()` | `float` | Row price range |
| `volume_row.buy_volume()` / `.sell_volume()` | `float` | Cell values |
| `volume_row.has_buy_imbalance()` / `.has_sell_imbalance()` | `bool` | Native imbalance flags |

- `ticks_per_row` is a positive "simple int". `va_percent` (default 70) and `imbalance_percent`
  (default 300) are "simple float". The script passes all three from inputs.
- `footprint.*()` and `volume_row.*()` do not accept `na`, so every call is guarded.

**Limitations you should know about**

| Topic | What it means |
| --- | --- |
| **Plan** | Footprints are available only on **Premium and Ultimate** plans. On lower plans TradingView refuses the request itself, so the script cannot show its own message. |
| **One request** | A script may depend on only **one** `request.footprint()` call, including copies made by `request.security()`. A second one is a runtime error. This script makes exactly one call, on the chart's own timeframe. |
| **What "buy" and "sell" mean** | TradingView builds the footprint from lower-timeframe bars. An intrabar's volume is **buy** if that intrabar closed above its open and **sell** if it closed below. If open = close, it is buy when the close rose versus the previous intrabar, sell when it fell, and keeps the previous side when unchanged. The Help Center states that `request.footprint()` **always uses this method**, even when the chart's "Tick-based calculation" (aggressor side, bid/ask) is on. These are **up-move / down-move volume estimates, not exchange-reported aggressive orders at the bid or ask**. |
| **How volume is spread across rows** | TradingView does not document exactly how an intrabar's volume is divided among the price rows it spans. The script displays TradingView's row values unchanged. |
| **History depth** | Historical footprints use the finest intrabar data available. Intraday charts step through tick (professional plans) → 1 second → 1 minute → 60 minutes, so **older candles use coarser data**. Daily charts use 1 minute → 60 minutes, and weekly/monthly use 60 minutes. Some symbols have no footprint at all. |
| **Live vs history** | The open candle is built from live data and is **provisional**. After a reload, TradingView may rebuild the same candle from a different intrabar source, so values can differ slightly from what you saw live. TradingView describes its own footprint alerts as "repainting by design" for this reason. |
| **Daily and higher** | Footprint total volume can differ from the chart's `volume`, because end-of-day feeds may include block or OTC trades that intraday data lacks. |
| **Tick volume** | On forex and CFD symbols, volume counts price updates, not traded size. The status panel says so. |
| **Not supported** | There is no API for TradingView's "Ladder" or "Profile" display types, tick-based (aggressor) footprints, min/max delta within the bar, or the native chart's stacked-imbalance projection lines. The script does not imitate them with estimated data. |

## 2. Add it to TradingView

1. Open a chart of a symbol with volume (futures, stocks, crypto) on a **time-based** timeframe with
   standard candles or bars, e.g. 1m–15m.
2. Open **Pine Editor** at the bottom of the chart and choose **New → Indicator**. Select all of the
   template and replace it with the full contents of `pine/footprint_overlay.pine`.
3. Click **Save**, name it, then **Add to chart**. If the editor shows errors, see
   [section 5](#5-verification-checklist).
4. **Set the row size first.** Open **Settings → Inputs → Ticks per row**. Aim for about 8–20 rows per
   candle. The status panel (bottom left) suggests a value when rows are too many or too few.
   Rough starting points (ranges vary with volatility): ES 5m (tick 0.25): 1–2; BTCUSDT 5m
   (tick 0.01): 500–1500; AAPL 5m (tick 0.01): 2–5.
5. **Zoom in.**
   - Drag the time axis or press Ctrl/Cmd + ↑ until each bar is about **100–150 px wide**.
   - Drag the price axis to stretch rows vertically if the numbers are tiny.
   - Text size **Auto** fits each cell, so the numbers grow as you zoom.
   - Older candles beyond the limit draw normally without footprint.
6. Optional: open **Chart settings → Symbol** and lower the body opacity. The center gap then shows a
   thinner candle.

### Reading the chart

The example candle from section 4, rows 1–4 (highest price at the top):

```
   sell │ │ buy
     12 │▐│  40 ┃
     10 │▐│ 100 ┃   ← green bar: stacked buy imbalance (rows 2–4, all bold/bordered)
     30 │▐│ 270 ┃   ← yellow frame: POC  ┐
     70 │▐│ 180     ← dashed blue frame: ┘ value area (rows 1–2)
         V 765      ← summary: total volume
         Δ +461                delta = buy − sell
         Δ% +60.3%             delta % = delta / total × 100
```

`▐` is the thin strip of the real candle that shows through the center gap.

| Mark | Meaning |
| --- | --- |
| Cell color | Green = buy column, red = sell column. In Delta mode, green = positive row delta and red = negative. Stronger color = more volume relative to the busiest cell of the **same candle**. |
| **Bold** number with a bright border | Diagonal imbalance. Delta mode adds ▲ for buy and ▼ for sell. |
| Yellow frame | POC row: the highest combined buy + sell volume. |
| Dashed blue frame | Value area rows (VAL to VAH). |
| Thick bar outside the cells | Stacked imbalance: red on the left (sell), green on the right (buy). |
| `● live` | Open candle; every value is provisional until it closes. |
| `⚠ N rows hidden` | The candle has more rows than *Max rows per candle* allows (see section 3). |
| `no footprint` / `V 0` | TradingView returned no footprint, or one with zero volume. |

Hover a summary label to see the full breakdown in its tooltip. The **Data Window** lists FP total,
buy, sell, delta, delta % and the stacked-run counts for any candle you hover.

## 3. Settings

| Group | Input | Default | Notes |
| --- | --- | --- | --- |
| Footprint data | Ticks per row | 100 | Row height = ticks × `syminfo.mintick`. Must be a fixed number (Pine requires a "simple int"), so it cannot adapt to volatility automatically. |
| | Value area % | 70 | Passed to `request.footprint()`. |
| | Imbalance threshold % | 300 | 300% means 3×. Passed to `request.footprint()`, so it also sets the native flags. |
| Display | Mode | Buy/Sell | Buy/Sell or Delta. |
| | Recent candles to display | 8 | Capped by the object budget (see below). |
| | Max rows rendered per candle | 28 | Each candle reserves this many rows of boxes. |
| | Cell text size | Auto | Auto, Tiny, Small, Normal, Large. |
| | Opaque cells | on | Blends cell colors with the chart background so the candle does not show through the numbers. |
| | Center gap | 12% | Width of the strip that shows the real candle. |
| | Summary / summary text size | on / Small | |
| | Status panel / position | Always / Bottom left | Always, Only with notices, Off. |
| Highlights | POC, value area, imbalance cells, stacked bars | all on | |
| Imbalances | Imbalance source | Native flags | Or **Script recalculation** (same rule, explicit edge and zero rules). |
| | Zero opposing volume counts | on | Script mode only. |
| | Stacked imbalance: consecutive rows | 3 | 2–20. |
| | Min volume for imbalance signals | 0 | Applies to highlights, stacks and alerts. |
| Colors | Buy, sell, buy/sell imbalance, POC, value area, text | | Text defaults to the chart foreground color. |
| | Strongest / weakest cell transparency | 10 / 88 | Range of the volume-intensity scale. |
| Alerts | Timing | Confirmed candle close | Or Live (provisional, once per candle). |
| | Stacked buy / stacked sell / positive delta / negative delta | on / on / off / off | |
| | Delta threshold | 30, % of candle volume | Or an absolute volume. |

**Object budget.** Pine allows at most 500 boxes, 500 lines and 500 labels per script. When more are
created, it silently deletes the oldest ones. To prevent that, every candle **reserves** its worst case
in advance:

- `boxes = max rows × 2 (Buy/Sell) or × 1 (Delta) + 1 value-area frame + 1 POC frame`
- `lines = 2 × (⌊max rows ÷ stacked rows⌋ + 2)` for stacked bars
- one label for the summary

The candles shown are `min(requested, ⌊490 ÷ boxes per candle⌋, ⌊490 ÷ lines per candle⌋)`.
Defaults: 28 rows × 2 + 2 = 58 boxes per candle → 8 candles = 464 boxes. If you ask for more than
fits, the status panel says `Showing 8 of 12 candles…` and tells you which setting to change.

**Hidden rows.** If a candle has more rows than *Max rows per candle*:
- The rows around its POC are drawn.
- The summary label says how many rows are hidden.
- The tooltip says how many are hidden above and below.
- The status panel suggests the *Ticks per row* that would show every row.

Rows are never merged. Totals, POC, value area, imbalances, stacks and alerts always use **all** rows.

## 4. How it calculates, with one example

A footprint row is one price band of height `ticks per row × mintick`. TradingView puts each band's
buy and sell volume in it. Below is one candle with tick size 0.25 and **Ticks per row = 2**, so each
row is 0.50 high. The values are what `volume_row.sell_volume()` and `buy_volume()` would return.

| Row | Price | Sell | Buy | Total | Delta |
| --- | --- | ---: | ---: | ---: | ---: |
| 6 | 102.50–103.00 | 10 | 3 | 13 | −7 |
| 5 | 102.00–102.50 | 20 | 20 | 40 | 0 |
| 4 | 101.50–102.00 | 12 | 40 | 52 | +28 |
| 3 | 101.00–101.50 | 10 | 100 | 110 | +90 |
| 2 | 100.50–101.00 | 30 | 270 | **300** | +240 |
| 1 | 100.00–100.50 | 70 | 180 | 250 | +110 |
| **Σ** | | **152** | **613** | **765** | **+461** |

**Delta and delta %.** Delta = buy − sell = 613 − 152 = **+461**. Delta % = 461 ÷ 765 × 100 =
**+60.3%**. If total volume is 0, delta % is undefined: the script shows `—` and never fires a % alert.
The summary under the candle reads `V 765 · Δ +461 · Δ% +60.3%`.

**POC.** The POC is the row with the highest total. Here that is row 2 (300), so it gets the yellow
frame. The script uses TradingView's `footprint.poc()` row.

**Value area (70%).** The target is 0.70 × 765 = 535.5. The area starts at the POC (300) and grows
toward the larger neighbour: row 1 (250) beats row 3 (110), giving 550 ≥ 535.5. The value area is
rows 1–2 (100.00–101.00), which holds 71.9% of the volume.

TradingView's two help pages describe this expansion differently: one adds a single row at a time,
the other two rows at a time. In this example both give the same answer. In general the script
draws exactly what `footprint.vah()` and `footprint.val()` return.

**Diagonal imbalances (300% = 3×).** Each row is compared with its diagonal neighbour, not the cell
beside it:

- **Buy imbalance at row *i*:** buy(*i*) ≥ 3 × sell(row *below* *i*)
- **Sell imbalance at row *i*:** sell(*i*) ≥ 3 × buy(row *above* *i*)

| Row | Buy check | Result | Sell check | Result |
| --- | --- | --- | --- | --- |
| 6 | 3 ≥ 3 × 20 = 60 | no | nothing above | — |
| 5 | 20 ≥ 3 × 12 = 36 | no | 20 ≥ 3 × 3 = 9 | **sell imbalance** |
| 4 | 40 ≥ 3 × 10 = 30 | **buy** | 12 ≥ 3 × 20 = 60 | no |
| 3 | 100 ≥ 3 × 30 = 90 | **buy** | 10 ≥ 3 × 40 = 120 | no |
| 2 | 270 ≥ 3 × 70 = 210 | **buy** | 30 ≥ 3 × 100 = 300 | no |
| 1 | nothing below | — | 70 ≥ 3 × 270 = 810 | no |

The rule is TradingView's documented formula `max(buy, sell) ≥ (imbalance % / 100) × min(buy, sell)`,
applied diagonally. 300% therefore means "three times", not "300% more".

**Stacked imbalance.** Rows 2, 3 and 4 are three consecutive, touching rows with buy imbalances. That
makes a **stacked buy imbalance** from 100.50 to 102.00, shown as a green bar to the right of those
rows. Row 5's sell imbalance stands alone, so it is highlighted but not stacked. Rows must touch
(the upper price of one equals the lower price of the next) to count as consecutive.

**Minimum volume filter.** With *Min volume for imbalance signals* = 50, row 4 (buy 40) and row 5
(sell 20) no longer qualify. Rows 2–3 are only two in a row, so there is no stacked imbalance and no
alert.

**Zero-volume behaviour.**
- An imbalance always needs volume on its own dominant side. A row with buy = 0 is never a buy
  imbalance, and 0 vs 0 is never an imbalance.
- *Script recalculation* mode makes the remaining cases explicit:
  - The lowest row cannot have a buy imbalance and the highest row cannot have a sell imbalance,
    because they have no diagonal partner.
  - If the diagonal opposing volume is 0 and the dominant side is above 0, the ratio is undefined. It
    counts as an imbalance only while *Zero opposing volume counts* is on (the default).
  - A price level missing from `rows()` inside the candle counts as 0 opposing volume.
- *Native flags* mode shows TradingView's own `has_buy_imbalance()` / `has_sell_imbalance()`.
  TradingView does not document its edge-row and zero cases, so compare the two modes if those cases
  matter to you.

**Cell intensity.** Opacity = weakest + (strongest − weakest) × cell volume ÷ busiest cell of the
candle. Defaults are 12% to 90% opacity, i.e. transparency 88 to 10. Row 2's buy cell (270) is the
busiest, so it is fully strong (90%). Row 1's buy cell (180 ÷ 270 = 0.67) is 64%, and row 1's sell
cell (70 ÷ 270 = 0.26) is 32%. In Delta mode the scale is |row delta| ÷ largest |row delta|.

## 5. Verification checklist

**First run (needs TradingView, not done yet)**
- [ ] The script compiles in the Pine Editor with no errors. If one appears, its line number points
      at the call to check against the Reference Manual.
- [ ] On a Premium/Ultimate account, on ES1! or BTCUSDT at 5m, cells appear on the last 8 candles,
      and the status panel shows no ⚠ lines once Ticks per row is set.
- [ ] Cells sit inside each candle's own bar slot, left and right of a thin candle strip. They should
      be ±44% of the bar from its center, with no overlap with neighbouring candles. This relies on
      `xloc.bar_time` placing timestamps between bars proportionally. Check the first and last bar of
      a session too: cells beside a session gap may render narrower.

**Calculations**
- [ ] Hover a candle: Data Window FP buy + FP sell = FP total. FP delta = buy − sell. FP delta % =
      delta ÷ total × 100.
- [ ] Compare against TradingView's built-in **Volume footprint** chart type with the same ticks per
      row, VA % and imbalance %. The default "aggregated" calculation must be used, not tick-based.
      POC, VAH/VAL, per-row numbers and the info box (total, delta, delta %) should match.
- [ ] Switch *Imbalance source* between Native and Script on the same candle. Interior rows should
      agree; any difference shows TradingView's edge/zero handling.
- [ ] Set *Min volume for imbalance signals* above a stacked row's volume: the stack disappears.

**Missing data**
- [ ] On a symbol without volume (e.g. an index such as SPX, or a forex symbol), the status panel
      explains the problem instead of the script failing silently.
- [ ] On Heikin Ashi or Renko, the status panel warns about a non-standard chart type.
- [ ] Scroll to old history: candles beyond the footprint history show `no footprint`, and the status
      panel counts them.

**Alerts**
- [ ] Create an alert with **Any alert() function call**. A stacked imbalance fires **once**, when the
      candle closes, and the message names the price range.
- [ ] With timing = Live, the alert fires at most once per candle and its message says "provisional".
- [ ] The `alertcondition` entries ("Footprint: …") appear in the alert dialog. Use frequency "Once per
      bar".
- [ ] Delta alerts respect the sign and unit: a +40% candle fires "positive" at threshold 30%; a −10%
      candle does not fire "negative".

**Drawing limits and live behaviour**
- [ ] Set *Recent candles* = 20 with *Max rows* = 28 in Buy/Sell mode. The status panel should say
      `Showing 8 of 20 candles` and no cell should vanish from the oldest drawn candle.
- [ ] Set *Ticks per row* very small so candles exceed *Max rows*. Each affected candle shows
      `⚠ N rows hidden` and the panel suggests a ticks value; totals stay identical.
- [ ] Leave the chart running through several candle closes. The open candle redraws each tick
      (`● live`), the oldest footprint is removed as a new candle starts, and no stale cells pile up.

## Sources

- [Pine Script docs: `request.footprint()`](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/#requestfootprint)
- [Pine Script docs: `footprint` and `volume_row` types](https://www.tradingview.com/pine-script-docs/language/type-system/#footprint-and-volume_row)
- [Pine Script release notes, January 2026](https://www.tradingview.com/pine-script-docs/release-notes/)
- [Help Center: Volume footprint charts](https://www.tradingview.com/support/solutions/43000726164/): classification, intrabar intervals, imbalance formula, repainting note
- [Help Center: Volume profile basic concepts](https://www.tradingview.com/support/solutions/43000502040-volume-profile/) and the [TradingView wiki](https://www.tradingview.com/wiki/Volume_Profile): value area method
- [Pine Script docs: Execution model](https://www.tradingview.com/pine-script-docs/language/execution-model/) (rollback), [Visuals overview](https://www.tradingview.com/pine-script-docs/visuals/overview/) (z-index, `behind_chart`), [Limitations](https://www.tradingview.com/pine-script-docs/writing/limitations/)
