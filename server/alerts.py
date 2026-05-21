"""Server-side alert manager: evaluate rank thresholds on live forming
timeframe bars and fire WebSocket-broadcast notifications when crossed.

Architecture
------------
For each registered alert (asset, metric, op, threshold, tf, lookback) we
maintain a "forming TF bar" — incrementally updated from each finalized 1s
bar that arrives via LiveAssetManager. Whenever the forming bar updates we
look up the current rank value (using the same per-bucket distribution data
that the frontend's rank engine uses), and if the threshold is crossed we
fire the alert via a broadcast callback. Each alert fires at most once per
TF bucket — the bucket-advance event re-arms it.

Rank evaluation here is a Python port of the algorithm in js/rank-engine.js
so server-side and client-side displays agree to the percent.
"""
from __future__ import annotations

import bisect
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from uuid import uuid4
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)
ET = ZoneInfo("America/New_York")
UTC = timezone.utc

VALID_METRICS = ("vol", "vol_pending", "range", "range_pending")
VALID_OPS = (">=", "<=")


def _floor_to_tf(unix_sec: int, tf_min: int) -> int:
    """ET-anchored timeframe floor — mirrors js/time-utils.js floorToTimeframe."""
    et = datetime.fromtimestamp(unix_sec, tz=UTC).astimezone(ET)
    if tf_min == 1440:
        anchor = et.replace(hour=18, minute=0, second=0, microsecond=0)
        if et.hour < 18:
            anchor = anchor - timedelta(days=1)
        return int(anchor.timestamp())
    midnight = et.replace(hour=0, minute=0, second=0, microsecond=0)
    elapsed = int((et - midnight).total_seconds())
    bucket_sec = tf_min * 60
    floored = (elapsed // bucket_sec) * bucket_sec
    return int((midnight + timedelta(seconds=floored)).timestamp())


def _unix_to_et_hhmm(unix_sec: int) -> str:
    et = datetime.fromtimestamp(unix_sec, tz=UTC).astimezone(ET)
    return f"{et.hour:02d}:{et.minute:02d}"


def _percentile_rank(sorted_arr, value) -> float:
    if not sorted_arr:
        return 0.0
    idx = bisect.bisect_right(sorted_arr, value)
    return (idx / len(sorted_arr)) * 100.0


def _median(sorted_arr) -> float:
    n = len(sorted_arr)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2 == 1:
        return float(sorted_arr[mid])
    return (sorted_arr[mid - 1] + sorted_arr[mid]) / 2.0


def _estimate(current: float, p: float, profile, median: float) -> float:
    if not profile or len(profile) < 2:
        return current
    if p <= 0:
        return median
    if p >= 1:
        return current
    last = len(profile) - 1
    idx_f = p * last
    idx_lo = int(idx_f)
    idx_hi = min(idx_lo + 1, last)
    w = idx_f - idx_lo
    f = profile[idx_lo] * (1 - w) + profile[idx_hi] * w
    if f <= 0.001:
        return median
    estimate = current / f
    if p < 0.10:
        alpha = p / 0.10
        estimate = alpha * estimate + (1 - alpha) * median
    return estimate


class _FormingTfBar:
    """Aggregates incoming 1s bars into a forming TF bar."""

    __slots__ = ("tf_min", "bucket_time", "high", "low", "volume", "last_t")

    def __init__(self, tf_min: int):
        self.tf_min = tf_min
        self.bucket_time: Optional[int] = None
        self.high = 0.0
        self.low = 0.0
        self.volume = 0
        self.last_t = 0

    def feed(self, bar_1s: dict) -> bool:
        """Update with a finalized 1s bar. Return True if the TF bucket advanced."""
        t = int(bar_1s["t"])
        bucket = _floor_to_tf(t, self.tf_min)
        advanced = False
        if self.bucket_time != bucket:
            self.bucket_time = bucket
            self.high = float(bar_1s["h"])
            self.low = float(bar_1s["l"])
            self.volume = int(bar_1s.get("v") or 0)
            advanced = True
        else:
            self.high = max(self.high, float(bar_1s["h"]))
            self.low = min(self.low, float(bar_1s["l"]))
            self.volume += int(bar_1s.get("v") or 0)
        self.last_t = t
        return advanced


class _Alert:
    __slots__ = ("id", "asset", "metric", "op", "threshold", "tf", "lookback",
                 "forming", "last_was_crossed", "last_value", "last_eval_time",
                 "last_fired_time", "fire_count")

    def __init__(self, alert_id: str, asset: str, metric: str, op: str,
                 threshold: float, tf: int, lookback: int):
        self.id = alert_id
        self.asset = asset
        self.metric = metric
        self.op = op
        self.threshold = float(threshold)
        self.tf = tf
        self.lookback = lookback
        self.forming = _FormingTfBar(tf)
        # Rising-edge tracking: fire when crossed transitions from False→True.
        # Resets when the TF bucket advances so each new bar can fire afresh.
        self.last_was_crossed = False
        # Diagnostic: latest computed metric value + timestamp + fire count.
        # Exposed via /alerts so the frontend can show "armed @ 47%, threshold
        # 80%" — confirming the alert is evaluating but the condition isn't
        # met, vs. silently broken.
        self.last_value: Optional[float] = None
        self.last_eval_time: Optional[int] = None
        self.last_fired_time: Optional[int] = None
        self.fire_count: int = 0

    def to_dict(self) -> dict:
        return {
            "id": self.id, "asset": self.asset, "metric": self.metric,
            "op": self.op, "threshold": self.threshold, "tf": self.tf,
            "lookback": self.lookback,
            "last_value": self.last_value,
            "last_eval_time": self.last_eval_time,
            "last_fired_time": self.last_fired_time,
            "fire_count": self.fire_count,
        }


class AlertManager:
    """Owns the set of registered alerts and evaluates them on each finalized
    1s bar. Thread-safe — `on_finalized_bar` is called from the Databento
    worker thread."""

    def __init__(self):
        self._alerts: dict[str, _Alert] = {}
        self._lock = threading.Lock()
        # rank_data_loader(asset, tf, lookback) -> dict | None  (caller-provided,
        # typically loads from /ranks cache).
        self._rank_data_loader: Optional[Callable[[str, int, int], Optional[dict]]] = None
        self._rank_cache: dict[tuple, Optional[dict]] = {}
        # (asset, tf, lookback) tuples whose rank data is currently being
        # loaded by a background thread. Read/written under self._lock so
        # "check then mark" is atomic and we don't dispatch duplicate loads
        # when several alerts for the same key are registered simultaneously.
        self._loading: set[tuple] = set()
        # broadcast(payload) → fans out to every WS client's queue.
        self._broadcast: Optional[Callable[[dict], None]] = None
        # bar_backfill(asset) → list of finalized 1s bar dicts (oldest→newest).
        # Used to seed a new alert's forming bar with the in-progress bucket
        # so an alert created mid-bucket is accurate immediately.
        self._bar_backfill: Optional[Callable[[str], list]] = None

    def set_rank_loader(self, loader) -> None:
        self._rank_data_loader = loader

    def set_broadcast(self, broadcast) -> None:
        self._broadcast = broadcast

    def set_bar_backfill(self, backfill) -> None:
        self._bar_backfill = backfill

    def register(self, asset: str, metric: str, op: str, threshold: float,
                 tf: int, lookback: int) -> dict:
        if metric not in VALID_METRICS:
            raise ValueError(f"metric must be one of {VALID_METRICS}")
        if op not in VALID_OPS:
            raise ValueError(f"op must be one of {VALID_OPS}")
        if not (0 <= float(threshold) <= 100):
            raise ValueError("threshold must be 0..100")
        alert_id = uuid4().hex[:12]
        alert = _Alert(alert_id, asset, metric, op, threshold, tf, lookback)
        # Seed the forming bar from the in-progress TF bucket BEFORE the
        # alert is published to _alerts, so the live worker thread's
        # on_finalized_bar cannot mutate alert.forming while it is being
        # seeded. Without this, an alert created mid-bucket accumulates
        # volume/range only from trades seen AFTER registration — badly
        # under-counting the bucket (volume scales ~linearly with elapsed
        # time) until the next bucket boundary self-corrects it.
        self._backfill_forming(alert)
        with self._lock:
            self._alerts[alert_id] = alert
        # Kick the rank load into a background thread so the HTTP response
        # returns immediately. A cold (asset, tf, lookback) build can take
        # 60-120s on a fresh process — synchronously waiting was making
        # "Add Alert" appear to hang. The eval path correctly skips when
        # _rank_cache.get(key) is None, so the alert quietly waits until
        # background load completes; the chip's last_value populates on the
        # next 5s poll after the first finalized 1s bar evaluates.
        self._kick_rank_load(asset, tf, lookback)
        logger.info("Alert registered id=%s %s %s %s %.1f tf=%dm lookback=%dd",
                    alert_id, asset, metric, op, threshold, tf, lookback)
        return alert.to_dict()

    def remove(self, alert_id: str) -> bool:
        with self._lock:
            return self._alerts.pop(alert_id, None) is not None

    def clear(self) -> int:
        """Remove every registered alert. Returns the number removed."""
        with self._lock:
            n = len(self._alerts)
            self._alerts.clear()
        return n

    def list(self) -> list[dict]:
        with self._lock:
            return [a.to_dict() for a in self._alerts.values()]

    def _ensure_rank_data(self, asset: str, tf: int, lookback: int) -> Optional[dict]:
        """Synchronous load. Kept for callers that explicitly need to block —
        no current users (register() now backgrounds via _kick_rank_load).
        """
        key = (asset, tf, lookback)
        if key in self._rank_cache:
            return self._rank_cache[key]
        if self._rank_data_loader is None:
            return None
        try:
            data = self._rank_data_loader(asset, tf, lookback)
        except Exception as e:
            logger.warning("rank_data_loader failed for %s: %s", key, e)
            data = None
        self._rank_cache[key] = data
        return data

    def _kick_rank_load(self, asset: str, tf: int, lookback: int) -> None:
        """Spawn a background daemon thread to populate _rank_cache for this
        (asset, tf, lookback). Idempotent: skips if already cached or already
        being loaded by another thread."""
        if self._rank_data_loader is None:
            return
        key = (asset, tf, lookback)
        with self._lock:
            if key in self._rank_cache or key in self._loading:
                return
            self._loading.add(key)
        threading.Thread(
            target=self._background_rank_load,
            args=(asset, tf, lookback),
            name=f"alert-rank-load-{asset}-{tf}m",
            daemon=True,
        ).start()

    def _background_rank_load(self, asset: str, tf: int, lookback: int) -> None:
        key = (asset, tf, lookback)
        try:
            data = self._rank_data_loader(asset, tf, lookback)
        except Exception as e:
            logger.warning("background rank load failed for %s: %s", key, e)
            data = None
        with self._lock:
            self._rank_cache[key] = data
            self._loading.discard(key)
        logger.info("alert rank load: %s tf=%dm lookback=%dd → %s",
                    asset, tf, lookback,
                    "ok" if data else "no data")

    def _backfill_forming(self, alert: _Alert) -> None:
        """Pre-fill alert.forming with the current TF bucket's already-seen
        1s bars so an alert registered mid-bucket reflects the whole bucket.
        Only the in-progress bucket is replayed (cheap — at most one TF bar
        of 1s bars); earlier history does not affect the forming bar. Any
        failure degrades safely to the old behavior (no seeding)."""
        if self._bar_backfill is None:
            return
        try:
            bars = self._bar_backfill(alert.asset)
        except Exception as e:
            logger.warning("alert backfill fetch failed for %s: %s", alert.asset, e)
            return
        if not bars:
            return
        try:
            cutoff = _floor_to_tf(int(bars[-1]["t"]), alert.tf)
            for b in bars:
                if int(b["t"]) >= cutoff:
                    alert.forming.feed(b)
        except Exception as e:
            logger.warning("alert backfill replay failed for %s: %s", alert.asset, e)

    def on_finalized_bar(self, asset: str, bar_1s: dict) -> None:
        """Called from the live worker thread on every final 1s bar."""
        with self._lock:
            alerts_for_asset = [a for a in self._alerts.values() if a.asset == asset]
        for alert in alerts_for_asset:
            try:
                self._evaluate(alert, bar_1s)
            except Exception as e:
                logger.warning("Alert %s eval error: %s", alert.id, e)

    def _evaluate(self, alert: _Alert, bar_1s: dict) -> None:
        advanced = alert.forming.feed(bar_1s)
        if alert.forming.bucket_time is None:
            return

        # New TF bar starts fresh — re-arm the rising-edge detector so the
        # first cross within the new bar fires.
        if advanced:
            alert.last_was_crossed = False

        # Look up cached rank data only — do NOT lazy-load here. A cold
        # rank build can take minutes and would stall the worker thread,
        # blocking ALL alerts (and bar dispatch). Eager load happens at
        # register() time on the HTTP handler's thread.
        rank_data = self._rank_cache.get((alert.asset, alert.tf, alert.lookback))
        alert.last_eval_time = int(time.time())
        if not rank_data:
            return
        bucket_key = _unix_to_et_hhmm(alert.forming.bucket_time)
        bucket = (rank_data.get("buckets") or {}).get(bucket_key)
        if not bucket:
            return

        current_vol = alert.forming.volume
        current_range = max(0.0, alert.forming.high - alert.forming.low)
        bar_dur = alert.tf * 60
        elapsed = max(0, min(bar_dur, alert.forming.last_t - alert.forming.bucket_time))
        p = (elapsed / bar_dur) if bar_dur > 0 else 1.0

        if alert.metric == "vol":
            value = _percentile_rank(bucket["volumes"], current_vol)
        elif alert.metric == "range":
            value = _percentile_rank(bucket["ranges"], current_range)
        elif alert.metric == "vol_pending":
            med = _median(bucket["volumes"])
            est = _estimate(current_vol, p, bucket.get("vol_profile") or [], med)
            value = _percentile_rank(bucket["volumes"], est)
        elif alert.metric == "range_pending":
            med = _median(bucket["ranges"])
            est = _estimate(current_range, p, bucket.get("range_profile") or [], med)
            value = _percentile_rank(bucket["ranges"], est)
        else:
            return

        alert.last_value = round(value, 1)

        crossed = (alert.op == ">=" and value >= alert.threshold) or \
                  (alert.op == "<=" and value <= alert.threshold)
        # Rising-edge fire: only when crossed transitions False→True. This
        # handles re-firing within the same TF bar if the value dips below
        # the threshold and crosses back up, AND fires the first time a new
        # bar's value crosses the threshold (because last_was_crossed was
        # reset on bar advance above).
        fire = crossed and not alert.last_was_crossed
        alert.last_was_crossed = crossed
        if not fire:
            return

        alert.last_fired_time = alert.last_eval_time
        alert.fire_count += 1
        payload = {
            "type": "alert",
            "alert_id": alert.id,
            "asset": alert.asset,
            "metric": alert.metric,
            "op": alert.op,
            "threshold": alert.threshold,
            "value": round(value, 1),
            "tf": alert.tf,
            "bar_time": alert.forming.bucket_time,
            "bucket_key": bucket_key,
            "fire_count": alert.fire_count,
        }
        logger.info("Alert FIRED: %s", payload)
        if self._broadcast is not None:
            try:
                self._broadcast(payload)
            except Exception as e:
                logger.warning("Alert broadcast failed: %s", e)
