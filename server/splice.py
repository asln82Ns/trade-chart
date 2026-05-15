"""Volume-splice continuous-contract construction.

Algorithm (Mode 2 from the spec):
  1. Enumerate candidate contracts in a window covering the requested range.
  2. Fetch each contract's daily volume.
  3. For each weekday trade date S, choose the active contract:
     - First session: highest-volume contract that day.
     - Each subsequent session S: if prior_session_volume(next) > prior_session_volume(current),
       roll to the next contract at the start of S. Forward-only.
  4. At each roll boundary (session R), compute spread = new.first_1s_bar.open - old.first_1s_bar.open
     where the "first 1s bar" is the bar at session_open (18:00 ET) of session R.
  5. cumulative_spread[S] = sum of all roll spreads up to and including S.
     Translated price for a bar in session S = raw_price - (cumulative_spread[S] - cumulative_spread[entry_session]).

Contract enumeration: for the asset's month codes, generate raw_symbols across
a wide window. Try 2-digit-year form first (NGM25), 1-digit (NGM5) as fallback.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import pandas as pd

from .assets import ASSETS, MONTH_LETTER, get_asset
from .databento_client import DatabentoClient
from .sessions import session_open_utc, session_close_utc, trade_dates_in_range

logger = logging.getLogger(__name__)


@dataclass
class Contract:
    asset: str
    year: int
    month: int
    raw_symbol: str           # 1-digit year, what CME globex actually broadcasts (e.g. NGM5)
    fallback_raw_symbol: str  # 2-digit year, kept as a safety net (e.g. NGM25)

    @property
    def expiry_anchor(self) -> date:
        # Approximate "this contract is relevant" anchor: first day of contract month.
        return date(self.year, self.month, 1)


def enumerate_contracts(asset: str, window_start: date, window_end: date,
                        pad_back_days: int = 180,
                        pad_forward_days: int = 400) -> list[Contract]:
    """Generate candidate contracts whose anchor month falls in
    [window_start - pad_back_days, window_end + pad_forward_days], snapped
    to first-of-month boundaries.

    The default padding (6 months back, 13 months forward) gives the splice
    algorithm plenty of neighboring contracts to compare at the edges, which
    is necessary for /load (arbitrary historical session) and /ranks (full
    lookback window). Callers that only need a narrow set of plausibly-active
    contracts (e.g. resolve_front_month for live subscription) can pass
    smaller pad values to skip the empty far-past / far-future polling.
    """
    cfg = get_asset(asset)
    codes = cfg["month_codes"]
    contracts: list[Contract] = []
    start = date(window_start.year, window_start.month, 1) - timedelta(days=pad_back_days)
    start = date(start.year, start.month, 1)
    end = date(window_end.year, window_end.month, 1) + timedelta(days=pad_forward_days)
    cur = start
    while cur <= end:
        letter = MONTH_LETTER[cur.month]
        if letter in codes:
            yy2 = f"{cur.year % 100:02d}"
            yy1 = f"{cur.year % 10}"
            contracts.append(Contract(
                asset=asset,
                year=cur.year,
                month=cur.month,
                raw_symbol=f"{asset}{letter}{yy1}",
                fallback_raw_symbol=f"{asset}{letter}{yy2}",
            ))
        # advance to first of next month
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)
    return contracts


def resolve_front_month(client: DatabentoClient, asset: str,
                        today: date) -> Optional[tuple[str, Optional[str]]]:
    """Lightweight front-month identification for the LIVE subscription path.

    Avoids the full build_schedule fan-out (which enumerates ~30 contracts
    spanning 2+ years to support historical splice context). For "what
    contract is active today" we only need the few candidates whose anchor
    month is within ±120 days of today, then pick the one with the highest
    volume on the most recent session ANY of them have data.

    Window is ±120 days because some assets trade quarterly (NQ/YM H/M/U/Z)
    or 4-monthly (PL F/J/N/V) — adjacent contracts are 3 months apart. A
    narrower window can miss the next active contract entirely, leaving an
    expired predecessor as the only candidate. ±120 days covers all our
    supported assets safely.

    Comparison is done against the LATEST shared session — never against
    each candidate's own iloc[-1] in isolation. An expired contract whose
    rolling parquet still holds a settlement-day volume spike from weeks
    ago would otherwise beat a currently-trading contract on raw recency
    alone. The 1-day grace allows for within-day publication lag where
    one candidate's most-recent bar may trail another's by one session.

    Returns (raw_symbol, fallback_raw_symbol) of the active contract, or
    None if no candidate has measurable recent volume.
    """
    cfg = get_asset(asset)
    dataset = cfg["dataset"]
    pivot = date(today.year, today.month, 1)
    candidates = enumerate_contracts(
        asset,
        pivot - timedelta(days=120),
        pivot + timedelta(days=120),
        pad_back_days=0,
        pad_forward_days=0,
    )
    if not candidates:
        return None
    # Pull daily volumes for the last ~15 sessions. The rolling cache
    # serves non-empty contracts from disk; only fresh empties or never-
    # seen contracts trigger an HTTP fetch.
    fetch_start = datetime.combine(today - timedelta(days=15),
                                    datetime.min.time(), tzinfo=timezone.utc)
    fetch_end = datetime.combine(today + timedelta(days=2),
                                  datetime.max.time(), tzinfo=timezone.utc)
    candidates_with_data: list[tuple[Contract, "pd.DataFrame"]] = []
    for c in candidates:
        df = client.fetch_ohlcv_1d(dataset, c.raw_symbol,
                                    c.fallback_raw_symbol,
                                    fetch_start, fetch_end)
        if df.empty or "volume" not in df.columns:
            continue
        candidates_with_data.append((c, df))
    if not candidates_with_data:
        return None
    # Latest session ANY candidate has data on. Currently-trading
    # contracts will all share this date (or trail by at most a day).
    latest_date = max(df.index[-1].date() for _, df in candidates_with_data)
    best: Optional[Contract] = None
    best_vol = -1.0
    for c, df in candidates_with_data:
        last_date = df.index[-1].date()
        # Skip contracts whose most-recent bar is more than 1 day before
        # the latest shared date — they're not currently trading
        # (expired or thin), and their cached settlement volume would
        # spuriously beat an actively-trading contract.
        if (latest_date - last_date).days > 1:
            continue
        try:
            recent_vol = float(df["volume"].iloc[-1])
        except Exception:
            continue
        if recent_vol > best_vol:
            best_vol = recent_vol
            best = c
    if best is None or best_vol <= 0:
        return None
    return (best.raw_symbol, best.fallback_raw_symbol)


def _next_contract(contracts_sorted: list[Contract], current_idx: int) -> Optional[int]:
    if current_idx + 1 < len(contracts_sorted):
        return current_idx + 1
    return None


def _daily_volumes(client: DatabentoClient, dataset: str,
                   contracts: list[Contract],
                   start: date, end: date) -> dict[str, dict[date, float]]:
    """Return dict raw_symbol -> {trade_date: volume}.

    Plain dict keyed by datetime.date — using pandas indexes here triggered a
    silent type-coercion bug where date lookups missed Timestamp keys.
    """
    fetch_start = datetime.combine(start - timedelta(days=2), datetime.min.time(), tzinfo=timezone.utc)
    fetch_end = datetime.combine(end + timedelta(days=2), datetime.max.time(), tzinfo=timezone.utc)
    out: dict[str, dict[date, float]] = {}
    for c in contracts:
        df = client.fetch_ohlcv_1d(dataset, c.raw_symbol, c.fallback_raw_symbol,
                                   fetch_start, fetch_end)
        if df.empty or "volume" not in df.columns:
            continue
        s = df["volume"].copy()
        # Normalize index to UTC midnight so multiple rows per date collapse cleanly.
        s.index = s.index.tz_convert("UTC").normalize()
        s = s.groupby(s.index).sum()
        # Convert to a plain {date: float} dict for type-safe lookups.
        out[c.raw_symbol] = {ts.date(): float(v) for ts, v in s.items()}
    return out


def _first_1s_open_at_session(client: DatabentoClient, dataset: str,
                              contract: Contract, trade_date: date) -> Optional[float]:
    """Open price of the 18:00:00 ET 1s bar at the start of session trade_date."""
    open_utc = session_open_utc(trade_date)
    end_utc = open_utc + timedelta(seconds=10)
    df = client.fetch_ohlcv_1s(dataset, contract.raw_symbol,
                               contract.fallback_raw_symbol,
                               open_utc, end_utc)
    if df.empty or "open" not in df.columns:
        return None
    # First bar at or after session open
    df = df.sort_index()
    cutoff = pd.Timestamp(open_utc)
    eligible = df[df.index >= cutoff]
    if eligible.empty:
        return None
    return float(eligible["open"].iloc[0])


@dataclass
class ScheduleEntry:
    session_date: date
    active_contract: str       # raw_symbol (2-digit form)
    cumulative_spread: float   # in raw price units
    incomplete_roll: bool = False  # True if this session began with a roll whose spread couldn't be computed


@dataclass
class RollMarker:
    session_date: date
    from_contract: str
    to_contract: str
    spread: float
    incomplete: bool = False


@dataclass
class SpliceSchedule:
    asset: str
    window_start: date
    window_end: date
    schedule: list[ScheduleEntry]
    rolls: list[RollMarker]

    def lookup(self, trade_date: date) -> Optional[ScheduleEntry]:
        # Linear scan is fine; schedules are at most a few thousand entries.
        last: Optional[ScheduleEntry] = None
        for e in self.schedule:
            if e.session_date <= trade_date:
                last = e
            else:
                break
        return last


def build_schedule(client: DatabentoClient, asset: str,
                   window_start: date, window_end: date,
                   pad_back_days: int = 180,
                   pad_forward_days: int = 400) -> SpliceSchedule:
    """Build a splice schedule covering [window_start, window_end] (inclusive).

    pad_back_days / pad_forward_days flow through to enumerate_contracts.
    Defaults give /load (arbitrary historical session) and /ranks (full
    lookback window) the broad neighbor context they need. The live prime
    path passes tight pads (~30) since it only needs the schedule for the
    last 2 sessions plus minimal roll-detection context.
    """
    cfg = get_asset(asset)
    dataset = cfg["dataset"]

    contracts = enumerate_contracts(asset, window_start, window_end,
                                     pad_back_days=pad_back_days,
                                     pad_forward_days=pad_forward_days)
    contracts.sort(key=lambda c: (c.year, c.month))

    # Daily volumes for splice decisions.
    vols = _daily_volumes(client, dataset, contracts, window_start, window_end)

    # Filter to contracts that actually traded.
    active_contracts = [c for c in contracts if c.raw_symbol in vols]
    if not active_contracts:
        return SpliceSchedule(asset, window_start, window_end, [], [])

    sym_to_idx = {c.raw_symbol: i for i, c in enumerate(active_contracts)}

    # Iterate every weekday in window. Holidays = no volume on that date for any contract.
    trade_dates = trade_dates_in_range(window_start, window_end)
    if not trade_dates:
        return SpliceSchedule(asset, window_start, window_end, [], [])
    # O(1) lookup so the cache-gap fallback below can count trading
    # sessions between `prior` and `d` without scanning the list.
    trade_date_idx = {td: i for i, td in enumerate(trade_dates)}

    # Seed: pick the highest-volume contract on the first session that has any volume.
    seed_idx: Optional[int] = None
    seed_date: Optional[date] = None
    for d in trade_dates:
        best = None
        best_vol = -1
        for c in active_contracts:
            v = vols[c.raw_symbol].get(d, 0)
            if v > best_vol:
                best_vol = v
                best = c
        if best is not None and best_vol > 0:
            seed_idx = sym_to_idx[best.raw_symbol]
            seed_date = d
            break
    if seed_idx is None:
        return SpliceSchedule(asset, window_start, window_end, [], [])

    schedule: list[ScheduleEntry] = []
    rolls: list[RollMarker] = []
    cumulative_spread = 0.0
    current_idx = seed_idx
    last_session_with_data: Optional[date] = None

    for d in trade_dates:
        if d < seed_date:  # type: ignore[operator]
            continue

        incomplete_this_session = False
        # Session-scoped guard: the dead-contract fallback below rolls at
        # most once per session. Without this, an era-wide cache truncation
        # (every enumerated contract missing the same tail) could chain
        # the schedule through 5+ contracts in a single session and land on
        # a far-future thin contract. Capping at 1 advance per silent
        # session keeps the schedule's forward motion bounded.
        dead_fallback_fired_this_session = False
        # Decide whether to roll forward at the start of this session.
        # Rolls only happen when we have a prior session with data and the
        # next contract has more volume on that prior session than the current one.
        if last_session_with_data is not None:
            prior = last_session_with_data
            cur_c = active_contracts[current_idx]
            nxt_idx = _next_contract(active_contracts, current_idx)
            while nxt_idx is not None:
                nxt_c = active_contracts[nxt_idx]
                cur_v = vols[cur_c.raw_symbol].get(prior, 0)
                nxt_v = vols[nxt_c.raw_symbol].get(prior, 0)

                # Standard volume-leadership trigger (the documented
                # "forward-only volume-led roll" methodology — see
                # README "Volume-splice methodology"): roll when next
                # contract's volume on `prior` exceeds current's.
                should_roll = (nxt_v > cur_v and nxt_v > 0)

                # Cache-gap fallback. The standard check above is blind
                # when the daily-volume cache has no entry for nxt on
                # `prior` — `nxt_v` reads as 0, the comparison fails,
                # and the schedule freezes on an expired current
                # contract for the rest of the window. Real-world
                # trigger: the legacy parquet cache for some 1-digit-
                # year symbols (e.g. NGV1) covers only a contract's
                # final week in 2021, missing the prior month when it
                # was actively trading. Without this fallback, `/load`
                # for entries in late-2021 / early-2022 returns 0 bars
                # because the schedule never rolls off the expired NGU1.
                #
                # Both clauses must hold so we don't over-roll on
                # weekends, holidays, or single-session blips:
                #   - cur is silent NOW (vols[cur][d] == 0, i.e. truly
                #     no longer trading on the current session — not
                #     just on `prior`),
                #   - nxt is alive NOW (vols[nxt][d] > 0),
                #   - and at least 5 trading sessions have passed since
                #     `prior` (rules out long weekends, single-day
                #     holidays, and even week-long holiday closures
                #     where both contracts go quiet together).
                #
                # Forward-only is preserved (we still roll to nxt_idx,
                # never back). Spread machinery is unchanged: if the
                # 18:00 ET 1s open is missing for either side (likely
                # for cur if it's expired) the roll is flagged
                # incomplete with spread=0, exactly as today.
                if not should_roll:
                    cur_v_now = vols[cur_c.raw_symbol].get(d, 0)
                    nxt_v_now = vols[nxt_c.raw_symbol].get(d, 0)
                    sessions_since_prior = trade_date_idx[d] - trade_date_idx[prior]
                    if cur_v_now == 0 and nxt_v_now > 0 and sessions_since_prior >= 5:
                        should_roll = True
                        logger.info(
                            "Cache-gap fallback roll for %s on %s: %s → %s "
                            "(cur silent for %d trading sessions since %s, nxt vol=%d on d).",
                            asset, d, cur_c.raw_symbol, nxt_c.raw_symbol,
                            sessions_since_prior, prior, int(nxt_v_now),
                        )
                    elif cur_v_now == 0 and sessions_since_prior >= 5:
                        # Dead-contract fallback: cur silent for ≥5 trading
                        # sessions AND nxt is also silent on `d` (the
                        # existing fallback above didn't fire because it
                        # requires nxt_v_now > 0). This is the era-wide
                        # cache-truncation pathology — multiple consecutive
                        # contracts missing the same daily-volume tail. Roll
                        # once to the next enumerated contract so the
                        # schedule doesn't freeze on an expired front month;
                        # chain protection (break below) caps this at one
                        # contract advance per session so we don't walk
                        # through far-future contracts in a single tick when
                        # an entire decade's cache is contaminated.
                        # Reproduced: NG entry 2012-07-09 with truncated
                        # NGN2/NGQ2/NGU2/.../NGZ2 ohlcv-1d parquets — the
                        # "right" fix is to clear the offending parquets and
                        # let the rolling cache refetch the missing tail
                        # cleanly. This branch keeps replay producing
                        # forward bars when the cache is still broken; the
                        # warning surfaces the underlying issue.
                        should_roll = True
                        dead_fallback_fired_this_session = True
                        logger.warning(
                            "Dead-contract fallback roll for %s on %s: %s → %s "
                            "(cur silent for %d trading sessions since %s; nxt also silent on d). "
                            "Likely truncated daily-volume cache — consider deleting "
                            "server/data_cache/rolling/<dataset>/%s/ohlcv-1d.parquet and "
                            "neighbors to force a clean refetch.",
                            asset, d, cur_c.raw_symbol, nxt_c.raw_symbol,
                            sessions_since_prior, prior, cur_c.raw_symbol,
                        )

                if should_roll:
                    # Roll at start of session d.
                    old_open = _first_1s_open_at_session(client, dataset, cur_c, d)
                    new_open = _first_1s_open_at_session(client, dataset, nxt_c, d)
                    if old_open is None or new_open is None:
                        spread = 0.0
                        incomplete_this_session = True
                        logger.warning(
                            "Incomplete roll for %s on %s: missing 18:00 ET bar (%s old=%s, %s new=%s).",
                            asset, d, cur_c.raw_symbol, old_open, nxt_c.raw_symbol, new_open,
                        )
                    else:
                        spread = new_open - old_open
                    cumulative_spread += spread
                    rolls.append(RollMarker(
                        session_date=d,
                        from_contract=cur_c.raw_symbol,
                        to_contract=nxt_c.raw_symbol,
                        spread=spread,
                        incomplete=incomplete_this_session,
                    ))
                    current_idx = nxt_idx
                    cur_c = nxt_c
                    nxt_idx = _next_contract(active_contracts, current_idx)
                    if dead_fallback_fired_this_session:
                        # Don't chain a dead-contract roll. We have no
                        # evidence the next-next contract is the right
                        # successor — its data is also missing — so further
                        # advancement waits for another 5 silent sessions.
                        break
                    # Allow chained rolls in the same session if volumes warrant it.
                else:
                    break

        # Record this session.
        active_sym = active_contracts[current_idx].raw_symbol
        had_data = vols[active_sym].get(d, 0) > 0
        schedule.append(ScheduleEntry(
            session_date=d,
            active_contract=active_sym,
            cumulative_spread=cumulative_spread,
            incomplete_roll=incomplete_this_session,
        ))
        if had_data:
            last_session_with_data = d

    return SpliceSchedule(asset, window_start, window_end, schedule, rolls)
