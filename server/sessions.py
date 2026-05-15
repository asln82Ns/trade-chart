"""CME Globex session helpers.

A trade-date session for date D runs from 18:00 ET on (D-1) to 17:00 ET on D,
with a 1-hour break 17:00-18:00 ET. Saturday has no session; Sunday's 18:00 ET
open is the start of Monday's trade-date session.

We treat every weekday as a candidate trade date and let missing data filter
out holidays naturally.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
UTC = timezone.utc

SESSION_OPEN_HOUR_ET = 18  # 6pm ET previous day
SESSION_CLOSE_HOUR_ET = 17  # 5pm ET trade date


def session_open_utc(trade_date: date) -> datetime:
    """UTC instant of the 18:00 ET session open (on trade_date - 1)."""
    prev = trade_date - timedelta(days=1)
    et_dt = datetime(prev.year, prev.month, prev.day, SESSION_OPEN_HOUR_ET, 0, 0, tzinfo=ET)
    return et_dt.astimezone(UTC)


def session_close_utc(trade_date: date) -> datetime:
    """UTC instant of the 17:00 ET session close (on trade_date)."""
    et_dt = datetime(trade_date.year, trade_date.month, trade_date.day, SESSION_CLOSE_HOUR_ET, 0, 0, tzinfo=ET)
    return et_dt.astimezone(UTC)


def trade_dates_in_range(start: date, end: date) -> list[date]:
    """Inclusive list of weekday trade dates between start and end."""
    if start > end:
        return []
    out = []
    cur = start
    while cur <= end:
        if cur.weekday() < 5:  # Mon=0 .. Fri=4
            out.append(cur)
        cur += timedelta(days=1)
    return out


def trade_date_for_instant(instant: datetime) -> date:
    """Return the CME trade date that contains the given UTC instant.

    If instant falls before 18:00 ET on a weekday, the trade date is that day.
    If instant falls at or after 18:00 ET, the trade date is the next weekday.
    """
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=UTC)
    et = instant.astimezone(ET)
    if et.hour >= SESSION_OPEN_HOUR_ET:
        # After 18:00 ET → next weekday's session
        candidate = et.date() + timedelta(days=1)
    else:
        candidate = et.date()
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def add_trade_dates(trade_date: date, n: int) -> date:
    """Move n weekdays forward (n>0) or backward (n<0) from trade_date."""
    step = 1 if n >= 0 else -1
    cur = trade_date
    remaining = abs(n)
    while remaining > 0:
        cur += timedelta(days=step)
        if cur.weekday() < 5:
            remaining -= 1
    return cur
