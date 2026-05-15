# GRIB backfill — one-time historical weather ingestion

Fills the `forecast_daily` table in `server/weather/weather_cache/weather.db`
with **true issuance-anchored** vintage forecasts for dates before
2021-04-01 — the era the live Open-Meteo Previous Runs path can't reach.

After this runs, the replay weather panel works for 2010-2019 dates exactly
like it does for 2021+ dates: same 57 sample points, same HDD/CDD math, same
America/Chicago day boundary. The only difference is the data *source* (NOAA's
free GEFS Reforecast archive instead of Open-Meteo).

This is **archival reference code**. The GEFS Reforecast retrospective is
frozen (2000-2019, NOAA will not add to it), so once you've run the backfill
for the range you care about, these scripts never run again. They stay in git
for reproducibility.

Nothing here is imported by the runtime server. The only coupling point is the
SQLite schema — `import_to_db.py` writes the same row format the live
ingestion writes.

---

## Quick start

```bash
# 1. Install the backfill-only dependencies (prebuilt Windows wheels — no
#    conda, no C toolchain).
pip install -r scripts/grib_backfill/requirements.txt

# 2. Make sure the DB exists (start the server once, or:)
python -c "from server.weather.service import WeatherService; WeatherService()"

# 3. Download + extract. Default is --members control (1 file/cycle, fits an
#    overnight run). Resumable — Ctrl-C and re-run anytime; done cycles skip.
python scripts/grib_backfill/backfill.py \
    --source gefs_reforecast --start 2010-01-01 --end 2019-12-31

# 4. Load the extracted Parquet into the SQLite cache (idempotent).
python scripts/grib_backfill/import_to_db.py --source gefs_reforecast

# 5. (optional) reclaim disk — the Parquet is regenerable from step 3.
rm -rf scripts/grib_backfill/extracted/
```

After step 4, hover any 2010-2019 bar in replay; the panel populates.

### Don't want to run for hours straight? Chunk it.

The backfill is **resumable** — each finished cycle writes its Parquet, and a
re-run skips cycles that already have one. So just stop (Ctrl-C) whenever and
re-run the same command later; it picks up where it left off. Or run explicit
chunks:

```bash
# A year per night:
python scripts/grib_backfill/backfill.py --source gefs_reforecast --start 2010-01-01 --end 2010-12-31
python scripts/grib_backfill/backfill.py --source gefs_reforecast --start 2011-01-01 --end 2011-12-31
# ...etc. Import after each chunk (or once at the end):
python scripts/grib_backfill/import_to_db.py --source gefs_reforecast --start 2010-01-01 --end 2010-12-31
```

### Want the ensemble mean instead of the control run?

`--members all` averages all 5 reforecast members (smoother, slightly more
skillful) at ~5x the download. To upgrade a range you already did with the
default, add `--force` so it re-extracts:

```bash
python scripts/grib_backfill/backfill.py --source gefs_reforecast \
    --start 2017-01-01 --end 2019-12-31 --members all --force
python scripts/grib_backfill/import_to_db.py --source gefs_reforecast --start 2017-01-01
```

For the 0-7 day leads we use, the difference between the control run and the
ensemble mean is small — the default is fine for almost all purposes.

---

## What the two scripts do

### `backfill.py` — Phase A (download) + Phase B (extract), combined

For each forecast issuance date in the range:

1. Downloads the GEFS Reforecast `tmp_2m` GRIB file(s) for that 00Z cycle —
   one ~60 MB file per ensemble member — to a temp file (deleted right after).
2. Opens it with `cfgrib`; extracts 2 m temperature at the 57 sample points
   (48 state coords + 9 basin points, taken from `server.weather.regions`).
3. Averages the ensemble members → ensemble-mean temperature at each timestep.
4. Buckets each timestep's UTC valid-time into its America/Chicago calendar
   day; takes daily Tmax/Tmin from the timesteps in each bucket.
5. Writes `extracted/gefs_reforecast/<YYYY-MM-DD>.parquet`:
   `forecast_date | target_date | coord_label | tmax_f | tmin_f`.

**Resumable**: a cycle whose Parquet already exists is skipped. So you can
interrupt and restart freely.

**`--members`** (`control` | `all`, default `control`):
- `control` — the unperturbed c00 run only. **One ~60 MB file per cycle.**
  This is the default because it makes the full 2010-2019 backfill an
  overnight job, not a multi-day one, and c00 is a perfectly valid forecast.
- `all` — ensemble mean of the 5 members (c00 + p01..p04). Smoother, slightly
  more skillful, but ~300 MB per cycle (~5x). Use `--force` to re-extract a
  range you already did with the default.

Or set `BACKFILL_MEMBERS=all` in the environment.

**`--force`**: re-download + re-extract even if a cycle's Parquet exists
(otherwise existing cycles are skipped — that's the resume behaviour). Use it
when switching `--members` modes.

**Disk**: each member file (~60 MB) is downloaded to
`scripts/grib_backfill/staging/`, its 57 points extracted, then deleted —
before the next member. So **peak disk during a run is ~60 MB**, regardless of
range length or member count. The staging dir is wiped at the start of every
run (cleaning up after any previous hard-kill) and on the way out. The only
thing that accumulates is `extracted/*.parquet` (~10 KB/cycle, ~40 MB for the
whole 10 years), and that's regenerable + gitignored. A 600 GB disk has room
to spare by ~four orders of magnitude.

### `import_to_db.py` — Phase C (load into SQLite)

Reads the `extracted/gefs_reforecast/*.parquet` files and INSERT-OR-REPLACEs
into `forecast_daily`. For each Parquet row it emits the same per-metric rows
the live path does: `tmax`, `tmin`, `tavg` (all coords) plus `hdd`, `cdd`
(state coords only, via `server.weather.compute`). HDD/CDD math stays in
`compute.py` — this script never reimplements it.

Idempotent. Re-run after each backfill chunk; it overwrites the same primary
keys. `--start` / `--end` limit the import to a date range.

---

## Coverage, horizons, and what's *not* done

| Period | Source | Status |
|---|---|---|
| 2010-01-01 … 2019-12-31 | **GEFS Reforecast v12** (this pipeline, `--source gefs_reforecast`) | implemented |
| 2020-01-01 … 2021-03-31 | NCAR GDEX `d084001` (operational GFS 0.25°) | **not yet** — needs a `source_ncar_gdex.py` module + a `--source ncar_gdex` branch in `backfill.py`. Same daily-aggregation logic; different URLs + GRIB layout. |
| 2021-04-01 … today | Open-Meteo Previous Runs API | already live (`server/weather/openmeteo_historical.py`) |
| today | Open-Meteo Forecast API | already live |

**Horizon coverage for backfilled dates**: the GEFS `Days:1-10` chunk gives
us forecast leads 0-9 days, which in America/Chicago time works out to full
daily Tmax/Tmin for target days X through X+9. That populates the **Now / 3D /
5D / 7D** panel cells (and 7D revisions, because issuance X-1's view of the
7-day window reaches lead 8, which is in range). The **10D / 14D** cells
render `—` — they'd need the GEFS `Days:10-16` chunk (one more ~60 MB file per
member, doubling the download). Adding it is straightforward; deferred to keep
the backfill volume manageable.

**Revisions / Z-scores**: the day-over-day revision for issuance X needs
issuance X-1 in the DB too (apples-to-apples on target dates). Run the
backfill over a *contiguous* range and every day except the first gets its
neighbor automatically — no special handling needed. Modified-Z needs ~30
prior consecutive day-pairs, so it fills in once you've backfilled a month or
more.

---

## Resource budget

Wall time is **bandwidth-bound** — it's all download. Measured ~8-11 s/cycle
for `--members control` on a ~50 Mbps link (one ~60 MB file + a couple seconds
of cfgrib extraction). Scale to your connection.

| Range | `--members control` (default) | `--members all` (ensemble) |
|---|---|---|
| Per cycle | 1 × ~60 MB, ~8-11 s | 5 × ~60 MB, ~30-65 s |
| Full 2010-2019 (~3 650 cycles) | ~220 GB download, **~8-11 h** | ~1.1 TB download, ~30-65 h |
| One year (~365 cycles) | ~22 GB, ~50-70 min | ~110 GB, ~3-6.5 h |

- **Disk on the machine**: ~60 MB transient (one member file at a time) +
  `extracted/*.parquet` accumulating to ~40 MB for the whole range. Never more.
- **`weather.db` growth**: ~5 metrics × 57 coords × ~10 target days × ~3 650
  cycles ≈ ~10 M rows ≈ ~50-100 MB.
- **Cost**: AWS (and NCAR) are free for read — NOAA's Open Data Program covers
  egress. No charges.

So: the default fits one overnight run, uses ~220 GB of *transfer* but only
~60 MB of *disk at any moment*, and is resumable if it doesn't finish.

---

## Sanity-checking the backfill

After importing a chunk, spot-check a date:

```bash
python -c "
from datetime import date
from server.weather.service import WeatherService
p = WeatherService().build_panel(date(2015, 1, 15))
print('available:', p['available'], '| note:', p['phase1_note'])
for r in ('national','NE','MW','WSC'):
    print(r, {L: p['regions'][r][L] for L in ('Now','3D','7D')})
"
```

Mid-January should show heavy HDD in NE/MW (~250+ over 7 days), light in WSC.
Marcellus basin Tmin should be near or below freezing (renders yellow/red).
Tmax should never be below Tmin; nothing should be outside roughly
[-50 °F, +130 °F].
