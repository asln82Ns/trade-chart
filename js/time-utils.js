// ET formatting + timeframe-aligned bar flooring.
//
// Lightweight Charts wants times as unix-seconds. Internally everything stays
// in unix-seconds (UTC). We only format ET for display.
//
// Timeframe flooring is anchored to ET wall-clock. e.g. 90-minute bars align
// to 18:00, 19:30, 21:00, ... ET regardless of DST.

const ET_OFFSET_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
});

const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

const ET_LABEL_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

const ET_LABEL_FORMATTER_SEC = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
});

const ET_DATEONLY_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

const ET_HHMM_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
});

function etOffsetMinutes(unixSec) {
    // Returns ET offset in minutes (negative for west of UTC: -300 in winter, -240 in summer).
    const parts = ET_OFFSET_FORMATTER.formatToParts(new Date(unixSec * 1000));
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    if (!tzPart) return -300;
    const m = tzPart.value.match(/GMT([+-]?\d+)(?::(\d+))?/);
    if (!m) return -300;
    const hours = parseInt(m[1], 10);
    const mins = m[2] ? parseInt(m[2], 10) : 0;
    return hours * 60 + (hours < 0 ? -mins : mins);
}

/** Floor a unix-second timestamp to the start of its timeframe-min bucket, ET-aligned.
 *  Sub-daily timeframes anchor to ET midnight; the 1D timeframe anchors to the
 *  18:00 ET CME session open so daily bars line up with the trading session. */
export function floorToTimeframe(unixSec, timeframeMin) {
    const offsetMin = etOffsetMinutes(unixSec);
    const etUnix = unixSec + offsetMin * 60;
    if (timeframeMin === 1440) {
        const SESSION_OPEN = 18 * 3600;
        const flooredEt = Math.floor((etUnix - SESSION_OPEN) / 86400) * 86400 + SESSION_OPEN;
        return flooredEt - offsetMin * 60;
    }
    const bucketSec = timeframeMin * 60;
    const flooredEt = Math.floor(etUnix / bucketSec) * bucketSec;
    return flooredEt - offsetMin * 60;
}

export function formatEt(unixSec, opts = {}) {
    const date = new Date(unixSec * 1000);
    if (opts.label) {
        const fmt = opts.withSeconds ? ET_LABEL_FORMATTER_SEC : ET_LABEL_FORMATTER;
        return fmt.format(date) + ' ET';
    }
    const parts = ET_DATE_FORMATTER.formatToParts(date);
    const get = (t) => parts.find(p => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ET`;
}

export function formatEtTickMark(unixSec) {
    return ET_LABEL_FORMATTER.format(new Date(unixSec * 1000));
}

/** Bucket key: ET wall-clock "HH:MM" of the bar open. Mirrors server/ranks.unix_to_et_hhmm. */
export function formatEtHHMM(unixSec) {
    const parts = ET_HHMM_FORMATTER.formatToParts(new Date(unixSec * 1000));
    let h = parts.find(p => p.type === 'hour')?.value ?? '00';
    const m = parts.find(p => p.type === 'minute')?.value ?? '00';
    if (h === '24') h = '00';  // some Intl impls return "24:00" for midnight
    return `${h}:${m}`;
}

/** YYYY-MM-DD in ET. */
export function etDateString(unixSec) {
    const parts = ET_DATEONLY_FORMATTER.formatToParts(new Date(unixSec * 1000));
    const get = (t) => parts.find(p => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Newest weather-forecast issuance date a bar at `unixSec` could have seen.
 *
 *  GEFS/GFS reforecast is a once-daily 00Z-init run; the run initialized at
 *  00:00 UTC on date D finishes operational dissemination ~04–06Z. We use a
 *  conservative 06:00 UTC availability cutoff: a bar at UTC instant T may
 *  only see the run for the UTC date of (T − 6h). 06:00 UTC = 02:00 ET in
 *  summer (EDT) / 01:00 ET in winter (EST); defining the cutoff in UTC keeps
 *  it DST-stable. This prevents the overnight-Globex hindsight leak — a
 *  session's pre-dawn bars must not display that day's forecast before it
 *  was actually published. Returns "YYYY-MM-DD" (UTC).
 *  See docs/weather-data-spec.md §7. */
export const WEATHER_ISSUANCE_CUTOFF_SEC = 6 * 3600;
export function weatherIssuanceDate(unixSec) {
    const d = new Date((unixSec - WEATHER_ISSUANCE_CUTOFF_SEC) * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Convert a "YYYY-MM-DDTHH:MM" local-ET string to a unix-second UTC timestamp. */
export function etLocalStringToUnix(localStr) {
    if (!localStr) return null;
    // Treat as if UTC, then adjust by the ET offset for that instant.
    // We need to iterate once to converge across DST boundaries.
    const fakeUtcMs = Date.parse(localStr.length === 16 ? localStr + ':00Z' : localStr + 'Z');
    if (Number.isNaN(fakeUtcMs)) return null;
    let unixSec = Math.floor(fakeUtcMs / 1000);
    const offsetMin = etOffsetMinutes(unixSec);
    unixSec -= offsetMin * 60;
    // One more pass in case the original instant is on the other side of a DST boundary.
    const offsetMin2 = etOffsetMinutes(unixSec);
    if (offsetMin2 !== offsetMin) {
        unixSec += offsetMin * 60;
        unixSec -= offsetMin2 * 60;
    }
    return unixSec;
}

export const TIMEFRAMES = [
    { value: 1, label: '1m' },
    { value: 5, label: '5m' },
    { value: 15, label: '15m' },
    { value: 30, label: '30m' },
    { value: 60, label: '1h' },
    { value: 90, label: '90m' },
    { value: 180, label: '3h' },
    { value: 240, label: '4h' },
    { value: 1440, label: '1D' },
];
