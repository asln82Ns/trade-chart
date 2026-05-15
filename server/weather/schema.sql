-- See docs/weather-data-spec.md §5 for the schema specification.

CREATE TABLE IF NOT EXISTS forecast_daily (
    forecast_date   TEXT NOT NULL,    -- ISO date the forecast was issued
    target_date     TEXT NOT NULL,    -- ISO date the forecast is FOR
    region          TEXT NOT NULL,    -- 'national'|'NE'|'MW'|'WSC' or
                                      -- per-state code 'state:XX' or
                                      -- basin 'permian'|'marcellus'|'haynesville'
    metric          TEXT NOT NULL,    -- 'hdd'|'cdd'|'tmin'|'tmax'|'tavg'
    value           REAL NOT NULL,
    source          TEXT NOT NULL,    -- 'openmeteo' for Phase 1
    PRIMARY KEY (forecast_date, target_date, region, metric)
);

CREATE INDEX IF NOT EXISTS idx_forecast_target
    ON forecast_daily(target_date, region, metric);

CREATE INDEX IF NOT EXISTS idx_forecast_issued
    ON forecast_daily(forecast_date, region, metric);

CREATE TABLE IF NOT EXISTS ao_daily (
    forecast_date   TEXT NOT NULL,
    target_date     TEXT NOT NULL,
    value           REAL NOT NULL,
    kind            TEXT NOT NULL,    -- 'observed'|'forecast_gfs'
    PRIMARY KEY (forecast_date, target_date, kind)
);

CREATE TABLE IF NOT EXISTS raw_fetches (
    fetched_at      TEXT NOT NULL,    -- ISO datetime UTC
    source          TEXT NOT NULL,
    url             TEXT NOT NULL,
    sha256          TEXT NOT NULL,
    bytes           INTEGER NOT NULL,
    path            TEXT NOT NULL,
    PRIMARY KEY (fetched_at, url)
);
