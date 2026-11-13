# Clarity SMC v2 for TradingView: ICT structure + volume analysis

`clarity_smc.pine` is a Pine Script v6 overlay indicator. It keeps every v1 feature:
- liquidity: BSL, SSL and LS
- BOS and MSS
- order blocks
- fair value gaps
- volume bubbles
- the four confluence setups
- the dashboard and alerts

It adds measured volume statistics, volume confirmation for ICT events, an automatic stop loss and
three take-profit levels, trade lines with tracking, and a trade dashboard. Defaults are tuned for
**XAUUSD on 1-minute, 5-minute, 15-minute and 1-hour charts**.

> The indicator measures and highlights confluence. It does not predict prices, it cannot see who
> placed orders, and it is not financial advice. Outcomes are never guaranteed.

## Install

1. In TradingView, open **Pine Editor**, choose **New → Indicator**, delete the template, and paste
   the whole file.
2. Click **Save**, then **Add to chart**.
3. Open the indicator **Settings** to change any input listed below.

## 1. Volume analysis: what is measured and how

Everything starts from the chart's own `volume` value. Nothing is generated, estimated or filled in.
Missing values count as zero, and if fewer than half of the candles have volume, every volume
feature reports **No volume data** instead of guessing.

| Quantity | Formula | Notes |
| --- | --- | --- |
| Candle volume | `volume` | Measured. |
| Baseline average | **Same time of day** (default): mean volume of the same clock slot, in the exchange's time zone so it follows daylight-saving changes, over the last *N* sessions (default 10). **Rolling bars**: mean of the previous 20 candles. | The current candle is always excluded. Time of day needs ≥ 3 sessions for a slot, so it uses the rolling average until then. The dashboard says which one is in use. |
| Relative volume | `volume / baseline average` | 1.0× is a normal candle for that time of day. |
| Z-score | `(ln(relative volume) − mean) / standard deviation`, where mean and standard deviation are taken over `ln(relative volume)` of the previous 20 candles | Logs are used because volume is strongly right-skewed. See below. |
| Volume strength | **Low**: relative volume ≤ 0.6× · **Normal** · **Elevated**: relative volume ≥ 1.5× · **High**: z ≥ 2.0 *and* relative volume ≥ 1.5× · **Extreme**: High *and* z ≥ 3.0 | A spike needs both conditions, so a tiny standard deviation alone cannot create one. |
| Volume trend | 5-candle average vs 20-candle average: **Expanding** if > 1.1× and rising over 3 candles, **Contracting** if < 0.9× and falling | Change across several candles. |
| Bullish / bearish volume | Share of volume on bullish vs bearish candles over 20 candles (close vs open; ties use the previous close) | Candle direction, **not** order-flow delta. Real buyer and seller volume is not available from candles. |
| Money flow | `Σ(close-location × volume) / Σ volume` over 20 candles. Close-location = `((close − low) − (high − close)) / (high − low)`, from −1 to +1 | Chaikin-style money flow. |
| Accumulation-like / distribution-like | Money flow ≥ +0.05 (or ≤ −0.05) while price moved ≤ 1.5 ATR over the same 20 candles | An interpretation, labelled as such. |
| Volume climax (**EXH**) | High-volume spike at the highest high (or lowest low) of the last 10 candles, after a move of ≥ 3 ATR, with a rejection wick ≥ 40% of the range or a close in the opposite half | A description of volume, not a reversal signal (see *Measured results*). |
| Fading volume (**FADE**) | The first candle that takes out the previous **swing** high (low), when the average volume of that 3-candle push is below 0.5× the average volume of the 3 candles that formed the swing | Classic volume divergence: the level is taken with clearly less participation than built it. A description, not a reversal signal. |

**Why logs?** I measured gold futures volume (COMEX GC, 1m / 5m / 15m / 1h). A z-score on raw volume
marked 4–5% of candles as Extreme, and spikes clustered at every session open. With the default
settings, the z-score of log relative volume marks about **3–4% of candles High and 1–2% Extreme**.
Spikes are also far more isolated (16% consecutive on 1-hour instead of 44%).

### XAUUSD and tick volume

Most XAUUSD feeds (OANDA, FOREX.com, broker CFDs) report **tick volume**: the number of price
updates, not ounces or contracts traded. Tick volume tracks activity reasonably well, but:

- compare it only with itself (that is why everything is relative);
- different brokers report different tick counts for the same minute;
- it is not comparable with COMEX futures volume.

`Volume data type → Auto-detect` treats Forex and CFD symbols as tick volume and says so in the
dashboard. Choose **Exchange volume** for futures such as `COMEX:GC1!`.

## 2. Volume bubbles

- **Which candles:** a closed candle with relative volume ≥ *Minimum relative volume for a bubble*
  (default 1.5×; set 0 to show every candle).
- **Size** is proportional to relative volume × *Bubble scaling* in five steps:
  - smallest: below 2×
  - small: 2–3×
  - normal: 3–4×
  - large: 4–6×
  - largest: 6× and above

  Extreme spikes are never smaller than normal. *Largest bubble size* caps the top step.
- **Colour:** green for a bullish candle, red for a bearish candle, **yellow for Extreme spikes**.
  All three colours and the transparency are adjustable.
- **Value:** bubbles print the candle's volume (default; or relative volume, or both) in the
  centre, from Elevated strength upwards (the latest 40 are labelled). Hover the value to see every
  measured number for that candle.
- **Placement:** centre of the candle (`(high + low) / 2`) by default, or beside the candle: below
  bullish candles and above bearish ones, 0.3 ATR away.
- **Overlap control:** a bubble within *Minimum bars between bubbles* of the previous one is skipped
  unless it is larger or Extreme. Only past candles are compared, so bubbles never repaint.
- Value labels are limited to the latest 40. Bubbles themselves are lightweight plot shapes.

## 3. Volume confirmation of ICT concepts

| Event | When it is volume-confirmed (`· HV`) |
| --- | --- |
| Liquidity sweep | High-volume spike on the sweep candle or the candle before it |
| Break of Structure / Market Structure Shift | Spike on the break candle or the candle before it |
| Order block | Spike anywhere in the impulse leg from the block to the break; spike when price returns to the block |
| Fair value gap | Spike on the displacement candle that created the gap; spike when price trades back into the gap |
| Strong move | Price moved ≥ 1.5 ATR in 3 candles with expanding volume |
| Volume climax / fading volume | EXH and FADE markers above (off by default) |

The latest of these appears as **Last Volume Event** in the detailed dashboard.

### Setups need several measurable conditions

A **BUY SETUP** or **SELL SETUP** needs three things.

**1. An ICT trigger.** These are the four v1 confluence patterns. HV now means a statistical spike.
   - Liquidity Sweep + High Volume
   - MSS + Fair Value Gap (gap ≥ 0.35 ATR within 3 candles of the shift)
   - BOS + Order Block retest (first retest, rejected by a candle closing in the trend direction)
   - Liquidity Sweep + MSS + Volume Spike (within 20 candles)

**2. At least 2 of these 4 checks.** The number is the *Required checks* input (0–4).
   1. **Volume spike:** High or Extreme on the trigger candle or the 2 before it.
   2. **Volume flow agrees:** money flow beyond ±0.05, or ≥ 55% of volume on candles in the trade direction.
   3. **Participation rising:** 5-candle average volume above the 20-candle average.
   4. **Market structure agrees:** the last BOS/MSS points the same way.

**3. A valid stop:** the stop distance must not exceed *Maximum stop distance* (default 3 ATR).

Triggers that fail are not drawn. The detailed dashboard shows the last rejected trigger and why.

## 4. Stop loss

Entry is the **close of the confirmation candle**. The stop anchor is chosen in this order:

1. **Liquidity-sweep setups:** the lowest low (buy) or highest high (sell) from the sweep candle to the entry.
2. **Order-block setups:** beyond the order block (and the retest wick).
3. **Otherwise:** the last confirmed structural swing low (buy) or swing high (sell).
4. **Fallback:** if that level is on the wrong side of entry, the lowest low or highest high of the last `2 × swing length` candles.

The buffer is then added beyond the anchor:
- **ATR multiple** (default 0.15 ATR), **price units** or **ticks**;
- plus the optional **spread allowance**. For XAUUSD, 0.2–0.5 covers a typical spread.

The stop is never closer than *Minimum stop distance* (default 0.3 ATR). If it would be, it is
widened and the tooltip says so.

The dashboard shows entry, stop loss, the distance in price and the distance in ATR.

## 5. Take profit

**Risk-to-reward multiples** (default):
`risk = |entry − stop loss|`, and `TP1 / TP2 / TP3 = entry ± risk × 1 / 2 / 3`. All three multiples
are inputs.

**ICT liquidity targets:**
- Targets are untaken swing highs (buy-side liquidity) for buys, or untaken swing lows (sell-side liquidity) for sells.
- They are sorted by distance from entry, and anything closer than *ICT targets: minimum distance* (default 1 R) is ignored.
- Levels within *Equal highs / lows tolerance* (default 0.1 ATR) merge into one **equal highs / equal lows** pool, priced at its outer edge where stops rest.
- The three nearest pools become TP1–TP3.
- Missing targets fall back to the risk-to-reward multiples, and each target's tooltip says which source it came from.

## 6. Trade lines

Each confirmed setup draws five lines from the entry candle into the empty space right of price:
- **Entry:** green for buy, red for sell, thicker.
- **Stop loss:** red, dashed.
- **TP1 / TP2 / TP3:** light, medium and dark green, dotted.

Price labels sit right of the latest candle and alternate between two columns, so labels for nearby
prices do not overlap. Hover a label for the reason and the target source.

Trades are tracked on closed candles:
- **Take profit reached:** high (buy) or low (sell) reaches the level.
- **Stopped out:** price reaches the stop.
- **Expired:** after 120 candles (adjustable).
- If the stop and a target are both touched inside one candle, the order is unknown and the status says so rather than guessing.

When a trade ends, its labels are replaced by one small result tag. Only the latest trade is kept by
default (up to 3).

## 7. Dashboard

**Standard** shows exactly the requested items. **Detailed** adds:
- volume trend
- bullish / bearish volume
- live candle volume
- market structure
- liquidity sweep
- volume pattern
- last volume event
- overall bias
- last rejected trigger

| Section | Rows |
| --- | --- |
| Measured data (last closed candle) | Current Volume (says *tick volume* when applicable), Relative Volume (with the baseline used), Volume Strength (with standard deviations) |
| Analysis (interpretation) | Market Direction: last structure break plus position vs the 50-period EMA |
| Trade setup | Trading Setup, Confirmation Status, Entry Price, Stop Loss, Take Profit 1, Take Profit 2, Take Profit 3, Risk-to-Reward Ratio, Trade Status |

Every value has a tooltip explaining how it was calculated. Hover *Confirmation Status* to see which of the 4 checks passed.

## 8. Accuracy and data integrity

- **Closed candles only for final signals.** Structure, sweeps, setups, bubbles, trade tracking and alerts use confirmed candles.
- **Provisional is labelled.** While a candle is open, a forming setup shows as **BUY? / SELL? provisional · candle still open**, and the dashboard says *Provisional*. It disappears if the conditions do not hold at the close.
- **No future data.** No `request.security` lookahead and no negative offsets. Swings are confirmed only after `swing length` candles have closed on the right side, so a swing appears late but never moves.
- **Measured vs interpreted.** The dashboard separates *Measured data* from *Analysis*. Words like *accumulation-like* and *exhaustion* are interpretations of the numbers, never claims about institutional orders.
- **Transparent and configurable.** Every threshold is an input, and every number shown has a tooltip with its formula.

## Volume profile, key levels, sessions and EMA ribbon

**Can it show where people put orders?** No indicator can, for XAUUSD. Resting orders live in brokers'
and liquidity providers' books, and spot gold has no central order book that TradingView can show.
Two tools come closest, and both are labelled for what they are:

- **Volume profile (where trading happened):** a horizontal histogram of the volume traded at each
  price over the last 150 candles (adjustable). Each candle's volume is spread evenly over its
  high–low range, so it is an estimate (on OANDA it is tick volume).
  - **POC (point of control):** the most-traded price row.
  - **Value area (VAH / VAL):** the band around the POC that holds 70% of the volume.

  High-volume prices often act as support or resistance because much trading took place there.
- **ICT liquidity (where stop orders probably rest):** the indicator already marks swing-level
  buy-side and sell-side liquidity, and merges equal highs and lows into EQH / EQL pools. It now also
  draws the **previous day high / low (PDH / PDL)** and **previous week high / low (PWH / PWL)**.
  ICT treats these levels as liquidity, and they are now also used as targets in *ICT liquidity
  targets* mode. These are inferences from price structure, not order data.

**ICT killzones** shade the sessions ICT focuses on, in New York time with daylight saving handled:
Asia 20:00–24:00, London 02:00–05:00 and New York 07:00–10:00. They show on 1-hour and lower charts.
The detailed dashboard shows the current session.

**EMA ribbon:** a 20 / 50 EMA pair (adjustable) with a green fill when the fast EMA is above the slow
one and red otherwise.

The volume profile maths was checked against an independent fine-sampling calculation on real gold
data: volume is conserved exactly, the POC is the largest row, and the value area holds the requested
share of volume.

## 9. Inputs

| Group | Inputs |
| --- | --- |
| 1 · Display | Volume bubbles, liquidity, BOS / MSS, order blocks, fair value gaps, setup labels, trade lines, EXH / FADE markers (off by default), dashboard |
| 2 · Volume analysis | Volume average period, relative volume baseline, sessions for time-of-day baseline, relative volume threshold, standard deviation multiplier (spike / extreme), low volume threshold, short volume average, volume flow period, money flow threshold, exhaustion lookback and minimum move, fading volume ratio, volume data type |
| 3 · Volume bubbles | Minimum relative volume, scaling, largest size, placement, minimum bars between bubbles, value text, value strength, transparency, bullish / bearish / extreme colours |
| 4 · Setup confirmations | The four ICT triggers, required checks (0–4) |
| 5 · Stop loss and take profit | Buffer type and size (ATR / price / ticks), spread allowance, minimum / maximum stop distance, take profit method, three risk multiples, ICT minimum target distance, equal highs / lows tolerance, trades kept, tracking limit, label offset and stagger |
| 6 · Structure and zones | Swing detection length, zones per side |
| 7 · Dashboard | Detail level, position, text size |
| 8 · Volume profile | On/off, length, rows, value area %, width, placement, colours |
| 9 · Key levels, sessions and EMA ribbon | Previous day / week high and low, ICT killzones, EMA ribbon and lengths |

## Suggested XAUUSD settings

| Chart | Swing length | Notes |
| --- | --- | --- |
| 1 minute | 5–7 | Keep *Same time of day*. TradingView may load only a few sessions of 1-minute history, so the dashboard can show the rolling baseline for the first sessions. Consider a spread allowance of 0.2–0.4. |
| 5 minute | 5 | Defaults. |
| 15 minute | 4–5 | Defaults. |
| 1 hour | 3–5 | Defaults; consider a maximum stop distance of 2.5 ATR. |

## Measured results on gold (what the indicator can and cannot tell you)

These were measured on COMEX gold futures (GC) 1m, 5m, 15m and 1h data, using a line-by-line
JavaScript port of this script. Its structure, swing, sweep and order-block output is identical to
the independently tested web engine. The data was 5 days (1m), 60 days (5m, 15m) and 2 years (1h).
Spread and commissions are not included.

| Question | Result |
| --- | --- |
| How often do the markers appear? | Statistical volume spikes on 2–5% of candles; setups about 10–16 per 1,000 candles; bubbles on 11–17% of candles at the 1.5× default (raise *Minimum relative volume for a bubble* to 2.0 for fewer) |
| Do EXH / FADE predict reversals? | **No.** 10 and 20 candles later, price had reversed in 44–52% of cases, the same as after any new 10-candle high or low (47–51%). This is why they are off by default and described as volume behaviour, not signals. |
| Stop distance | Median 1.6–2.0 ATR. More than half of all ICT triggers are rejected because their stop would be wider than 3 ATR. |
| Setup outcomes (stop vs take profit, whichever was touched first) | Mixed: from −0.41R to +0.33R per trade depending on timeframe and target (74–184 setups per sample). **There was no consistent edge.** Setups mark measurable confluence; they are not a profitable system on their own. |

## Alerts

- **BUY SETUP** and **SELL SETUP** (confirmed only)
- **Liquidity sweep**
- **Market structure shift**
- **High volume spike**
- **Volume exhaustion** (volume climax or fading volume at a swing)

Confirmed setups also send an `alert()` message containing entry, stop loss and all three targets.
To receive it, create an alert with **Any alert() function call**.

## What was and was not verified

- **Verified locally:** a structural lint on the whole script (brackets, indentation and
  line-continuation rules, functions defined before use, no assignments to globals inside
  functions, declaration order, constructor and tuple sizes, undeclared identifiers). It was
  checked against deliberately broken copies to prove it catches those errors.
- **Measured locally:** the volume classification thresholds, on real gold futures data.
- **Not verified here:** compiling in TradingView itself, because no Pine compiler was available in
  this environment. If the editor reports an error, the message and line number are enough to fix it.
