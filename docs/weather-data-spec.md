# Weather Data Specification

This document is the source of truth for every weather metric the application
tracks. It exists so that any reader can — using only the URLs and formulas
below — reproduce the same numbers we display, byte-for-byte.

If you change a calculation, source URL, weighting, or region definition, the
change MUST land here in the same commit.

---

## 1. Scope

### Metrics tracked

For each of the **4 regions** below, we track gas-weighted **HDD** (Heating
Degree Days) and **CDD** (Cooling Degree Days) at 6 horizons:

| Horizon | Definition |
|---|---|
| Now (1d) | The forecast's value for the target date (today in live mode, the hovered session date in replay) |
| 3-day | Sum of daily HDD/CDD over target date and the next 2 days (3 days inclusive) |
| 5-day | Sum over the next 5 days inclusive |
| 7-day | Sum over the next 7 days inclusive (matches EIA weekly storage report period) |
| 10-day | Sum over the next 10 days inclusive |
| 14-day | Sum over the next 14 days inclusive |

**4 regions:** National, Northeast, Midwest, South Central.

**Production basin temperatures** (freeze-off risk monitoring) for **3 basins**:
Permian, Marcellus, Haynesville. Tracked at 4 horizons: Now, 5-day min, 10-day
min, 14-day min (minimum over the window — the relevant metric for freeze-off,
not the average).

**Polar vortex strength**: AO (Arctic Oscillation) index, current value plus the
day-over-day delta and modified Z-score of recent revisions.

### What we DO NOT track

- **Realized HDD/CDD or temperatures with hindsight.** Replay mode displays
  only the *forecast* that existed on or before the hover date. Hindsight values
  would invalidate replay's purpose (simulating what a trader would have seen).
- Stratospheric U60/10 wind directly. We use AO as a strongly-correlated proxy
  that's daily-published with no decoding work.
- Sub-daily temperature aggregates. HDD/CDD are inherently daily (computed from
  daily Tmax/Tmin).

---

## 2. Regional definitions

| Region | Aggregate | States |
|---|---|---|
| **National** | Lower-48 (excluding HI, AK) | All 48 contiguous |
| **Northeast** | Census Region: Northeast | CT, ME, MA, NH, RI, VT, NJ, NY, PA |
| **Midwest** | Census Region: Midwest | IL, IN, IA, KS, MI, MN, MO, NE, ND, OH, SD, WI |
| **South Central** | Census Division: West South Central | AR, LA, OK, TX |

### Why these specific definitions

- **NE and MW use Census Regions** (combined divisions) because both regions are
  uniformly heating-dominant and the broader rollup smooths sampling noise.
- **South Central uses West South Central Census Division specifically** rather
  than the broader Census South Region, because:
  - TX is the largest gas-consuming state
  - LA hosts Henry Hub (the gas pricing point)
  - The South Atlantic states (FL, GA, NC, SC, VA) are cooling-dominated and
    would dilute the gas-relevant heating signal
  - This matches EIA STEO's gas-weighted HDD methodology for the South
- **National excludes AK and HI** because they are not on the contiguous gas
  pipeline network and don't drive Henry Hub demand.

### Regional weighting (Phase 1: state population)

Each region's HDD/CDD is a population-weighted average of its constituent
states' HDD/CDD:

```
Region_HDD = Σ (state_HDD × state_pop) / Σ (state_pop)
```

State populations are hard-coded from the most recent **US Census Bureau**
state population estimates and stored in `server/weather/regions.py`.

**Phase 1 trade-off (documented):** True gas-customer weighting (homes with
natural gas as primary heating fuel × population) is the methodologically
"correct" weight for matching NOAA's published gas-weighted index. We use
state population as a Phase 1 approximation because:

1. For the regions we aggregate to (NE, MW, WSC), gas-heating saturation is
   high and uniform within each region; population-weighted and gas-customer-
   weighted HDD/CDD correlate >0.99 historically.
2. State population is a single, stable, easily-verifiable input (US Census).
3. Gas-customer weighting requires annual EIA Form 176 ingestion (own pipeline)
   which is deferred to a future phase.

**Upgrade path:** Replace the `WEIGHTS` dict in `regions.py` with EIA Form 176
residential customer counts. No other code changes required.

### Production basin coordinates

Each basin is represented by 3 grid points (lat, lon) covering the productive
core of the formation. Forecast temperature values for the basin are the
arithmetic mean of the 3 points.

| Basin | Points | Coverage |
|---|---|---|
| **Permian** | (31.99, -102.08) Midland TX, (32.39, -101.55) Big Spring TX, (32.42, -103.13) Hobbs NM | West TX / SE NM productive core |
| **Marcellus** | (40.98, -77.50) State College PA, (39.63, -79.96) Morgantown WV, (41.42, -75.66) Scranton PA | PA / WV core |
| **Haynesville** | (32.51, -93.75) Shreveport LA, (32.31, -94.71) Marshall TX, (33.21, -94.13) Texarkana AR | NW LA / E TX core |

Coordinates are static; if a basin's productive footprint shifts materially
(major rig movement) the coordinate list should be updated and the change
documented in this section's history.

---

## 3. Data sources

All Phase 1 sources are free, government-or-non-profit-hosted, and have
existed for years (low source-rot risk).

### Source A: Open-Meteo Forecast API (current forecasts)

- **URL:** `https://api.open-meteo.com/v1/forecast`
- **Parameters:** `latitude`, `longitude`, `daily=temperature_2m_max,temperature_2m_min`,
  `forecast_days=14`, `temperature_unit=fahrenheit`, `timezone=America/Chicago`
- **Response:** JSON, daily Tmax and Tmin for next 14 days
- **Used for:** Today's forecast for all state-representative coordinates and
  basin coordinates
- **Refresh:** Daily, scheduled by ingestion service. Open-Meteo updates 4× daily;
  we snapshot at 15 UTC (catches the 12Z GFS run).
- **Rate limit:** 10,000 calls/day non-commercial, no auth required. Our daily
  fetch is ~50 state coords + 9 basin coords = ~60 calls. Well under limit.

### Source B: Open-Meteo Previous Runs API (vintage forecasts) — **ACTIVE**

- **URL:** `https://previous-runs-api.open-meteo.com/v1/forecast`
- **Coverage:** GFS 2m temperature from **2021-04-01** onward (hard cutoff;
  earlier dates return HTTP 400 with `out of allowed range`)
- **Schema:** **hourly only** (daily endpoint does NOT accept the
  `_previous_dayN` fields). We aggregate hourly → daily Tmax/Tmin in code.
- **Fields requested per coord:**
  `temperature_2m` (current/short-lead, for lead 0)
  + `temperature_2m_previous_day1` … `temperature_2m_previous_day14`
- **Vintage semantics — IMPORTANT:** for target day `Y` and issuance date `X`,
  with lead `N = Y − X`:
  - lead 0 (Y == X): use the `temperature_2m` field — the analysis / short-lead
    value, which is what a trader on X saw as the current observation
  - lead ≥ 1: use `temperature_2m_previous_dayN` — by Open-Meteo's definition,
    this is "the value as the model was forecasting it N days before
    publication," which for target Y is exactly the forecast issued on X
    (no hindsight leakage)
- **Lead horizon:** GFS short-range archive covers leads **0 through 7 days**.
  `previous_day8` … `previous_day14` return `null`. Consequently, for past
  issuance dates the 10D and 14D horizon cells render `—`. The Now / 3D / 5D /
  7D cells are populated correctly (and 7D matches the EIA weekly storage
  reporting period — the most-watched horizon).
- **Rate limit:** stricter than the Forecast API. Bursting 8 parallel
  workers across 57 coords reliably hits some HTTP 429s; we handle with
  exponential-backoff retry (1, 2, 4, 8 s + jitter) in
  `openmeteo_historical._fetch_with_retry`. Cold-cache historical ingest:
  ~5–10s per issuance date.
- **Refresh:** past issuance vintages are **immutable** — once ingested for
  a given `forecast_date`, never refetched. This is correct: a 2023-01-15
  forecast issued in 2023-01-15 cannot change retroactively.

### Source C: NOAA AO Index — current observation

- **URL:** `https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.index.b500101.current.ascii`
- **Coverage:** Daily values from **1950-01-01** to current (full file)
- **Format:** ASCII, columns: `year month day value`
- **Used for:** Current AO and historical AO for Z-score baseline
- **Refresh:** Daily; full file is ~490 KB, easy to refetch in entirety
- **Note:** "Each daily value is standardized by the standard deviation of the
  monthly AO index from 1979–2000." Source: NOAA CPC AO documentation page.

### Source D: NOAA AO Index — forecast (GFS-derived)

- **URL:** `https://ftp.cpc.ncep.noaa.gov/cwlinks/norm.daily.ao.gfs.z1000.120days.csv`
- **Coverage:** 120-day forecast from current model run
- **Format:** CSV
- **Used for:** Forecast AO values out to 14 days (we only display first 14)
- **Refresh:** Daily

### Source E: GEFS Reforecast v12 (2010–2019 vintage) — **IMPLEMENTED (one-time backfill)**

- **URL:** `https://noaa-gefs-retrospective.s3.amazonaws.com/`
  path `GEFSv12/reforecast/{YYYY}/{YYYYMMDD00}/{member}/Days:1-10/tmp_2m_*.grib2`
- **Coverage:** **2000-01-01 through 2019-12-31**, 5-member ensemble (c00 control
  + p01..p04), once-daily 00Z init. We backfill 2010-2019.
- **Variable:** `t2m` (2 m temperature, Kelvin) on a 0.25° global grid, 80
  timesteps (3-hourly, +3h..+240h).
- **Pipeline:** `scripts/grib_backfill/` — `backfill.py` downloads `tmp_2m`
  GRIB files (transiently; deleted after extract), `cfgrib` extracts the 57
  sample points, ensemble-mean over members, daily Tmax/Tmin per
  America/Chicago day → Parquet. `import_to_db.py` loads Parquet rows into
  `forecast_daily` (source `gefs_reforecast`). See that directory's README.
- **Horizon coverage:** the Days:1-10 chunk → effective leads 0-9d in Central
  time → populates Now/3D/5D/7D cells (and 7D revisions). 10D/14D render `—`
  unless the Days:10-16 chunk is also backfilled (deferred).
- **Member selection:** `backfill.py --members control` (the default) uses
  only the unperturbed c00 run — 1 file/cycle, ~220 GB total for 2010-2019,
  **~8-11 h** (an overnight run). `--members all` averages all 5 members for
  the ensemble mean (smoother) at ~5x the download / time. The difference at
  0-7 day leads is small; control is the pragmatic default.
- **Disk footprint:** ~60 MB transient (one member file at a time, deleted
  after extract; staging dir wiped each run) + ~40 MB of extracted Parquet
  for the whole range. Resumable — interrupt and re-run; done cycles skip.
- **Status:** Pipeline implemented + tested end-to-end (2015-01-14/15/16
  cycles). Running the full 2010-2019 range + `import_to_db.py` is the
  remaining mechanical step.

### Source F: NCAR GDEX d084001 (2020 → 2021-03 vintage) — **PHASE 3 (not started)**

- **URL:** `https://gdex.ucar.edu/datasets/d084001/` (NCEP GFS 0.25° historical
  archive; THREDDS / HTTP)
- **Coverage:** **2015-01-15 to present**, operational GFS deterministic
- **Format:** GRIB2
- **Status:** Not started. Needs a `source_ncar_gdex.py` module + a
  `--source ncar_gdex` branch in `backfill.py`. Same daily-aggregation logic
  as Source E; different URLs and GRIB layout (single deterministic run, not an
  ensemble). Fills the ~15-month gap between GEFS Reforecast's end (2019-12-31)
  and Open-Meteo Previous Runs' start (2021-04-01).

### Source G: NOAA GFS on AWS (`noaa-gfs-bdp-pds`) — **NOT NEEDED**

- **URL:** `https://noaa-gfs-bdp-pds.s3.amazonaws.com/`
- **Coverage:** full `pgrb2.0p25` atmospheric output only from **2021-04-01**
  onward (earlier dates have WAFS aviation products only). Verified 2026-05-12.
- **Status:** Not needed — its coverage start coincides exactly with
  Open-Meteo Previous Runs (Source B), which is already wired and simpler
  (JSON, no GRIB). Source F (NCAR GDEX) handles 2020 → 2021-03.
- **Status:** Deferred — ETL parity with Sources E and F.

---

## 4. Calculations

### 4.1 HDD and CDD (per day, per state)

```
Tavg(d) = (Tmax(d) + Tmin(d)) / 2     [°F]
HDD(d)  = max(0, 65 − Tavg(d))         [degree-days, °F·day]
CDD(d)  = max(0, Tavg(d) − 65)         [degree-days, °F·day]
```

Base temperature: **65 °F**. This matches the NOAA convention. HDD and CDD are
mutually exclusive on a single day (one is always 0).

### 4.2 State HDD/CDD from Open-Meteo

For each state, we hit Open-Meteo at the state's representative coordinate
(see `regions.py:STATE_COORDS`). The representative coordinate is the
geographic center of the state's largest population concentration, NOT the
geographic center of the state, because population concentration drives
gas-demand-weighted temperature.

`Tmax(d)` and `Tmin(d)` come directly from the API's
`temperature_2m_max` and `temperature_2m_min` fields. We compute HDD(d) and
CDD(d) per the formulas in 4.1.

### 4.3 Regional aggregation

```
Region_HDD(d) = Σ_{s ∈ states(region)} weight(s) × state_HDD(s, d)
              / Σ_{s ∈ states(region)} weight(s)
```

`weight(s)` is the state's population from `regions.py:STATE_POP_2023`.
The denominator normalizes within each region (so a region's weights sum to 1.0
implicitly).

### 4.4 N-day sums

We use the **NWS "Day 1–N" convention**: ND horizon for N>1 covers the next
N days, NOT including today. "Now" is the only horizon that uses today.

For horizon N ∈ {1, 3, 5, 7, 10, 14}:

```
Region_HDD_N(forecast_date, region) = Σ_{d=t..t+N−1} Region_HDD(d)

  where:
    if N == 1 ("Now"):  t = forecast_date          (today's value, 1 day)
    if N >  1:          t = forecast_date + 1 day  (window starts tomorrow)
```

Concretely:
- **"Now"** = HDD/CDD for `forecast_date` only (1 day)
- **"3D"** = sum for `[forecast_date+1, forecast_date+2, forecast_date+3]`
- **"7D"** = sum for `[forecast_date+1, ..., forecast_date+7]`
- **"14D"** = sum for `[forecast_date+1, ..., forecast_date+14]`

This matches NWS terminology ("Day 1 through Day N forecast") and how gas
traders interpret a "7-day forecast" — the next 7 days, not 6 plus today.

### 4.5 Day-over-day forecast revision

The naïve approach — today's "7-day" minus yesterday's "7-day" — compares
different target windows (today's covers `[t, t+6]`, yesterday's covered
`[t−1, t+5]`). To get an apples-to-apples revision we anchor on **target
dates**, not on horizon labels.

```
Revision_HDD_N(today, region) =
    [Σ_{d=today..today+N−1} HDD(d) | issued today]
  − [Σ_{d=today..today+N−1} HDD(d) | issued yesterday]
```

In words: take today's N-day sum, then take yesterday's view of those same
N target dates (yesterday's `[d=today, today+1, ..., today+N−1]` rows),
and subtract.

This is why we store forecasts at **daily target-date resolution** rather
than as pre-summed buckets — see 5.

### 4.6 Modified Z-score (revision unusualness)

Modified Z-score (Iglewicz & Hoaglin 1993) is robust to outliers. For a sample
revision `x` and a baseline distribution of historical revisions
`{r_1, r_2, ..., r_n}`:

```
median = median(r_1..r_n)
MAD    = median(|r_i − median|)
Z      = 0.6745 × (x − median) / MAD     when MAD > 0
       = 0                                when MAD == 0
```

Constant 0.6745 is the 75th-percentile of the standard normal distribution; it
makes Z comparable to a z-score for normally-distributed data.

**Baseline scope:** revisions are pooled per `(region, horizon, week_of_year, era)`
for stable seasonality. `era` is `"pre_2020"` (2010–2019, GEFS Reforecast vintage)
or `"post_2020"` (2020+, GFS deterministic) — see era boundary discussion in 7.

**Minimum baseline N:** Z is only emitted when `n ≥ 30`. Below 30, the field
is `null` and the UI shows `—`.

### 4.7 Basin temperature aggregation

For each basin, average across its 3 representative grid points:

```
Basin_Tmin(d, b) = mean(Tmin at point | point ∈ basin_b)
Basin_Tmax(d, b) = mean(Tmax at point | point ∈ basin_b)
Basin_Tavg(d, b) = (Basin_Tmax(d, b) + Basin_Tmin(d, b)) / 2
```

For freeze-off monitoring we display the **minimum** Tmin over each window:

```
Basin_min_N(b, t) = min(Basin_Tmin(d, b) | d ∈ [t..t+N−1])
```

**Freeze-off color thresholds** (applied to Basin_min_N):

- White: > 32 °F (above freezing)
- Yellow: 20–32 °F (moderate risk; well freeze-up possible)
- Red: < 20 °F (high freeze-off risk; production shut-ins likely)

The 20 °F threshold is the conventional industry trigger; below it,
condensate freeze and well-head ice formation become operationally significant.

### 4.8 AO index

Current AO and forecast AO are passed through directly from NOAA — no
calculation. We compute one derived field:

```
AO_revision(today) = AO_forecast(today | issued today)
                   − AO_forecast(today | issued yesterday)
```

And the modified-Z baseline (Section 4.6) over the revision distribution.

---

## 5. Storage schema

SQLite database at `server/weather/weather_cache/weather.db`.

```sql
-- Per-target-date forecast values, keyed by who-issued-when.
-- This is the primitive that supports apples-to-apples revisions (Section 4.5).
CREATE TABLE forecast_daily (
    forecast_date   TEXT NOT NULL,    -- ISO date the forecast was issued
    target_date     TEXT NOT NULL,    -- ISO date the forecast is FOR
    region          TEXT NOT NULL,    -- 'national' | 'NE' | 'MW' | 'WSC' |
                                      -- 'permian' | 'marcellus' | 'haynesville'
    metric          TEXT NOT NULL,    -- 'hdd' | 'cdd' | 'tmin' | 'tmax' | 'tavg'
    value           REAL NOT NULL,
    source          TEXT NOT NULL,    -- 'openmeteo' | 'gefs_reforecast' |
                                      --  'gfs_ncar' | 'gfs_aws'
    PRIMARY KEY (forecast_date, target_date, region, metric)
);

CREATE INDEX idx_forecast_target ON forecast_daily(target_date, region, metric);
CREATE INDEX idx_forecast_issued ON forecast_daily(forecast_date, region, metric);

-- AO observations (current daily) and forecasts.
CREATE TABLE ao_daily (
    forecast_date   TEXT NOT NULL,    -- ISO date forecast was issued
                                      -- (== target_date for OBSERVED rows)
    target_date     TEXT NOT NULL,
    value           REAL NOT NULL,
    kind            TEXT NOT NULL,    -- 'observed' | 'forecast_gfs'
    PRIMARY KEY (forecast_date, target_date, kind)
);

-- Provenance: every raw API response is archived for full reproducibility.
CREATE TABLE raw_fetches (
    fetched_at      TEXT NOT NULL,    -- ISO datetime UTC
    source          TEXT NOT NULL,
    url             TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    bytes           INTEGER NOT NULL,
    path            TEXT NOT NULL,    -- relative path on disk
    PRIMARY KEY (fetched_at, url)
);
```

Raw responses are archived to `server/weather/weather_cache/raw/<YYYY-MM-DD>/`
keyed by sha256 truncated to 12 chars.

---

## 6. Refresh schedule

**Phase 1:** ingestion runs on-demand when the `/weather` endpoint is hit and
cache is stale (>12h since last fetch for the requested date). No background
scheduler — keeps the moving parts minimal.

**Phase 2:** add a daily 15:00 UTC scheduled job that:

1. Pulls Open-Meteo forecasts for all state and basin coordinates
2. Pulls NOAA AO current + GFS forecast files
3. Inserts new rows into `forecast_daily` and `ao_daily`
4. Runs `compute.py` to refresh derived statistics

15:00 UTC is the sweet spot: NOAA's 12Z GFS cycle has finished publishing,
Open-Meteo has incorporated the 12Z GFS into its blended forecast, and US
markets are mid-session.

---

## 7. Replay vs. Live display semantics

### Live mode

- Panel shows `forecast_date = today`, `target_date ∈ [today..today+13]`
- Day-over-day revisions compare today's view to yesterday's view of the
  *same target dates*
- Z-scores are computed against the all-time baseline up through yesterday

### Replay mode

- The panel is keyed by the **hovered (or playhead) bar's UTC timestamp**,
  NOT its session-date label. The displayed issuance date is
  `D = utc_date(bar_time − 6h)` (see "Issuance availability gate" below).
- Panel shows `forecast_date = D`, `target_date ∈ [D..D+13]`
- ALL data shown was knowable **at the bar's exact instant in history**.
  Hindsight values never leak in.
- Day-over-day revisions compare D's view to D−1's view of the same target
  dates (both issued ≤ D, so both public by the time the bar's clock reaches
  06:00Z D).
- If forecast data for date D is not yet ingested (Phase 1 with no vintage
  backfill), the panel shows the message
  `"vintage forecast data not ingested for this date — see weather-data-spec.md §10"`
  and the cells render `—`. No partial/spurious data is shown.

### Issuance availability gate (no-hindsight, intraday-precise)

The session-date label is insufficient for hindsight safety: a CME energy
session labeled `S` opens the prior evening on Globex (~22:00Z S−1), so its
overnight bars trade *before* the S-issuance model run is public. Keying on
the session date would display that run hours before it existed.

**Rule:** every forecast source here (GEFS Reforecast v12, GFS deterministic,
Open-Meteo Previous Runs) is a once-daily **00Z-init** run whose products
finish operational dissemination ~04:00–06:00 UTC. We apply a conservative
**06:00 UTC availability cutoff**: a bar at UTC instant `T` may only display
the run for UTC date `D = utc_date(T − 6h)`. Implemented as
`weatherIssuanceDate()` in `js/time-utils.js`; applied to both the hover path
and the playback/no-hover (playhead) path in `js/main.js`. 06:00 UTC =
02:00 ET in summer (EDT) / 01:00 ET in winter (EST); the cutoff is defined in
UTC so it is DST-stable. It is intentionally ~30–90 min later than the real
dissemination window so the gate never leans optimistic.

**Observed (realized) data — AO index.** Forecast tables store only forecast
vintages (lead-0 is the run's own analysis, available at run-publish time —
still not hindsight). The single realized series is the NOAA CPC daily
**observed AO**. The observed AO for day `D` is that day's realized
atmospheric state and does not exist until `D` is over (CPC publishes it ~1
day later). The panel therefore clamps observed AO to `target_date < D`
(strict): the newest value shown on any tick of day `D` is `D−1`, which is
unambiguously in the past. (`service.py:_build_ao_panel`.)

**Known residual (does not affect historical replay).** The GFS-derived AO
*forecast* file is recent-only (~120 days from the live fetch), so for
historical replay (e.g. 2012) the AO Δ/Z cells render `—` — no data, no
leak. For live / very-recent dates, if a particular AO-forecast vintage
corresponds to a 12Z (rather than 00Z) model run, it could in principle be
shown up to ~6h before that run published. AO is a secondary vortex proxy
and this never affects pre-(today−120d) replay; flagged here for audit
completeness rather than silently assumed safe.

### Era boundary at 2020-01-01 (Phase 2 concern)

When vintage backfill is added, the methodology shifts at this boundary:

- **2010 → 2019:** GEFS Reforecast (5-member ensemble mean)
- **2020 → present:** GFS deterministic (single run)

Forecast revision *magnitudes* may be slightly smaller in the pre-2020 era
because ensemble means smooth out single-member variability. Z-scores are
computed per-era so MAD baselines never mix the two regimes within a single
calculation. The panel surfaces an `era` indicator when the user hovers a
date in the pre-2020 era, with a tooltip linking to this section.

---

## 8. Display layout

The panel is a fixed-position right sidebar, collapsed by default, toggled
by a button next to the existing replay/live mode controls.

```
┌─ WEATHER ──────────────── 2024-01-15 ─┐
│                                        │
│ DEGREE DAYS (gas-pop weighted)         │
│              Now   3D    5D    7D   10D  14D │
│ National     H 38  H 115 H 192 H 270 H 386 H 542 │
│ Northeast    H 45  H 135 H 225 H 315 H 450 H 630 │
│ Midwest      H 52  H 156 H 260 H 364 H 520 H 728 │
│ S.Central    H 18  H  54 H  90 H 126 H 180 H 252 │
│                                        │
│ Δ vs prior day (apples-to-apples)      │
│ National    +2   +5    +8    +11   ... │
│ ...                                    │
│                                        │
│ Z-score (revision unusualness)         │
│ National    0.4  0.6   1.2   2.4 ⚠   ... │
│ ...                                    │
│                                        │
│ POLAR VORTEX                           │
│   AO now: -1.85   Δ −0.42   Z −1.7   │
│                                        │
│ PRODUCTION BASINS — min forecast °F   │
│              Now    5D     10D    14D │
│ Permian      32     28     24     22  │  ← color per cell
│ Marcellus    18     15     12     10  │
│ Haynesville  29     26     24     22  │
└────────────────────────────────────────┘
```

**Color rules:**

- **Degree days cells (H/C):** prefix `H` colored blue, `C` colored orange
- **Δ cells:** red tint when forecast trended warmer (negative Δ in HDD season),
  blue tint when colder; magnitude-proportional opacity
- **Z cells:** badge color follows |Z| — gray (<2), yellow (2–3), red (>3)
- **Basin temperature cells:** white / yellow / red per Section 4.7
- **Disabled / unavailable:** `—` rendered in muted gray, no background

In **Nov–Mar**, the CDD section is auto-collapsed (rare to be nonzero in
heating-dominant regions). In **Jun–Aug**, HDD section is auto-collapsed.
**Apr–May / Sep–Oct (shoulder seasons)**: both shown. The H/C prefix on each
cell makes the active mode unambiguous regardless of season.

---

## 9. Reproducibility recipe

To verify any number on the panel:

1. Read `forecast_date` from the panel header.
2. For each cell, identify `region` (panel row label) and `horizon` (column).
3. Compute `target_dates = [forecast_date+1..forecast_date+N]` (or
   `[forecast_date]` for "Now").
4. For each constituent state (Section 2 region table), fetch the historical
   forecast issued on `forecast_date` for those target dates from Open-Meteo.
5. Compute per-state HDD/CDD per Section 4.1.
6. Population-weight per Section 4.3 using `regions.py:STATE_POP_2023`
   (numbers reproduced in the file with US Census source citation).
7. Sum across the horizon per Section 4.4.

The result should match the panel value to within ±1 degree-day (rounding).

If they disagree, one of the following is true and must be fixed:

- The calculation in `compute.py` drifted from this doc → fix the code
- This doc drifted from `compute.py` → fix this doc
- Open-Meteo revised a historical value → re-snapshot raw response, document

---

## 10. Deferred items

**Implemented:**

- ✅ Open-Meteo Previous Runs vintage ingestion, 2021-04 → today (Phase 2,
  2026-05-11). True issuance-anchored, no hindsight. See Source B.
- ✅ GEFS Reforecast 2010-2019 backfill *pipeline* (2026-05-12). The ETL
  scripts (`scripts/grib_backfill/`) are implemented + tested end-to-end. The
  full 2010-2019 run is a ~2-3 day unattended job — once executed and
  imported, replay panels populate for that whole era. See Source E.

**Still deferred, in priority order:**

1. **Run the GEFS Reforecast backfill for the full 2010-2019 range** — code is
   done; this is just executing it (~2-3 days unattended; ~1.1 TB transient
   download with the 5-member ensemble default, ~1/5 with `--members control`)
   then `import_to_db.py`.
2. **NCAR GDEX 2020 → 2021-03 backfill (Source F)** — fills the ~15-month gap
   between GEFS Reforecast's end and Open-Meteo Previous Runs' start. Needs a
   `source_ncar_gdex.py` module + a `--source ncar_gdex` branch in
   `backfill.py`. Same daily-aggregation logic; different URLs / single
   deterministic run instead of an ensemble. A few days of work.
3. **GEFS Reforecast Days:10-16 chunk** — adds the 10D / 14D horizon cells for
   pre-2020 dates (currently `—`). One more ~60 MB file per member; doubles the
   download volume. Low priority — 7D is the headline horizon.
4. **NOAA observed actuals** — ingest realized HDD/CDD from station data
   (NOAA GHCN or COOP) to enable forecast-vs-realized error analysis (#5).
5. **Forecast skill diagnostics** — once #4 lands, track
   `(forecast − realized)` distributions per (region, horizon, lead).
6. **EIA Form 176 gas-customer weighting upgrade** — replace state population
   weights with residential gas customer counts. Only
   `regions.py:STATE_POP_2023` changes; the backfill picks it up automatically
   (it imports `server.weather.regions`).
7. **Background scheduler** — cron-equivalent daily job at 15:00 UTC for
   today's vintage. Currently lazy on first hit; a scheduler would smooth the
   first-user-of-the-day latency.

When each item is implemented, this section MUST be updated to reflect the new
state, with a brief diff entry in Section 11.

---

## 11. Change log

- 2026-05-10: Initial spec, Phase 1 architecture established. Ingestion limited
  to current Open-Meteo forecasts and NOAA AO current/forecast. Replay mode
  shows `—` for any date prior to first ingestion run.
- 2026-05-11: Phase 2 vintage ingestion shipped — Source B (Open-Meteo
  Previous Runs API) is now active for any issuance date in
  [2021-04-01, today). True issuance-anchored, no hindsight. 10D/14D horizons
  are `—` for past dates because the GFS short-range archive only stores
  leads 0–7 days. Pre-2021-04 still requires GRIB2 ETL (deferred items #1–3).
  Weather panel moved from right to left side of viewport. Also: `ensure_
  ingested_for(X)` now auto-ingests X−1 so the day-over-day revision column
  isn't empty on first hover; the JS client no longer caches a panel response
  whose revision cells are all null.
- 2026-05-12: GRIB backfill pipeline implemented — `scripts/grib_backfill/`
  (`backfill.py` + `import_to_db.py`, Source E: GEFS Reforecast v12 via the
  free `noaa-gefs-retrospective` AWS bucket). Pure Python + `cfgrib`
  (prebuilt Windows wheels — no conda/C-toolchain). Tested end-to-end on the
  2015-01-14/15/16 cycles: panel + revisions populate. Running the full
  2010-2019 range and importing it is the remaining (mechanical) step. The
  panel's footer note now distinguishes "GEFS Reforecast (GRIB backfill)" from
  "Open-Meteo Previous Runs" from "backfill not yet run for this date".
  Default `--members control` (1 file/cycle → ~8-11 h overnight run);
  `--members all` for the ensemble mean at ~5x cost. Downloads go to a
  `staging/` dir holding ≤1 file (~60 MB) at a time, wiped each run — disk
  footprint is negligible. Resumable; `--force` re-extracts existing cycles
  (for switching member modes).
- 2026-05-16: Hindsight-safety + display-correctness pass (§4.5, §7).
  (1) **Δ / Z metric-selection bug fixed** (`js/weather-engine.js`): the
  revision and Z cells used `v.hdd ?? v.cdd`, which in summer returned the
  HDD revision of `0.0` (HDD is 0, not null) and never showed the real CDD
  signal — the Δ column read a constant `0`. Now selects the *same* metric
  the DD cell displays via the identical `isHeating = hd ≥ cd` rule. The Δ
  color tint was also corrected to follow temperature direction
  (colder = blue, warmer = red) for both metrics per §8; the old code was
  correct for HDD but inverted for CDD. Backend math was already correct.
  (2) **Intraday issuance gate added** (§7 "Issuance availability gate"):
  the replay panel now keys forecast issuance off the bar's UTC timestamp
  with a 06:00 UTC availability cutoff (`weatherIssuanceDate()`), not the
  session-date label — closing the overnight-Globex leak where a session's
  pre-dawn bars showed that day's not-yet-published 00Z run.
  (3) **Observed-AO hindsight leak fixed** (`service.py:_build_ao_panel`):
  `target_date <= D` → `< D`. The observed AO for day D is that day's
  realized state (CPC publishes ~1 day later); the old query surfaced the
  replayed day's own realized vortex reading. Verified against the cache
  (2012-07-09: was showing D's AO −0.657, now shows D−1's −1.212).
  Weather panel also bottom-anchored 10px from the viewport edge (was
  top:220 / 20px design margin) so it sits lower regardless of content
  height. `tests/test_weather.py` 12/12 green.
- 2026-05-16: Performance — `/weather` latency fix (no metric change). After
  the full 2010-2019 GEFS backfill (3666 issuance dates, 1.9 GB DB), the
  Z-score baseline (`_historical_revisions`) was rescanning every prior
  forecast_date (~970 for mid-2012) from raw SQL on every request, and
  re-aggregating region dailies once per horizon (6× redundant) — ~37 s per
  cold request, redone by every concurrent/subsequent request (≈6 min wall
  under the panel's playhead-follow firing 8 parallel dates). Added two
  memo caches on immutable past vintages (spec §3 sources B/E guarantee
  immutability): `_state_metric_cache` (per forecast_date×metric SQL load)
  and `_region_daily_cache` (per forecast_date×metric×region aggregation);
  lifted aggregation out of the per-horizon loop. Cold first call 37 s →
  ~17 s; every subsequent distinct date ~1 s (was ~14–37 s). Output
  byte-identical (national 3D cdd 42.0602 unchanged; 12/12 tests green).
  Today's (mutable) vintage is never cached.
