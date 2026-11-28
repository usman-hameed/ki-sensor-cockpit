"""Incident reports: everything a maintenance technician needs about one alert.

``build`` collects the facts (event, signal around it, analysis, the alerts
before it, likely causes, actions). ``render_html`` turns them into one
standalone page with inline SVG charts, so the same report works on the
cockpit, on a phone and as a printed PDF.
"""

from __future__ import annotations

import html
import math
import time
from datetime import datetime
from typing import Any

import numpy as np

from . import sensor_advice
from .analysis import decimate_minmax, round_or_none
from .engine import Engine
from .sensor_specs import DATASHEET, DS_PAGE, MANUAL, reasons_text
from .tools import analyze


class ReportError(LookupError):
    pass


KIND_TITLE = {
    "out_of_range": "Out of tolerance", "invalid": "Invalid readings", "wrong_part": "Different part",
    "jam": "Possible jam", "double_feed": "Possible double feed", "trend": "Height trend",
}
# alerts of the quality station: their report shows the heights of the last parts
STATION_KINDS = ("jam", "double_feed", "trend", "wrong_part")


def kind_title(kind: str, limit_word: str = "tolerance") -> str:
    """The alert title; a sensor whose limits are its measuring range says so."""
    if kind == "out_of_range" and limit_word == "measuring range":
        return "Out of measuring range"
    return KIND_TITLE.get(kind, kind)
PRIORITY = {"critical": "P1 (urgent)", "warning": "P2 (today)", "info": "P3 (planned)"}


def _causes_and_actions(event: dict[str, Any], unit: str, related: list[str]) -> tuple[list[str], list[str]]:
    kind = event["kind"]
    if kind == "out_of_range":
        causes = ["The part itself is outside tolerance.",
                  "The sensor or fixture moved, so the reference no longer matches."]
        actions = ["Check the part with a reference gauge.",
                   "Hold back parts measured since this alert until the cause is clear.",
                   "Check the sensor mounting for displacement."]
    elif kind == "wrong_part":
        causes = ["A part of another height or shape lies under the sensor than the one that was taught.",
                  "The part is not seated flat: tilted, lifted by dirt or chips, or resting on a burr.",
                  "The sensor or the fixture moved, so even the right part now reads somewhere else.",
                  "The taught part was not typical, for example the first part had a deviation."]
        actions = ["Compare the part with a known good one and measure its height with a reference gauge.",
                   "Hold back the parts measured since this alert until the cause is clear.",
                   "If the right part reads differently now, check the sensor mounting and teach the part again.",
                   "Teach a second or third good part so the accepted band follows the real spread of the parts."]
    elif kind == "jam":
        causes = ["The part is stuck: held by a guide, a burr or the part behind it.",
                  "The conveyor or the handling stopped with a part under the sensor.",
                  "Someone left a part on the plate on purpose, for example during a break (no fault)."]
        actions = ["Look at the station: is the part stuck, or is the line stopped?",
                   "Clear the jam, then check this part and the next one for damage.",
                   "If parts are meant to stay longer from now on, start a new run so the station learns the "
                   "new rhythm."]
    elif kind == "double_feed":
        causes = ["Two parts were fed at once or right after each other: a feeder fault.",
                  "A part was put on the plate by hand right after the previous one.",
                  "The previous part was lifted or moved, so the plate showed only for a moment."]
        actions = ["Check whether two parts came through: look for a part stuck to the previous one.",
                   "Check the feeder and its timing.",
                   "Check both parts before they go on to the next station."]
    elif kind == "trend":
        causes = ["Tool wear: each part comes out a little higher or lower than the one before.",
                  "The fixture or the sensor moves slowly, for example while the machine warms up.",
                  "A new batch of material."]
        actions = ["Measure the last good parts with a reference gauge.",
                   "Plan a tool change or a correction before the parts leave the accepted band.",
                   "Check the mounting of the sensor and the fixture, and the temperature of the station."]
    else:  # invalid
        causes = ["Target outside the measuring range, or tilted too far.",
                  "Surface too shiny or too dark for the current exposure.",
                  "Something blocking the laser beam."]
        actions = ["Check distance and tilt of the target.",
                   "Check the beam path for obstructions or coolant.",
                   "Switch exposure to intelligent if the surface changes."]
    return causes, actions


def find_event(engine: Engine, event_id: str | None) -> dict[str, Any]:
    events = engine.recent_events(limit=500)
    if not events:
        raise ReportError("There are no alerts yet.")
    if not event_id or event_id == "latest":
        return events[-1]
    for event in events:
        if event["id"] == event_id:
            return event
    raise ReportError(f"Unknown alert {event_id!r}.")


def _signal_around(engine: Engine, sid: str, t: float) -> dict[str, Any]:
    buf = engine.buffers[sid]
    t0 = t - 3.0
    t1 = min(t + 4.0, buf.t_last or t + 4.0)
    start, dt, values = buf.fast_range(t0, t1)
    if values.size == 0:
        return {"t": [], "v": []}
    dec, _ = decimate_minmax(values.astype(float), 600)
    end = start + (values.size - 1) * dt
    rel = np.linspace(start - t, end - t, dec.size)
    return {"t": [round(float(x), 3) for x in rel], "v": [round_or_none(float(v), 3) for v in dec]}


def _parts_chart(engine: Engine, sid: str) -> dict[str, Any] | None:
    """The heights of the last parts the quality station measured, with the band of the taught part."""
    track = engine.partcheck.tracks.get(sid)
    records = [r for r in engine.station.records(sid, 40) if r.height_um is not None]
    if not records or track is None or track.reference is None or track.empty_um is None:
        return None
    ref, cfg = track.reference, engine.settings.sensor(sid)
    return {"type": "parts", "title": f"Height of the last {len(records)} parts on {cfg.name}", "sensor": sid,
            "x": [r.number for r in records], "v": [r.height_um for r in records],
            "tolerance": {"low": track.empty_um - ref.center_um - ref.half_width_um,
                          "high": track.empty_um - ref.center_um + ref.half_width_um},
            "display": cfg.display.as_dict() if cfg.display else None}


def build(engine: Engine, event_id: str | None = None) -> dict[str, Any]:
    event = find_event(engine, event_id)
    sid = event["sensor"]
    cfg = engine.settings.sensor(sid)
    related = [s for s in event.get("related_sensors", []) if s in engine.buffers]
    involved = [sid] + related
    sheet = sensor_advice.causes_and_actions(event, cfg, related)
    causes, actions = sheet if sheet is not None else _causes_and_actions(event, cfg.unit, related)
    part_no = part_at(engine, sid, event["t"]) if event["kind"] in STATION_KINDS else None
    photo = engine.photos.url(sid, part_no) if part_no else None

    charts: list[dict[str, Any]] = [{
        "type": "signal", "title": f"{engine.settings.sensor(s).name} around the alert",
        "sensor": s, **_signal_around(engine, s, event["t"]),
        "tolerance": {"low": engine.settings.sensor(s).tolerance.low,
                      "high": engine.settings.sensor(s).tolerance.high},
        "display": engine.settings.sensor(s).display.as_dict() if engine.settings.sensor(s).display else None,
    } for s in involved] if event["kind"] != "trend" else []
    if event["kind"] in STATION_KINDS:
        parts = _parts_chart(engine, sid)
        if parts is not None:
            charts.append(parts)

    try:
        analysis = analyze(engine, sid, 120.0)
        observations = analysis.get("observations", [])
    except Exception:  # analysis is a bonus, the report must still render
        observations = []
    timeline = [e for e in engine.recent_events(limit=50, since=event["t"] - 900)
                if e["sensor"] in involved or set(e.get("related_sensors", [])) & set(involved)]
    title = f"{kind_title(event['kind'], cfg.limit_word)} on {cfg.name}"

    live = engine._live_status(sid)
    datasheet = None
    if cfg.spec is not None:
        rate = (live or {}).get("rate_hz")
        datasheet = {"title": cfg.spec.title, "manual": MANUAL, "datasheet": DATASHEET,
                     "rows": cfg.spec.datasheet_rows(rate / 1000.0 if rate else None)}
    ticket_sensor = ([f"Sensor: {cfg.spec.title}, measuring range {cfg.spec.range_text}, linearity "
                      f"< ±{cfg.spec.linearity_um:g} µm ({DATASHEET}, p. {DS_PAGE['linearity']})"]
                     if cfg.spec is not None else [])
    ticket = "\n".join([
        f"Title: {title}",
        f"Priority: {PRIORITY.get(event['severity'], event['severity'])}",
        f"Component: {cfg.name} ({cfg.model})",
        *ticket_sensor,
        f"Detected: {datetime.fromtimestamp(event['t']).strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        f"What happened: {event['summary']}",
        "",
        "Likely causes:", *[f"- {c}" for c in causes],
        "",
        "Next steps:", *[f"- {a}" for a in actions],
    ])
    return {
        "id": event["id"], "title": title, "generated_at": time.time(),
        "cockpit": {"title": engine.settings.cockpit.title, "team": engine.settings.cockpit.team},
        "event": event, "priority": PRIORITY.get(event["severity"], event["severity"]),
        "sensors": [{"id": s, "name": engine.settings.sensor(s).name,
                     "model": engine.settings.sensor(s).model, "unit": engine.settings.sensor(s).unit,
                     "display": (engine.settings.sensor(s).display.as_dict()
                                 if engine.settings.sensor(s).display else None),
                     "limit_word": engine.settings.sensor(s).limit_word,
                     "tolerance": [engine.settings.sensor(s).tolerance.low,
                                   engine.settings.sensor(s).tolerance.high]} for s in involved],
        "datasheet": datasheet,
        "source": None if not live else {
            "kind": live.get("kind"), "host": live.get("host"), "port": live.get("port"),
            "rate_hz": live.get("rate_hz"), "serial": live.get("serial")},
        "observations": observations, "causes": causes, "actions": actions,
        "timeline": [{"t": e["t"], "kind": e["kind"], "severity": e["severity"], "summary": e["summary"]}
                     for e in timeline],
        "charts": charts, "ticket": ticket, "part": part_no, "photo": photo,
        "photo_html": (f"<section><h2>Camera</h2><figure><img src='{photo}' style='width:100%;border-radius:10px'>"
                       f"<figcaption>Part {part_no} under the sensor when the alert came</figcaption></figure>"
                       f"<p><a href='/part/{sid}/{part_no}'>Part passport</a></p></section>") if photo else "",
    }


# -- HTML --------------------------------------------------------------------

def _esc(text: Any) -> str:
    return html.escape(str(text))


def _svg_line(xs: list[float], ys: list[float | None], width: int = 820, height: int = 220,
              band: tuple[float, float] | None = None, marker_x: float | None = None,
              extra: list[tuple[list[float], list[float | None], str]] | None = None,
              x_label: str = "", y_unit: str = "", hline: float | None = None, fine: bool = False) -> str:
    pad_l, pad_r, pad_t, pad_b = 52 if not fine else 62, 14, 12, 30
    series = [(xs, ys)] + [(ex, ey) for ex, ey, _ in (extra or [])]
    all_x = [x for sx, _ in series for x in sx]
    all_y = [y for _, sy in series for y in sy if y is not None and math.isfinite(y)]
    if not all_x or not all_y:
        return '<p class="muted">Not enough data for this chart.</p>'
    x0, x1 = min(all_x), max(all_x)
    y0, y1 = min(all_y), max(all_y)
    if band and (min(abs(band[0]), abs(band[1])) <= max(abs(y0), abs(y1)) * 2):
        y0, y1 = min(y0, band[0]), max(y1, band[1])
    if hline is not None:
        y0, y1 = min(y0, hline), max(y1, hline)
    span = (y1 - y0) or 1.0
    y0, y1 = y0 - span * 0.08, y1 + span * 0.08
    if x1 == x0:
        x1 = x0 + 1
    # axis labels in millimetres need as many decimals as the spread of the readings asks for
    decimals = max(1, min(6, math.ceil(-math.log10(max((y1 - y0) / 4.0, 1e-9))) + 1)) if fine else 1

    def px(x: float) -> float:
        return pad_l + (x - x0) / (x1 - x0) * (width - pad_l - pad_r)

    def py(y: float) -> float:
        return pad_t + (y1 - y) / (y1 - y0) * (height - pad_t - pad_b)

    def path(sx: list[float], sy: list[float | None]) -> str:
        out, pen = [], False
        for x, y in zip(sx, sy):
            if y is None or not math.isfinite(y):
                pen = False
                continue
            out.append(f"{'L' if pen else 'M'}{px(x):.1f},{py(y):.1f}")
            pen = True
        return " ".join(out)

    parts = [f'<svg viewBox="0 0 {width} {height}" class="chart" role="img">']
    for i in range(5):
        yv = y0 + (y1 - y0) * i / 4
        parts.append(f'<line x1="{pad_l}" x2="{width - pad_r}" y1="{py(yv):.1f}" y2="{py(yv):.1f}" class="grid"/>'
                     f'<text x="{pad_l - 6}" y="{py(yv) + 4:.1f}" class="ax" text-anchor="end">{yv:.{decimals}f}</text>')
    if band:
        top, bottom = py(min(band[1], y1)), py(max(band[0], y0))
        parts.append(f'<rect x="{pad_l}" y="{top:.1f}" width="{width - pad_l - pad_r}" '
                     f'height="{max(bottom - top, 0):.1f}" class="band"/>')
    if hline is not None:
        parts.append(f'<line x1="{pad_l}" x2="{width - pad_r}" y1="{py(hline):.1f}" y2="{py(hline):.1f}" class="limit"/>')
    if marker_x is not None and x0 <= marker_x <= x1:
        parts.append(f'<line x1="{px(marker_x):.1f}" x2="{px(marker_x):.1f}" y1="{pad_t}" '
                     f'y2="{height - pad_b}" class="marker"/>'
                     f'<text x="{px(marker_x) + 5:.1f}" y="{pad_t + 12}" class="mk">alert</text>')
    parts.append(f'<path d="{path(xs, ys)}" class="line"/>')
    for ex, ey, cls in extra or []:
        parts.append(f'<path d="{path(ex, ey)}" class="{cls}"/>')
    for i in range(5):
        xv = x0 + (x1 - x0) * i / 4
        parts.append(f'<text x="{px(xv):.1f}" y="{height - 10}" class="ax" text-anchor="middle">{xv:.0f}</text>')
    parts.append(f'<text x="{width - pad_r}" y="{height - 10}" class="ax" text-anchor="end">{_esc(x_label)}</text>')
    parts.append(f'<text x="4" y="{pad_t + 4}" class="ax">{_esc(y_unit)}</text></svg>')
    return "".join(parts)


def _scaled(values: list[float | None], scale: float) -> list[float | None]:
    return [None if v is None else v * scale for v in values]


def _chart_html(chart: dict[str, Any], unit: str) -> str:
    display = chart.get("display")
    scale = float(display["scale"]) if display else 1.0
    shown = display["unit"] if display else unit
    fine = display is not None
    tol = chart.get("tolerance") or {}
    band = (tol["low"] * scale, tol["high"] * scale) if tol else None
    if chart.get("type") == "parts":
        svg = _svg_line(chart["x"], _scaled(chart["v"], scale), band=band, x_label="part number",
                        y_unit=f"height, {shown}", fine=fine)
    else:
        svg = _svg_line(chart["t"], _scaled(chart["v"], scale), band=band, marker_x=0.0,
                        x_label="seconds from alert", y_unit=shown, fine=fine)
    return f'<figure><figcaption>{_esc(chart["title"])}</figcaption>{svg}</figure>'


STYLE = """
:root{--ink:#15202b;--muted:#66737f;--line:#dde2e7;--accent:#5a3ff2;--warn:#c27400;--crit:#d7263d}
*{box-sizing:border-box}body{margin:0;font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;color:var(--ink);background:#e9ecef}
body.embed{background:#fff}body.embed .doc{margin:0;max-width:none;border-radius:0;box-shadow:none}body.embed .actions{display:none}
.doc{max-width:920px;margin:24px auto;background:#fff;border-radius:14px;box-shadow:0 10px 40px rgba(13,27,42,.12);overflow:hidden}
header{padding:26px 36px;background:var(--ink);color:#eef0f2;border-bottom:3px solid var(--accent)}
header .brand{font-size:14px;opacity:.75}
header h1{margin:8px 0 6px;font-size:28px}header .sub{opacity:.8;font-size:14px}
.chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:600;margin-right:8px;text-transform:capitalize}
.critical{background:var(--crit);color:#fff}.warning{background:var(--warn);color:#fff}.info{background:var(--accent);color:#fff}
main{padding:8px 36px 32px}section{padding:18px 0;border-bottom:1px solid var(--line)}section:last-child{border:0}
h2{font-size:16px;font-weight:600;color:var(--muted);margin:0 0 8px}
.summary{font-size:19px;line-height:1.5;margin:0}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.meta div{background:#f5f8fa;border-radius:10px;padding:10px 12px}
.meta b{display:block;font-size:13px;color:var(--muted);margin-bottom:2px;font-weight:500}
ul{margin:0;padding-left:20px;line-height:1.6}figure{margin:0 0 16px}figcaption{font-weight:600;margin-bottom:6px}
.chart{width:100%;height:auto;background:#fbfcfd;border:1px solid var(--line);border-radius:10px}
.chart .grid{stroke:#e8eef3}.chart .ax{fill:#7b8a99;font-size:11px}.chart .line{fill:none;stroke:var(--accent);stroke-width:1.5}
.chart .band{fill:rgba(46,160,67,.08)}.chart .marker{stroke:var(--warn);stroke-width:2;stroke-dasharray:4 3}.chart .mk{fill:var(--warn);font-size:11px;font-weight:700}
.chart .fit{fill:none;stroke:#0d1b2a;stroke-width:2}.chart .forecast{fill:none;stroke:var(--crit);stroke-width:2;stroke-dasharray:6 4}.chart .limit{stroke:var(--crit)}
.cap{margin:6px 0 0;color:var(--muted);font-size:14px}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{white-space:nowrap;color:var(--muted);width:90px}
table.sheet td:first-child{width:190px;white-space:normal}table.sheet td.pg{white-space:nowrap;color:var(--muted);width:48px;text-align:right}
.actions{position:sticky;top:0;display:flex;gap:10px;justify-content:flex-end;padding:12px 36px;background:#fff;border-bottom:1px solid var(--line);z-index:2}
.actions button{font:inherit;padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;cursor:pointer;font-weight:600}
.actions button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
pre{white-space:pre-wrap;background:#f5f8fa;border-radius:10px;padding:14px;font-size:13px;line-height:1.5}
@media(max-width:640px){header,main,.actions{padding-left:18px;padding-right:18px}.meta{grid-template-columns:1fr 1fr}header h1{font-size:22px}}
@media print{body{background:#fff}.doc{box-shadow:none;margin:0;max-width:none}.actions{display:none}section{break-inside:avoid}}
"""


FACT_LABELS = {
    "invalid_share": ("Invalid readings", "{v}"),
    "invalid_percent": ("Invalid readings", "{v} % of the last second"),
    "range": ("Measuring range of the sensor", "{v}"),
    "extended_range": ("Extended measuring range", "{v}"),
    "led": ("State LED of the sensor", "{v}"),
    "parts": ("Good parts taught", "{v}"),
    "part": ("Part number", "{v}"),
    "stay_s": ("Time under the sensor", "{v} s"),
    "usual_stay_s": ("Usual time under the sensor", "{v} s"),
    "gap_s": ("Time since the previous part", "{v} s"),
    "usual_gap_s": ("Usual time between parts", "{v} s"),
    "slope_um_per_part": ("Change per part", "{v} µm"),
    "parts_to_limit": ("Parts until the edge of the band", "about {v}"),
    "trend_parts": ("Good parts in the trend", "{v}"),
    "r2": ("How well a straight line fits (R²)", "{v}"),
    "stacked": ("Two parts on top of each other", "possibly"),
}
# values that are positions: shown in the sensor's own unit (millimetres for the optoNCDT)
POSITION_FACTS = {"value": "Reading", "limit": "Limit crossed",
                  "reference": "Taught part reads", "half_width": "Allowed deviation (±)",
                  "deviation": "Difference to the taught part", "height": "Height of this part",
                  "reference_height": "Height of the taught part"}
ZONE_TEXT = {"standard": "inside the measuring range", "before": "before the start of the range (extended range)",
             "after": "beyond the end of the range (extended range)", "outside": "outside the extended range"}


def _fact(key: str, value: Any, unit: str, display: dict[str, Any] | None = None) -> str:
    if key in POSITION_FACTS and isinstance(value, (int, float)):
        text = (f"{value * display['scale']:.{display['decimals']}f} {display['unit']}" if display
                else f"{value} {unit}")
        return f"<li>{_esc(POSITION_FACTS[key])}: <b>{_esc(text)}</b></li>"
    if key == "zone":
        return f"<li>Where the target is: <b>{_esc(ZONE_TEXT.get(str(value), value))}</b></li>"
    if key == "reasons" and isinstance(value, dict):
        return f"<li>Why the readings were invalid: <b>{_esc(reasons_text(value))}</b></li>"
    if key == "main_reason":
        return ""
    label, fmt = FACT_LABELS.get(key, (key.replace("_", " ").capitalize(), "{v}"))
    return f"<li>{_esc(label)}: <b>{_esc(fmt.format(v=value, unit=unit))}</b></li>"


def _datasheet_html(sheet: dict[str, Any] | None) -> str:
    if not sheet:
        return ""
    rows = "".join(f"<tr><td>{_esc(r['label'])}</td><td>{_esc(r['value'])}</td>"
                   f"<td class='pg'>{'data sheet' if r.get('source') == sheet.get('datasheet') else 'manual'} "
                   f"p. {r['page']}</td></tr>" for r in sheet["rows"])
    return (f"<section><h2>Sensor data sheet: {_esc(sheet['title'])}</h2><table class='sheet'>{rows}</table>"
            f"<p class='cap'>From the {_esc(sheet.get('datasheet', ''))} and the {_esc(sheet['manual'])}. "
            "Page numbers are the printed ones. Where the two differ, the newer data sheet is used.</p></section>")


def render_html(report: dict[str, Any], embed: bool = False) -> str:
    event = report["event"]
    unit = report["sensors"][0]["unit"] if report["sensors"] else ""
    when = datetime.fromtimestamp(event["t"]).strftime("%d %b %Y, %H:%M:%S")
    sev = event["severity"]
    sensors_txt = ", ".join(s["name"] for s in report["sensors"])
    source = report.get("source")
    source_txt = ""
    if source:
        rate = f", {source['rate_hz'] / 1000:g} kHz" if source.get("rate_hz") else ""
        source_txt = f"Live sensor at {source.get('host')}{rate}"
    meta_items = [("Detected", when), ("Priority", report["priority"]), ("Sensors", sensors_txt),
                  ("Sensor model", report["sensors"][0]["model"] if report["sensors"] else "")]
    if source_txt:
        meta_items.append(("Data source", source_txt))
    meta = "".join(f"<div><b>{_esc(k)}</b>{_esc(v)}</div>" for k, v in meta_items)
    numbers = event.get("numbers", {})
    display = report["sensors"][0].get("display") if report["sensors"] else None
    facts = "".join(_fact(k, v, numbers.get("unit", unit), display) for k, v in numbers.items() if k != "unit")
    obs = "".join(f"<li>{_esc(o)}</li>" for o in report["observations"])
    causes = "".join(f"<li>{_esc(c)}</li>" for c in report["causes"])
    actions = "".join(f"<li>{_esc(a)}</li>" for a in report["actions"])
    charts = "".join(_chart_html(c, unit) for c in report["charts"])
    charts_heading = "Signal" if all(c.get("type") != "parts" for c in report["charts"]) else "Measurements"
    timeline = "".join(
        f"<tr><td>{datetime.fromtimestamp(e['t']).strftime('%H:%M:%S')}</td>"
        f"<td><span class='chip {e['severity']}'>{_esc(e['kind'].replace('_', ' '))}</span>{_esc(e['summary'])}</td></tr>"
        for e in report["timeline"])
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{_esc(report['title'])}: incident report</title><style>{STYLE}</style></head>
<body class="{'embed' if embed else ''}"><div class="doc">
<div class="actions"><button onclick="copyTicket(this)">Copy ticket text</button>
<button class="primary" onclick="window.print()">Save as PDF</button></div>
<header><div class="brand">Incident report {_esc(report['id'])} from {_esc(report['cockpit']['title'])}</div>
<h1>{_esc(report['title'])}</h1>
<div class="sub"><span class="chip {sev}">{_esc(sev)}</span>Written by the copilot for {_esc(report['cockpit']['team'])}</div></header>
<main>
<section><h2>What happened</h2><p class="summary">{_esc(event['summary'])}</p></section>
<section class="meta">{meta}</section>
{report.get("photo_html", "")}
<section><h2>Measured</h2><ul>{facts}</ul>{f'<ul>{obs}</ul>' if obs else ''}</section>
<section><h2>{charts_heading}</h2>{charts}</section>
<section><h2>Likely causes</h2><ul>{causes}</ul></section>
<section><h2>Recommended next steps</h2><ul>{actions}</ul></section>
{_datasheet_html(report.get("datasheet"))}
<section><h2>Timeline (15 minutes before)</h2><table>{timeline or '<tr><td colspan=2 class=muted>No other alerts.</td></tr>'}</table></section>
<section><h2>Ticket text</h2><pre id="ticket">{_esc(report['ticket'])}</pre></section>
</main></div>
<script>function copyTicket(b){{const t=document.getElementById('ticket').innerText;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{{b.textContent='Copied';}}).catch(()=>{{
const r=document.createRange();r.selectNodeContents(document.getElementById('ticket'));const s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Selected: press Ctrl+C';}});}}</script>
</body></html>"""


# -- the run report: every part of the run and every alert, one page -------------------------------------

RUN_KINDS = ("wrong_part", "jam", "double_feed", "trend", "out_of_range", "invalid")


def render_run_html(engine: Engine, sid: str, embed: bool = False) -> str:
    """What the quality station saw in this run: counts, the alerts, the heights and every part."""
    cfg = engine.settings.sensor(sid)
    now = time.time()
    station = engine.station.public(sid, now)
    records = engine.station.records(sid)
    track = engine.partcheck.tracks.get(sid)
    display = cfg.display.as_dict() if cfg.display else None
    scale = float(display["scale"]) if display else 1.0
    shown = display["unit"] if display else cfg.unit
    digits = 3 if display else 1

    def length(um: float | None) -> str:
        return "–" if um is None else f"{um * scale:.{digits}f} {shown}"

    started = station.get("run_started") or (records[0].t_start if records else now)
    clock = lambda t: datetime.fromtimestamp(t).strftime("%H:%M:%S")  # noqa: E731
    alerts = [e for e in engine.events if e.sensor == sid and e.kind in RUN_KINDS and e.t >= started - 1]
    meta = [("Sensor", f"{cfg.name}, {cfg.model or ''}".strip(", ")),
            ("Run started", datetime.fromtimestamp(started).strftime("%d %b %Y, %H:%M:%S")),
            ("Report written", datetime.fromtimestamp(now).strftime("%H:%M:%S"))]
    if track is not None and track.reference is not None:
        ref = track.reference
        if track.empty_um is not None:
            meta.append(("Taught part", f"{length(track.empty_um - ref.center_um)} high, ± {length(ref.half_width_um)}"))
        else:
            meta.append(("Taught part", f"reads {length(ref.center_um)}, ± {length(ref.half_width_um)}"))
    meta_html = "".join(f"<div><b>{_esc(k)}</b>{_esc(v)}</div>" for k, v in meta)
    counts = [("Parts", station["parts"]), ("Taught part", station["good"]), ("Different", station["different"]),
              ("Yield", f"{station['yield_percent']:.0f} %" if station["yield_percent"] is not None else "–"),
              ("Possible jams", station["jams"]), ("Possible double feeds", station["double_feeds"])]
    counts_html = "".join(f"<div><b>{_esc(k)}</b><span class='big'>{_esc(v)}</span></div>" for k, v in counts)
    trend = station.get("trend")
    trend_txt = ""
    if trend and trend.get("clear"):
        left = trend.get("parts_to_limit")
        trend_txt = (f"The good parts get {trend['direction']} by {abs(trend['slope_um_per_part']):.1f} µm per part"
                     + (f"; at this rate they leave the band in about {left:.0f} parts." if left is not None else "."))
    elif trend:
        trend_txt = "No trend in the heights of the good parts."
    chart = _parts_chart(engine, sid)
    if chart is not None and records:
        heights = [r for r in records if r.height_um is not None][-200:]
        chart.update({"x": [r.number for r in heights], "v": [r.height_um for r in heights],
                      "title": f"Height of every part ({len(heights)} parts)"})
    chart_html = _chart_html(chart, cfg.unit) if chart is not None and chart["x"] else ""
    alert_rows = "".join(
        f"<tr><td>{clock(e.t)}</td><td><span class='chip {e.severity}'>{_esc(KIND_TITLE.get(e.kind, e.kind))}</span>"
        f"{_esc(e.summary)}</td></tr>" for e in alerts[-60:])
    words = {"jam": "possible jam", "double_feed": "possible double feed", "unsteady": "never steady"}
    part_rows = "".join(
        f"<tr class='{r.verdict}'><td><a href='/part/{sid}/{r.number}'>{r.number}</a>"
        f"{' 📷' if engine.photos.has(sid, r.number) else ''}</td><td>{clock(r.t_start)}</td><td>{length(r.height_um)}</td>"
        f"<td>{'taught part' if r.verdict == 'good' else '<b>different part</b>'}</td><td>{r.dwell_s:.1f} s</td>"
        f"<td>{_esc(', '.join(words.get(f, f) for f in r.flags))}</td></tr>" for r in reversed(records[-300:]))
    extra = "<style>.counts{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 18px}.counts b{display:block;" \
            "font-weight:500;color:var(--muted);font-size:13px}.counts .big{font-size:28px;font-weight:600}" \
            "tr.different td{background:#fdecee}td{padding:5px 8px;border-bottom:1px solid var(--line)}" \
            ".parts th{text-align:left;padding:5px 8px;color:var(--muted);font-weight:500}</style>"
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run report: {_esc(cfg.name)}</title><style>{STYLE}</style>{extra}</head>
<body class="{'embed' if embed else ''}"><div class="doc">
<div class="actions"><button class="primary" onclick="window.print()">Save as PDF</button></div>
<header><div class="brand">Run report from {_esc(engine.settings.cockpit.title)}</div>
<h1>Quality station: {_esc(cfg.name)}</h1>
<div class="sub">Every part that rested under the sensor and every alert of this run, for {_esc(engine.settings.cockpit.team)}</div></header>
<main>
<section class="counts">{counts_html}</section>
<section class="meta">{meta_html}</section>
{f'<section><h2>Trend</h2><p>{_esc(trend_txt)}</p></section>' if trend_txt else ''}
{f'<section><h2>Measurements</h2>{chart_html}</section>' if chart_html else ''}
<section><h2>Alerts ({len(alerts)})</h2><table>{alert_rows or '<tr><td class=muted>No alerts in this run.</td></tr>'}</table></section>
<section><h2>Every part, newest first</h2><table class="parts"><tr><th>Part</th><th>Time</th><th>Height</th><th>Verdict</th><th>Stay</th><th>Note</th></tr>
{part_rows or '<tr><td colspan=6 class=muted>No parts yet.</td></tr>'}</table></section>
</main></div></body></html>"""


# -- the part passport: one part, one page, one QR code ------------------------------------------------

def part_at(engine: Engine, sid: str, t: float) -> int | None:
    """The number of the part that lay under the sensor at time t (the one there now counts too)."""
    for r in reversed(engine.station.records(sid, 200)):
        if r.t_start - 1.0 <= t <= r.t_end + 0.5:
            return r.number
    line = engine.station.lines.get(sid)
    if line is not None and line.visit is not None and t >= line.visit.start - 1.0:
        return line.next_number
    return None


def render_passport_html(engine: Engine, sid: str, number: int, embed: bool = False) -> str | None:
    cfg = engine.settings.sensor(sid)
    record = next((r for r in engine.station.records(sid) if r.number == number), None)
    if record is None:
        return None
    display = cfg.display.as_dict() if cfg.display else None
    scale = float(display["scale"]) if display else 1.0
    shown = display["unit"] if display else cfg.unit
    digits = 4 if display else 1

    def length(um: float | None, signed: bool = False) -> str:
        if um is None:
            return "–"
        return f"{um * scale:+.{digits}f} {shown}" if signed else f"{um * scale:.{digits}f} {shown}"

    good = record.verdict == "good"
    track = engine.partcheck.tracks.get(sid)
    taught = "–"
    if track is not None and track.reference is not None:
        ref = track.reference
        taught = (f"{length(track.empty_um - ref.center_um)} high, ± {length(ref.half_width_um)}"
                  if track.empty_um is not None else f"reads {length(ref.center_um)}, ± {length(ref.half_width_um)}")
    words = {"jam": "possible jam", "double_feed": "possible double feed", "unsteady": "never lay still"}
    rows = [("Verdict", "the taught part" if good else "a different part"),
            ("Top surface (sensor reading)", length(record.position_um)),
            ("Difference to the taught part", length(record.deviation_um, signed=True)),
            ("Taught part", taught),
            ("Under the sensor", f"{datetime.fromtimestamp(record.t_start).strftime('%d %b %Y, %H:%M:%S')}, "
                                 f"{record.dwell_s:.1f} s"),
            ("Time since the part before", "–" if record.gap_s is None else f"{record.gap_s:.1f} s"),
            ("Notes", ", ".join(words.get(f, f) for f in record.flags) or "none"),
            ("Measured by", f"{cfg.name}, {cfg.model}")]
    if record.height_um is not None:  # only known when the empty plate is in range and taught
        rows.insert(1, ("Height above the plate", length(record.height_um)))
    facts = "".join(f"<div><b>{_esc(k)}</b>{_esc(v)}</div>" for k, v in rows)
    alerts = [e for e in engine.events if e.sensor == sid and record.t_start - 1.0 <= e.t <= record.t_end + 0.5]
    alert_rows = "".join(f"<li><span class='chip {e.severity}'>{_esc(KIND_TITLE.get(e.kind, e.kind))}</span>"
                         f"{_esc(e.summary)}</li>" for e in alerts)
    photo = engine.photos.url(sid, number)
    photo_html = (f"<figure class='photo'><img src='{photo}' alt='Part {number} under the sensor'>"
                  f"<figcaption>The camera picture taken while part {number} lay under the sensor</figcaption></figure>"
                  if photo else "<p class='muted'>No camera picture: switch the camera on in the cockpit.</p>")
    extra = ("<style>.verdict{display:inline-block;padding:6px 14px;border-radius:8px;font-weight:700;font-size:18px;"
             f"background:{'#138a5e' if good else '#d7263d'};color:#fff}}.photo img{{width:100%;border-radius:10px;"
             "border:1px solid var(--line)}.photo figcaption{color:var(--muted);font-size:13px;margin-top:6px}"
             ".facts{display:grid;grid-template-columns:1fr 1fr;gap:10px}.facts div{background:#f4f6f8;"
             "border-radius:8px;padding:8px 12px}.facts b{display:block;font-weight:500;color:var(--muted);"
             "font-size:13px}</style>")
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Part {number}: passport</title><style>{STYLE}</style>{extra}</head>
<body class="{'embed' if embed else ''}"><div class="doc">
<div class="actions"><button class="primary" onclick="window.print()">Save as PDF</button></div>
<header><div class="brand">Part passport from {_esc(engine.settings.cockpit.title)}</div>
<h1>Part {number}</h1><div class="sub"><span class="verdict">{'Taught part' if good else 'Different part'}</span></div></header>
<main>
<section>{photo_html}</section>
<section class="facts">{facts}</section>
<section><h2>Alerts while it was there</h2>{f'<ul>{alert_rows}</ul>' if alert_rows else '<p class=muted>None.</p>'}</section>
<section><p class="muted"><a href="/run-report/{_esc(sid)}">The whole run</a></p></section>
</main></div></body></html>"""
