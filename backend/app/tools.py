"""The AI tools that run on the backend.

The voice model calls these through the browser. They answer with small,
rounded summaries the model can read out loud, never raw samples. Every
number the copilot says comes from here.
"""

from __future__ import annotations

import time
from typing import Any

import numpy as np

from .analysis import robust_sigma, round_or_none, summary
from .engine import Engine


def get_data(engine: Engine, sensor: str, window_s: float = 10.0) -> dict[str, Any]:
    sid = engine.resolve_sensor(sensor)
    cfg = engine.settings.sensor(sid)
    window_s = float(min(max(window_s, 1.0), engine.settings.engine.fast_buffer_s))
    _, _, values = engine.buffers[sid].fast_window(window_s)
    stats = summary(values)
    noise = robust_sigma(values)
    baseline = engine.detector.baseline(sid)
    latest = stats["latest"]
    result = {
        "sensor": sid,
        "name": cfg.name,
        "model": cfg.model,
        "unit": cfg.unit,
        "window_s": window_s,
        "latest": round_or_none(latest, 2),
        "mean": round_or_none(stats["mean"], 2),
        "min": round_or_none(stats["min"], 2),
        "max": round_or_none(stats["max"], 2),
        "noise": round_or_none(noise, 3),
        "normal_noise": round_or_none(baseline, 3),
        "valid_percent": round(stats["valid_ratio"] * 100.0, 1),
        "tolerance": cfg.tolerance.as_dict(),
        "within_tolerance": None if latest is None else cfg.tolerance.contains(latest),
        "state": engine.sensor_state(sid),
        "active_alerts": engine.active_kinds(sid),
        "source": engine.source_info.get(sid, {}).get("type"),
    }
    if cfg.display is not None:
        # a sensor that reports millimetres: say positions the way its own web page does
        def where(value: float | None) -> str | None:
            return None if value is None else cfg.pos(value)

        zone = cfg.spec.zone(latest) if cfg.spec is not None and latest is not None else None
        result["position"] = {
            "latest": where(latest), "mean": where(stats["mean"]), "min": where(stats["min"]),
            "max": where(stats["max"]),
            "limits": f"{cfg.pos(cfg.tolerance.low)} to {cfg.pos(cfg.tolerance.high)} ({cfg.limit_word})",
            "where": zone.text if zone else None,
            "state_led": zone.led if zone else None,
            "note": "Positions are distances from the start of the measuring range, in millimetres. Noise is "
                    "in micrometres.",
        }
    if cfg.spec is not None:
        result["datasheet"] = cfg.spec.summary()
    return result


def analyze(engine: Engine, sensor: str, window_s: float = 60.0) -> dict[str, Any]:
    sid = engine.resolve_sensor(sensor)
    cfg = engine.settings.sensor(sid)
    buf = engine.buffers[sid]
    now = time.time()
    result = get_data(engine, sid, min(window_s, 30.0))
    result["window_s"] = window_s
    observations: list[str] = []

    if result["within_tolerance"] is False:
        if cfg.tolerance_kind == "measuring_range" and cfg.spec is not None and result["latest"] is not None:
            zone = cfg.spec.zone(result["latest"])
            observations.append(f"The target is currently {zone.text}, at {cfg.pos(result['latest'])}.")
        else:
            observations.append("The value is currently outside the tolerance band.")

    _, _, recent = buf.fast_window(1.0)
    invalid_share = float(np.mean(~np.isfinite(recent))) if recent.size else 0.0
    if invalid_share > 0:
        observations.append(f"{invalid_share * 100:.0f}% of readings in the last second were invalid.")

    part = engine.partcheck.public(sid)
    if part.get("reference") is not None:
        observations.append(part["message"])
    station = engine.station.public(sid, now)
    if station["parts"]:
        observations.append(f"Quality station: {station['message']}")
        trend = station.get("trend")
        if trend and trend.get("clear") and trend.get("parts_to_limit") is not None:
            observations.append(f"The good parts get {trend['direction']} by {abs(trend['slope_um_per_part'])} µm "
                                f"per part; at this rate they leave the band in about "
                                f"{trend['parts_to_limit']:.0f} part{'' if round(trend['parts_to_limit']) == 1 else 's'}.")

    if not observations:
        observations.append("Nothing unusual: the target is inside the measuring range and the readings are valid.")
    result["recent_events"] = [
        {"kind": e["kind"], "severity": e["severity"], "seconds_ago": round(now - e["t"], 1),
         "summary": e["summary"]}
        for e in engine.recent_events(limit=5, since=now - window_s, sensor=sid)
    ]
    result["observations"] = observations
    return result
