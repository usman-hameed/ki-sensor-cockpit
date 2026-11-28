"""Charts of the part log of the quality station: here every value is one part, not one reading.

* parts         the height of every part in the order they came, with the band of the taught part and the trend
* part_counts   good and different parts per minute, 10 minutes or hour (a bar chart)
* part_heights  how the heights of the parts are spread (a histogram of parts)

Like the other charts, each result carries ``insights``: the steps the cockpit walks through when asked to
explain the chart, with every number computed here.
"""

from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Any

import numpy as np

from .config import SensorConfig
from .engine import Engine
from .insights import fmt, step
from .station import TREND_LAST, TREND_MIN, PartRecord

GROUPS = {"minute": 60.0, "10min": 600.0, "hour": 3600.0}
MAX_POINTS = 500


def _length(cfg: SensorConfig, value: float) -> str:
    """A height or a distance for speech: 6.012 mm on a sensor shown in millimetres, 12.5 µm otherwise."""
    if cfg.display is not None:
        return cfg.display.text(value, 3)
    return f"{value:.1f} {cfg.unit}"


def _records(engine: Engine, sid: str, window_s: float | None) -> list[PartRecord]:
    records = engine.station.records(sid)
    if window_s:
        since = time.time() - window_s
        records = [r for r in records if r.t_end >= since]
    return [r for r in records if r.height_um is not None]


def _band(engine: Engine, sid: str) -> tuple[float | None, dict[str, float] | None, float | None]:
    """Height of the taught part, the band of accepted heights and its half width."""
    track = engine.partcheck.tracks.get(sid)
    if track is None or track.reference is None or track.empty_um is None:
        return None, None, None
    ref = track.reference
    height = track.empty_um - ref.center_um
    return height, {"low": round(height - ref.half_width_um, 1), "high": round(height + ref.half_width_um, 1)}, \
        ref.half_width_um


def _scope(window_s: float | None, records: list[PartRecord]) -> str:
    if window_s:
        minutes = window_s / 60.0
        return f"in the last {fmt(minutes, 0)} minutes" if minutes >= 2 else f"in the last {window_s:.0f} seconds"
    return "in this run" if records else ""


def _empty(view: str, engine: Engine, sid: str, window_s: float | None) -> dict[str, Any]:
    cfg = engine.settings.sensor(sid)
    ready = engine.station.ready(sid)
    text = ("No parts yet. Put parts under the sensor one after the other: each one is counted when it leaves."
            if ready else "No parts yet. Teach the empty plate and a good part in the part check first.")
    return {"view": view, "sensor": sid, "name": cfg.name, "unit": cfg.unit,
            "display": cfg.display.as_dict() if cfg.display else None, "window_s": window_s,
            "insights": [step(text, None)]}


def parts(engine: Engine, sid: str, window_s: float | None = None) -> dict[str, Any]:
    records = _records(engine, sid, window_s)[-MAX_POINTS:]
    if not records:
        return {**_empty("parts", engine, sid, window_s), "parts": [], "band": None, "reference_um": None,
                "trend": None, "counts": {"parts": 0, "good": 0, "different": 0}}
    cfg = engine.settings.sensor(sid)
    ref_height, band, half_width = _band(engine, sid)
    good = [r for r in records if r.verdict == "good"]
    different = [r for r in records if r.verdict == "different"]
    steps = [step(f"Each dot is one part: {len(records)} parts {_scope(window_s, records)}, {len(good)} of them the "
                  f"taught part ({fmt(100.0 * len(good) / len(records), 0)}%).", None)]
    if band is not None and ref_height is not None and half_width is not None:
        steps.append(step(f"The band is the taught part: {_length(cfg, ref_height)} high, give or take "
                          f"{_length(cfg, half_width)}. A dot inside it is a good part.",
                          {"type": "yspan", "y0": band["low"], "y1": band["high"], "label": "taught part"}))
    if good:
        heights = [r.height_um for r in good if r.height_um is not None]
        spread = max(heights) - min(heights)
        steps.append(step(f"The good parts were between {_length(cfg, min(heights))} and "
                          f"{_length(cfg, max(heights))} high, a spread of {fmt(spread, 1)} µm.", None))
    if different and ref_height is not None:
        worst = max(different, key=lambda r: abs((r.height_um or 0.0) - ref_height))
        off = (worst.height_um or 0.0) - ref_height
        steps.append(step(f"{len(different)} {'part was' if len(different) == 1 else 'parts were'} different. The "
                          f"farthest off was part {worst.number}: {_length(cfg, worst.height_um or 0.0)} high, "
                          f"{_length(cfg, abs(off))} {'higher' if off > 0 else 'lower'} than the taught part.",
                          {"type": "point", "x": worst.number, "y": worst.height_um,
                           "label": f"part {worst.number}"}))
    trend = None
    info = engine.station.trend(sid)
    recent_good = good[-TREND_LAST:]
    if info is not None and len(recent_good) >= TREND_MIN:
        x = np.array([r.number for r in recent_good], dtype=float)
        y = np.array([r.height_um for r in recent_good], dtype=float)
        slope, intercept = np.polyfit(x, y, 1)
        trend = {"x0": float(x[0]), "y0": round(float(slope * x[0] + intercept), 1),
                 "x1": float(x[-1]), "y1": round(float(slope * x[-1] + intercept), 1),
                 "um_per_part": round(float(slope), 2), "clear": bool(info["clear"]),
                 "parts_to_limit": info["parts_to_limit"]}
        if info["clear"]:
            left = info["parts_to_limit"]
            ahead = (f" At this rate they leave the band in about {left:.0f} part{'' if round(left) == 1 else 's'}." if left is not None
                     else "")
            steps.append(step(f"The good parts get {'higher' if slope > 0 else 'lower'} by "
                              f"{fmt(abs(float(slope)), 1)} µm per part.{ahead}",
                              {"type": "line", "x0": trend["x0"], "y0": trend["y0"], "x1": trend["x1"],
                               "y1": trend["y1"], "label": "trend"}))
        else:
            steps.append(step("The heights of the good parts show no trend: they scatter around the same value.",
                              None))
    return {
        "view": "parts", "sensor": sid, "name": cfg.name, "unit": cfg.unit,
        "display": cfg.display.as_dict() if cfg.display else None, "window_s": window_s,
        "parts": [{"number": r.number, "height_um": r.height_um, "verdict": r.verdict, "t": r.t_end,
                   "dwell_s": r.dwell_s, "flags": r.flags} for r in records],
        "band": band, "reference_um": None if ref_height is None else round(ref_height, 1), "trend": trend,
        "counts": {"parts": len(records), "good": len(good), "different": len(different)},
        "insights": steps,
    }


def part_counts(engine: Engine, sid: str, window_s: float | None = None,
                group_by: str | None = None) -> dict[str, Any]:
    records = _records(engine, sid, window_s)
    if not records:
        return {**_empty("part_counts", engine, sid, window_s), "group_by": group_by or "minute",
                "categories": [], "good": [], "different": []}
    cfg = engine.settings.sensor(sid)
    now = time.time()
    span = now - records[0].t_end
    if group_by not in GROUPS:
        group_by = "minute" if span <= 20 * 60 else "10min" if span <= 4 * 3600 else "hour"
    size = GROUPS[group_by]
    start = math.floor(records[0].t_end / size) * size
    while (now - start) / size > 48:
        size *= 2
    edges = np.arange(start, now + size, size)
    categories, good, different = [], [], []
    for a, b in zip(edges[:-1], edges[1:]):
        inside = [r for r in records if a <= r.t_end < b]
        categories.append(datetime.fromtimestamp(a).strftime("%H:%M"))
        good.append(sum(1 for r in inside if r.verdict == "good"))
        different.append(sum(1 for r in inside if r.verdict == "different"))
    total = [g + d for g, d in zip(good, different)]
    words = {60.0: "minute", 600.0: "10 minutes", 3600.0: "hour"}.get(size, f"{size / 60:.0f} minutes")
    steps = [step(f"Each bar is one {words}: {len(records)} parts {_scope(window_s, records)}, {sum(good)} good "
                  f"and {sum(different)} different.", None)]
    if len(categories) >= 2:
        busy = int(np.argmax(total))
        steps.append(step(f"The most parts came in the {words} from {categories[busy]}: {total[busy]}.",
                          {"type": "category", "index": busy, "label": "most parts"}))
    if sum(different):
        worst = int(np.argmax(different))
        steps.append(step(f"Most different parts came in the {words} from {categories[worst]}: {different[worst]} "
                          f"of {total[worst]}.", {"type": "category", "index": worst, "label": "most different"}))
    else:
        steps.append(step("Every part was the taught part.", None))
    return {"view": "part_counts", "sensor": sid, "name": cfg.name, "unit": cfg.unit,
            "display": cfg.display.as_dict() if cfg.display else None, "window_s": window_s,
            "group_by": group_by, "categories": categories, "good": good, "different": different,
            "insights": steps}


def part_heights(engine: Engine, sid: str, window_s: float | None = None) -> dict[str, Any]:
    records = _records(engine, sid, window_s)
    cfg = engine.settings.sensor(sid)
    if len(records) < 2:
        base = _empty("part_heights", engine, sid, window_s)
        if records:
            base["insights"] = [step("Only one part so far: the spread needs at least two.", None)]
        return {**base, "per": "parts", "series": []}
    v = np.array([r.height_um for r in records], dtype=float)
    ref_height, band, half_width = _band(engine, sid)
    lo, hi = float(v.min()), float(v.max())
    if band is not None:
        lo, hi = min(lo, band["low"]), max(hi, band["high"])
    pad = max((hi - lo) * 0.08, 5.0)
    bins = int(min(30, max(8, round(math.sqrt(v.size) * 2))))
    if band is not None:
        # fine enough to show the spread inside the band, even when a foreign part stretches the axis
        width = (band["high"] - band["low"]) / 8.0
        bins = int(min(80, max(bins, math.ceil((hi - lo + 2 * pad) / max(width, 1.0)))))
    counts, edges = np.histogram(v, bins=bins, range=(lo - pad, hi + pad))
    tolerance = band if band is not None else {"low": round(float(v.min()), 1), "high": round(float(v.max()), 1)}
    outside = (v < tolerance["low"]) | (v > tolerance["high"]) if band is not None else np.zeros(v.size, bool)
    mean, std = float(v.mean()), float(v.std())
    nominal = ref_height if ref_height is not None else float(np.median(v))
    worst = float(v[outside][np.argmax(np.abs(v[outside] - nominal))]) if outside.any() else None
    capable = band is not None and v.size >= 20 and std > 0
    cp = (tolerance["high"] - tolerance["low"]) / (6 * std) if std > 0 else math.inf
    cpk = min(tolerance["high"] - mean, mean - tolerance["low"]) / (3 * std) if std > 0 else math.inf
    p05, p95 = float(np.percentile(v, 5)), float(np.percentile(v, 95))
    steps = [step(f"These are the heights of {v.size} parts {_scope(window_s, records)}. Nine in ten were between "
                  f"{_length(cfg, p05)} and {_length(cfg, p95)}.",
                  {"type": "xspan", "x0": p05, "x1": p95, "label": "9 in 10 parts"})]
    if band is not None and ref_height is not None and half_width is not None:
        inside = int((~outside).sum())
        steps.append(step(f"The taught part is {_length(cfg, ref_height)} high, give or take "
                          f"{_length(cfg, half_width)}: {inside} of {v.size} parts were inside that band.",
                          {"type": "xspan", "x0": band["low"], "x1": band["high"], "label": "taught part"}))
    if worst is not None:
        steps.append(step(f"{int(outside.sum())} {'part was' if int(outside.sum()) == 1 else 'parts were'} outside "
                          f"the band, the farthest at {_length(cfg, worst)}.",
                          {"type": "x", "x": worst, "label": "farthest off"}))
    if capable:
        steps.append(step(f"Cpk of the heights is {fmt(cpk, 1)}: the parts are "
                          f"{'well inside' if cpk >= 1.33 else 'close to the edges of'} the band.", None))
    return {
        "view": "part_heights", "chart": "part_heights", "window_s": window_s, "per": "parts",
        "series": [{
            "sensor": sid, "name": cfg.name, "unit": cfg.unit, "nominal": round(nominal, 1),
            "edges": [round(float(e), 2) for e in edges], "counts": [int(c) for c in counts],
            "n": int(v.size), "mean": round(mean, 2), "std": round(std, 3), "p05": round(p05, 1),
            "p95": round(p95, 1), "tolerance": tolerance,
            "cp": round(cp, 2) if math.isfinite(cp) else 99.0, "cpk": round(cpk, 2) if math.isfinite(cpk) else 99.0,
            "outside": int(outside.sum()), "worst": None if worst is None else round(worst, 1),
            "display": cfg.display.as_dict() if cfg.display else None, "limit_word": "band of the taught part",
            "capability": capable,
        }],
        "insights": steps,
    }
