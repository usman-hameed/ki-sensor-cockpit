"""The quality station: every part that rests under the sensor becomes one entry of the part log.

It builds on the part check and needs two things taught there: a good part and the empty plate. From then on,
everything that lies on the plate is a part: when it came, how long it stayed, where its top surface is, its
height above the plate and whether it is the taught part. From the first parts the station learns the rhythm of
the line and watches it:

* jam          a part stays far longer than parts usually stay (raised while it is still there)
* double_feed  a part follows the one before much sooner than parts usually follow each other
* trend        the good parts get higher or lower, part by part, towards the edge of the accepted band

How a part is found: the signal is cut into frames of 50 ms. A frame near the taught empty plate is "plate",
anything else with valid readings is "something on the plate". Something that stays for 0.5 s is a part; the
part ends when the plate shows for 0.15 s. Its position is the median of the steady readings of the part check.

A distance sensor sees the top surface only, so two parts of the same height that follow each other without the
plate showing in between look like one part that stays long. The log says what was measured and nothing more.

The log of the current run is kept in backend/data/part_log.jsonl, so a restart does not lose it.
"""

from __future__ import annotations

import json
import logging
import math
import statistics
import threading
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

from .buffer import SensorBuffer
from .config import SensorConfig
from .detection import Event
from .partcheck import WINDOW_S, PartCheck

log = logging.getLogger("cockpit.station")

FRAME_S = 0.05            # the signal is judged in frames of this length (the median of each frame)
FRAME_MIN_VALID = 0.6     # a frame needs this share of valid readings, otherwise it is "no reading"
PRESENT_S = 0.5           # something must lie on the plate this long to count as a part
GONE_S = 0.15             # the plate must show this long to end a part
LOST_S = 3.0              # no valid reading this long also ends a part
GONE_NO_PLATE_S = 0.3     # without a taught plate: no valid reading this long ends a part
CATCH_UP_S = 2.0          # at most this much signal is looked at in one go
LOOK_BACK_S = 1.0         # when the station becomes ready it starts this far back: the part just taught counts
MOVED_UM = 150.0          # a steady surface this far from the part's own is another part
MIN_RHYTHM = 3            # parts before the rhythm is known
RHYTHM_LAST = 20
JAM_S = 6.0               # a jam: a part that stays longer than this ...
JAM_FACTOR = 1.5          # ... and longer than this many usual stays (so slow lines are not always "jammed")
DOUBLE_FEED_GAP_S = 2.0   # a double feed: a part that comes less than this after the one before ...
DOUBLE_FEED_SHARE = 0.5   # ... and sooner than this share of the usual gap (so fast lines are not always flagged)
MIN_GAP_S = 0.8           # no double feed check while the usual gap is shorter than this
TREND_MIN = 8             # good parts before a trend can be judged
TREND_LAST = 20
TREND_MIN_R2 = 0.6
TREND_MIN_CHANGE = 0.3    # the fitted change over those parts must be this share of the band's half width
TREND_HORIZON = 40        # warn when the edge of the band is this many parts away or closer
TREND_CRITICAL = 10
TREND_REPEAT = 15         # parts before the same trend is announced again (sooner when it gets twice as close)
LOG_MAX = 5000
KINDS = ("jam", "double_feed", "trend")


class StationError(ValueError):
    """A request the station cannot fulfil; the message says why."""


@dataclass
class PartRecord:
    number: int
    sensor: str
    t_start: float
    t_end: float
    dwell_s: float
    gap_s: float | None
    position_um: float
    height_um: float | None
    deviation_um: float
    verdict: str                                      # good | different
    flags: list[str] = field(default_factory=list)    # jam, double_feed, unsteady


@dataclass
class _Visit:
    start: float
    frames: list[float]
    steady: list[float] = field(default_factory=list)
    flags: list[str] = field(default_factory=list)
    jam_alerted: bool = False

    @property
    def position(self) -> float | None:
        if self.steady:
            return float(np.median(self.steady))
        return float(np.median(self.frames)) if self.frames else None


@dataclass
class _Line:
    seen: int | None = None               # samples of the buffer already looked at
    visit: _Visit | None = None
    object_since: float | None = None
    object_frames: list[float] = field(default_factory=list)
    plate_since: float | None = None
    lost_since: float | None = None
    last_end: float | None = None
    records: list[PartRecord] = field(default_factory=list)
    next_number: int = 1
    run_started: float | None = None
    trend_alerted_at: int | None = None
    trend_parts_left: float | None = None


class Station:
    def __init__(self, sensors: tuple[SensorConfig, ...], partcheck: PartCheck, path: Path | None = None,
                 on_part: Callable[[str, dict[str, Any]], None] | None = None) -> None:
        self.sensors = {s.id: s for s in sensors}
        self.partcheck = partcheck
        self.path = path
        self.on_part = on_part
        # where the camera picture of a part is, if there is one (set by the engine)
        self.photo_of: Callable[[str, int], str | None] | None = None
        self.lines = {sid: _Line() for sid in self.sensors}
        self._lock = threading.RLock()
        self._ids = 0
        self._load()

    # -- persistence -----------------------------------------------------------

    def _load(self) -> None:
        if self.path is None or not self.path.exists():
            return
        try:
            text = self.path.read_text(encoding="utf-8")
        except OSError as exc:
            log.warning("the part log %s could not be read (%s); starting a new run", self.path, exc)
            return
        skipped = 0
        for raw in text.splitlines():
            if not raw.strip():
                continue
            try:
                item = json.loads(raw)
                line = self.lines.get(item.get("sensor"))
                if line is None:
                    continue
                record = PartRecord(**{k: item[k] for k in PartRecord.__dataclass_fields__})
            except (ValueError, TypeError, KeyError, AttributeError):
                skipped += 1
                continue
            line.records.append(record)
            line.next_number = max(line.next_number, record.number + 1)
            if line.run_started is None:
                line.run_started = record.t_start
        for line in self.lines.values():
            del line.records[:-LOG_MAX]
        if skipped:
            log.warning("the part log %s had %d unreadable lines; they were skipped", self.path, skipped)

    def _append(self, record: PartRecord) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(asdict(record)) + "\n")
        except OSError as exc:
            log.warning("could not write the part log: %s", exc)

    def _rewrite(self) -> None:
        if self.path is None:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            rows = [json.dumps(asdict(r)) for line in self.lines.values() for r in line.records]
            self.path.write_text("".join(f"{row}\n" for row in rows), encoding="utf-8")
        except OSError as exc:
            log.warning("could not write the part log: %s", exc)

    # -- what the station needs ----------------------------------------------------

    def ready(self, sid: str) -> bool:
        track = self.partcheck.tracks.get(sid)
        # the empty plate is optional: when the plate is outside the measuring range nothing valid is measured
        # without a part, and then "no reading" stands for the empty plate
        return bool(track is not None and self.partcheck.supported(sid) and track.reference is not None)

    def new_run(self, sid: str, now: float) -> dict[str, Any]:
        """Start a new run: the part log, the counters and the rhythm start from zero."""
        with self._lock:
            if sid not in self.lines:
                raise StationError(f"unknown sensor {sid!r}")
            old = self.lines[sid]
            self.lines[sid] = _Line(seen=old.seen, run_started=now)
            self._rewrite()
            return self.public(sid, now)

    # -- the rhythm of the line ---------------------------------------------------------

    @staticmethod
    def rhythm(line: _Line) -> dict[str, Any]:
        recent = line.records[-RHYTHM_LAST:]
        dwells = [r.dwell_s for r in recent if "jam" not in r.flags]
        gaps = [r.gap_s for r in recent if r.gap_s is not None and "double_feed" not in r.flags]
        return {"known": len(recent) >= MIN_RHYTHM and len(dwells) >= MIN_RHYTHM - 1,
                "dwell_s": round(statistics.median(dwells), 2) if dwells else None,
                "gap_s": round(statistics.median(gaps), 2) if len(gaps) >= MIN_RHYTHM - 1 else None}

    def _jam_limit(self, line: _Line) -> float | None:
        rhythm = self.rhythm(line)
        if not rhythm["known"] or rhythm["dwell_s"] is None:
            return None
        usual = rhythm["dwell_s"]
        return max(JAM_S, JAM_FACTOR * usual)

    # -- following the parts ----------------------------------------------------------------

    def evaluate(self, buffers: dict[str, SensorBuffer], now: float) -> list[Event]:
        """Called after the part check, which has just measured what lies under each sensor."""
        events: list[Event] = []
        with self._lock:
            for sid, line in self.lines.items():
                buf = buffers.get(sid)
                if buf is None:
                    continue
                if not self.ready(sid):
                    line.seen = max(0, buf.written - int(LOOK_BACK_S * buf.rate_hz))
                    line.visit, line.object_since = None, None
                    line.plate_since = line.lost_since = None
                    continue
                events.extend(self._follow(sid, line, buf, now))
        return events

    def _frames(self, line: _Line, buf: SensorBuffer) -> list[tuple[float, float, float]]:
        """The frames since the last look: (start time, end time, median or NaN)."""
        written = buf.written
        if line.seen is None or written < line.seen:
            line.seen = written
            return []
        size = max(1, int(round(FRAME_S * buf.rate_hz)))
        cap = int(CATCH_UP_S * buf.rate_hz)
        if written - line.seen > cap:
            line.seen = written - cap
        new = written - line.seen
        take = (new // size) * size
        if take == 0 or buf.t_last is None:
            return []
        values = buf.fast.last(new)[:take]
        first_t = buf.t_last - (new - 1) * buf.dt
        line.seen += take
        frames = []
        for i in range(take // size):
            chunk = values[i * size:(i + 1) * size]
            ok = chunk[np.isfinite(chunk)]
            value = float(np.median(ok)) if ok.size >= FRAME_MIN_VALID * size else math.nan
            t0 = first_t + i * size * buf.dt
            frames.append((t0, t0 + size * buf.dt, value))
        return frames

    def _follow(self, sid: str, line: _Line, buf: SensorBuffer, now: float) -> list[Event]:
        track = self.partcheck.tracks[sid]
        ref, empty = track.reference, track.empty_um
        assert ref is not None
        band = self.partcheck.empty_band(track)
        events: list[Event] = []
        closed = False
        for t0, t1, value in self._frames(line, buf):
            if not math.isfinite(value):
                kind = "plate" if empty is None else "none"      # no plate taught: no reading = nothing there
            elif empty is not None and abs(value - empty) <= band:
                kind = "plate"
            else:
                kind = "object"
            if line.visit is None:
                if kind == "object":
                    if line.object_since is None:
                        line.object_since, line.object_frames = t0, []
                    line.object_frames.append(value)
                    if t1 - line.object_since >= PRESENT_S:
                        events.extend(self._open(sid, line, line.object_since, list(line.object_frames)))
                else:
                    line.object_since = None
                continue
            if kind == "object":
                line.visit.frames.append(value)
                del line.visit.frames[:-2000]
                line.plate_since = line.lost_since = None
            elif kind == "plate":
                line.lost_since = None
                line.plate_since = t0 if line.plate_since is None else line.plate_since
                if t1 - line.plate_since >= (GONE_S if empty is not None else GONE_NO_PLATE_S):
                    closed = self._close(sid, line, line.plate_since) or closed
            else:
                line.lost_since = t0 if line.lost_since is None else line.lost_since
                if t1 - line.lost_since >= LOST_S:
                    closed = self._close(sid, line, line.lost_since) or closed

        reading = track.reading
        visit = line.visit
        if visit is not None and reading is not None and reading.steady and reading.position_um is not None \
                and line.plate_since is None and (empty is None or abs(reading.position_um - empty) > band):
            position = reading.position_um
            if len(visit.steady) >= 3 and abs(position - float(np.median(visit.steady))) > max(
                    ref.half_width_um, MOVED_UM):
                # another part took its place without the plate showing in between
                split = max(now - WINDOW_S, visit.start)
                closed = self._close(sid, line, split) or closed
                events.extend(self._open(sid, line, split, [position]))
                assert line.visit is not None
                line.visit.steady.append(position)
            else:
                visit.steady.append(position)
                del visit.steady[:-400]

        visit = line.visit
        limit = self._jam_limit(line)
        if visit is not None and limit is not None and not visit.jam_alerted and now - visit.start > limit:
            visit.jam_alerted = True
            visit.flags.append("jam")
            events.append(self._jam_event(sid, line, visit, now))
        if closed:
            event = self._check_trend(sid, line, now)
            if event is not None:
                events.append(event)
        return events

    def _open(self, sid: str, line: _Line, start: float, frames: list[float]) -> list[Event]:
        line.visit = _Visit(start=start, frames=frames)
        line.object_since, line.object_frames = None, []
        line.plate_since = line.lost_since = None
        if line.run_started is None:
            line.run_started = start
        rhythm = self.rhythm(line)
        if line.last_end is None or not rhythm["known"] or not rhythm["gap_s"] or rhythm["gap_s"] < MIN_GAP_S:
            return []
        gap = start - line.last_end
        if gap >= min(DOUBLE_FEED_GAP_S, DOUBLE_FEED_SHARE * rhythm["gap_s"]):
            return []
        line.visit.flags.append("double_feed")
        return [self._double_feed_event(sid, line, gap, rhythm["gap_s"], start)]

    def _close(self, sid: str, line: _Line, end: float) -> bool:
        visit = line.visit
        line.visit = None
        line.plate_since = line.lost_since = None
        if visit is None:
            return False
        track = self.partcheck.tracks[sid]
        ref = track.reference
        position = visit.position
        if ref is None or position is None:
            return False
        flags = list(visit.flags) + ([] if visit.steady else ["unsteady"])
        verdict = "good" if self.partcheck.classify(track, position) == "match" else "different"
        height = None if track.empty_um is None else track.empty_um - position
        record = PartRecord(
            number=line.next_number, sensor=sid, t_start=round(visit.start, 3), t_end=round(end, 3),
            dwell_s=round(max(end - visit.start, 0.0), 2),
            gap_s=None if line.last_end is None else round(max(visit.start - line.last_end, 0.0), 2),
            position_um=round(position, 1), height_um=None if height is None else round(height, 1),
            deviation_um=round(position - ref.center_um, 1), verdict=verdict, flags=flags)
        line.next_number += 1
        line.last_end = end
        line.records.append(record)
        del line.records[:-LOG_MAX]
        self._append(record)
        if self.on_part is not None:
            try:
                self.on_part(sid, self.record_public(sid, record))
            except Exception:  # noqa: BLE001 - a screen update must never stop the counting
                log.exception("could not announce part %d", record.number)
        return True

    # -- the trend of the good parts ------------------------------------------------------------

    def trend(self, sid: str) -> dict[str, Any] | None:
        line = self.lines[sid]
        ref = self.partcheck.tracks[sid].reference
        good = [r for r in line.records if r.verdict == "good"][-TREND_LAST:]
        if ref is None or len(good) < TREND_MIN:
            return None
        x = np.array([r.number for r in good], dtype=float)
        y = np.array([r.position_um for r in good], dtype=float)
        if np.ptp(x) == 0:
            return None
        slope, intercept = np.polyfit(x, y, 1)
        fit = slope * x + intercept
        total = float(np.sum((y - y.mean()) ** 2))
        r2 = 1.0 - float(np.sum((y - fit) ** 2)) / total if total > 0 else 0.0
        level = float(slope * x[-1] + intercept)
        low, high = ref.center_um - ref.half_width_um, ref.center_um + ref.half_width_um
        if slope > 0:
            parts_left: float | None = max((high - level) / slope, 0.0)
        elif slope < 0:
            parts_left = max((level - low) / -slope, 0.0)
        else:
            parts_left = None
        change = abs(float(slope)) * float(np.ptp(x))
        return {"slope_um_per_part": round(float(slope), 2), "r2": round(r2, 2), "parts": len(good),
                "parts_to_limit": None if parts_left is None else round(parts_left, 1),
                # a position that grows is a top surface farther from the sensor: the parts get lower
                "direction": "lower" if slope > 0 else "higher",
                "clear": r2 >= TREND_MIN_R2 and change >= TREND_MIN_CHANGE * ref.half_width_um}

    def _check_trend(self, sid: str, line: _Line, now: float) -> Event | None:
        if not line.records or line.records[-1].verdict != "good":
            return None
        info = self.trend(sid)
        if info is None or not info["clear"] or info["parts_to_limit"] is None \
                or info["parts_to_limit"] > TREND_HORIZON:
            return None
        count = len(line.records)
        if line.trend_alerted_at is not None and count - line.trend_alerted_at < TREND_REPEAT and not (
                line.trend_parts_left and info["parts_to_limit"] < line.trend_parts_left / 2):
            return None
        line.trend_alerted_at, line.trend_parts_left = count, info["parts_to_limit"]
        return self._trend_event(sid, info, now)

    # -- the alerts ------------------------------------------------------------------------------

    def _new_id(self, now: float) -> str:
        self._ids += 1
        return f"ev-{int(now) % 100000}-q{self._ids}"

    def _jam_event(self, sid: str, line: _Line, visit: _Visit, now: float) -> Event:
        cfg = self.sensors[sid]
        stay = now - visit.start
        usual = self.rhythm(line)["dwell_s"] or 0.0
        return Event(
            id=self._new_id(now), sensor=sid, kind="jam", severity="warning", t=now,
            numbers={"stay_s": round(stay, 1), "usual_stay_s": round(usual, 1), "part": line.next_number},
            summary=(f"Possible jam at {cfg.name}: part {line.next_number} has been under the sensor for "
                     f"{stay:.0f} s, parts usually stay {usual:.1f} s."))

    def _double_feed_event(self, sid: str, line: _Line, gap: float, usual_gap: float, now: float) -> Event:
        cfg = self.sensors[sid]
        return Event(
            id=self._new_id(now), sensor=sid, kind="double_feed", severity="warning", t=now,
            numbers={"gap_s": round(gap, 2), "usual_gap_s": round(usual_gap, 2), "part": line.next_number},
            summary=(f"Possible double feed at {cfg.name}: part {line.next_number} came {gap:.1f} s after the one "
                     f"before, parts usually come {usual_gap:.1f} s apart."))

    def _trend_event(self, sid: str, info: dict[str, Any], now: float) -> Event:
        cfg = self.sensors[sid]
        left = info["parts_to_limit"]
        per_part = f"{abs(info['slope_um_per_part']):.1f} µm"      # the station works on sensors in µm only
        return Event(
            id=self._new_id(now), sensor=sid, kind="trend", severity="critical" if left <= TREND_CRITICAL
            else "warning", t=now,
            numbers={"slope_um_per_part": info["slope_um_per_part"], "parts_to_limit": left,
                     "trend_parts": info["parts"], "r2": info["r2"]},
            summary=(f"Height trend at {cfg.name}: the good parts get {info['direction']} by {per_part} per part. "
                     f"At this rate they leave the accepted band in about {left:.0f} part{'' if round(left) == 1 else 's'}. A worn tool or a "
                     f"fixture that moves can do this."))

    def active_kinds(self, sid: str) -> list[str]:
        line = self.lines.get(sid)
        return ["jam"] if line is not None and line.visit is not None and line.visit.jam_alerted else []

    # -- what the screen and the copilot see ------------------------------------------------------

    def record_public(self, sid: str, record: PartRecord) -> dict[str, Any]:
        cfg = self.sensors[sid]
        data = asdict(record)
        data["position"] = cfg.pos(record.position_um, signed=False)
        data["height"] = None if record.height_um is None else cfg.pos(record.height_um, signed=False)
        data["photo"] = self.photo_of(sid, record.number) if self.photo_of else None
        return data

    def public(self, sid: str, now: float, limit: int = 0) -> dict[str, Any]:
        with self._lock:
            line = self.lines[sid]
            records = line.records
            good = sum(1 for r in records if r.verdict == "good")
            recent = [r for r in records if r.t_end >= now - 300.0]
            span = now - recent[0].t_start if recent else 0.0
            per_minute = round(len(recent) / span * 60.0, 1) if len(recent) >= 2 and span > 0 else None
            ready = self.ready(sid)
            if not self.partcheck.supported(sid):
                message = "The quality station needs a sensor that reports micrometres."
            elif not ready:
                message = ("Teach a good part in the part check (and the empty plate, if the sensor can see it): "
                           "then every part that rests under the sensor is counted.")
            elif not records and line.visit is None:
                message = "Ready: every part that rests under the sensor is counted and measured."
            else:
                message = f"{len(records)} parts, {good} of them the taught part."
            current = None
            if line.visit is not None:
                position = line.visit.position
                current = {"number": line.next_number, "since_s": round(max(now - line.visit.start, 0.0), 1),
                           "position_um": None if position is None else round(position, 1),
                           "flags": list(line.visit.flags)}
            data: dict[str, Any] = {
                "ready": ready, "message": message,
                "parts": len(records), "good": good, "different": len(records) - good,
                "jams": sum(1 for r in records if "jam" in r.flags),
                "double_feeds": sum(1 for r in records if "double_feed" in r.flags),
                "yield_percent": round(100.0 * good / len(records), 1) if records else None,
                "per_minute": per_minute, "rhythm": self.rhythm(line), "trend": self.trend(sid),
                "current": current, "run_started": line.run_started,
                "last": self.record_public(sid, records[-1]) if records else None,
            }
            if limit:
                data["records"] = [self.record_public(sid, r) for r in records[-limit:]][::-1]
            return data

    def records(self, sid: str, limit: int = LOG_MAX) -> list[PartRecord]:
        with self._lock:
            return list(self.lines[sid].records[-limit:])
