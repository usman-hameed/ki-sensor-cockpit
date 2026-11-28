"""OpenAI Realtime voice: short-lived keys, the copilot's instructions and its tools.

The browser never sees the real API key. It asks ``POST /api/realtime/session``
for a short-lived client secret, connects to OpenAI over WebRTC with it, and
then sends the ``session_updates`` returned here over the data channel.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .config import Settings
from .sensor_specs import MANUAL

log = logging.getLogger("cockpit.realtime")

CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets"
CALLS_URL = "https://api.openai.com/v1/realtime/calls"

ALERT_PREFIX = "[MONITORING ALERT]"


class RealtimeError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _sensor_line(s: Any) -> str:
    if s.spec is None or s.display is None:
        return (f"- {s.name} (id {s.id}): {s.model}, unit {s.unit}, {s.limit_word} {s.tolerance.low:g} to "
                f"{s.tolerance.high:g} {s.unit}.")
    return (f"- {s.name} (id {s.id}): {s.spec.title}. Positions are distances from the start of the measuring "
            f"range in millimetres, exactly as the sensor's web page shows them: {s.spec.range_text} is the "
            f"measuring range and the limit that counts as 'tolerance'. Noise is in micrometres. The cockpit "
            f"does not change the sensor's settings; they are set in the sensor's own web page.")


def _datasheet_lines(settings: Settings) -> str:
    blocks = []
    for s in settings.sensors:
        if s.spec is None:
            continue
        rows = "\n".join(f"- {r['label']}: {r['value']} (manual p. {r['page']})" for r in s.spec.datasheet_rows())
        blocks.append(f"Data sheet of {s.name}, {s.spec.title}, from the {MANUAL}:\n{rows}")
    if not blocks:
        return ""
    return ("\n\n" + "\n\n".join(blocks) + "\n"
            "Use this data sheet for questions about the sensor's range, accuracy, spot size, temperature, rate, "
            "light or LED, and name the manual page. For anything else about the sensor call search_manual.")


def instructions(settings: Settings) -> str:
    sensor_lines = "\n".join(_sensor_line(s) for s in settings.sensors)
    datasheets = _datasheet_lines(settings)
    language = "German" if settings.cockpit.language.lower().startswith("de") else "English"
    name = settings.cockpit.assistant_name
    return f"""You are {name}, the voice copilot of a sensor cockpit that monitors Micro-Epsilon precision displacement sensors on a production line. The operator talks to you while working at the machine.

Sensors:
{sensor_lines}{datasheets}

How you speak:
- You are heard, not read. One or two short sentences per answer. No lists, no markdown.
- Answer in the language the operator uses. Start in {language}.
- Round numbers for speech: one decimal for micrometres, whole numbers for hertz and minutes. Say distances of a sensor with a data sheet in millimetres, with up to three decimals, as in the position fields of get_data.
- Sound calm and precise, like an experienced test engineer.

Hard rules:
- Never state a measurement, height, count or limit you did not get from a tool in this conversation. If you need a number, call get_data, analyze, get_part_check or get_parts first.
- When the operator wants to see something, call show_chart or make_chart, then say in one sentence what it shows.
- Messages that start with {ALERT_PREFIX} come from the monitoring system, not from the operator. Announce the alert in one or two sentences using only the numbers in it, then offer to show it. Do not call a tool for an alert unless the operator asks for more.
- If a question has nothing to do with the sensor, the parts or this cockpit, say briefly that you only handle the sensor cockpit.
- Never invent a cause, setting or number that is not in a tool result. Call checks what they are: checks to carry out, not a diagnosis.

The part check and the quality station:
- The operator teaches one good part and the empty plate. Every other thing that rests under the sensor raises a "different part" alert. The sensor sees the height of the top surface only, so two parts of the same height look the same to it.
- For "is this the right part", "what did you teach" or "how far off is it", call get_part_check and answer from it.
- Once both are taught, the quality station counts every part that rests under the sensor and keeps a part log: its number, height, how long it stayed and whether it was the taught part. It learns the rhythm of the parts and warns of a possible jam (a part stays far longer than usual), a possible double feed (a part follows much sooner than usual) and a height trend of the good parts towards the edge of the band.
- For "how many parts", "what was the last part", "how is the yield" or "is there a trend", call get_parts and answer from it.

Charts:
- show_chart with view timeseries shows the live signal with the measuring range. Default window 300 seconds.
- make_chart answers questions about the readings: histogram (how the readings are spread) or boxplot (spread per minute, 10 minutes or hour). It also draws the part log, one value per part: parts (the height of every part in order, with the taught part's band and the trend), part_counts (a bar chart of good and different parts per minute, 10 minutes or hour) and part_heights (how the heights of the parts are spread). When the operator asks for a kind of chart, pick the closest one; a bar chart is part_counts. It returns findings; say the most important one in one or two sentences.
- When asked to explain or walk through a chart, call explain_chart. Then say the returned steps in order, one short sentence per step, in your own words, keeping every number. Start directly with step 1, with no introduction. The cockpit points at each part of the chart while you speak, so do not skip or merge steps.
- Use stage_control with "back" to bring back the previous chart and "dismiss" to clear the current one.

Reports and manuals:
- When the operator asks for a report, a ticket or a summary of an alert, call create_report. Say that the report is on screen and name the most likely cause in one sentence.
- For a question about the sensor, its mounting, error values or limits, call search_manual with the question in the operator's words. Answer only from the returned passages, name the document and page, and say so plainly when the loaded manuals do not cover it. The cockpit shows the passages on screen.
- The manual library covers every Micro-Epsilon product family. search_manual answers for the connected sensor unless the operator names another model; then pass that model as product. Its result says which product the passages are for (scope).
- One product per answer: never give a value from one product's manual as the value of another product. If the passages are for a different product than the one asked about, say the manuals for that product do not cover it. If a question could mean several products, say which product you answer for, or ask.
- Never guess a specification, wiring, command or limit. When the manuals do not say it, say so and suggest checking with Micro-Epsilon support.
- Invalid readings usually mean the target is out of range, tilted, or too shiny or too dark for the sensor. Say "likely" or "usually", never certain."""


def tools(settings: Settings) -> list[dict[str, Any]]:
    sensor_ids = [s.id for s in settings.sensors]
    sensor_param = {"type": "string",
                    "description": f"Sensor id ({', '.join(sensor_ids)}) or name, for example 'Sensor 1'."}
    return [
        {
            "type": "function",
            "name": "get_data",
            "description": "Current reading of one sensor: latest value, mean, min, max, noise, "
                           "measuring range and active alerts.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sensor": sensor_param,
                    "window_s": {"type": "number", "description": "Seconds to summarise, default 10."},
                },
                "required": ["sensor"],
            },
        },
        {
            "type": "function",
            "name": "analyze",
            "description": "Diagnosis of one sensor: where the target is, invalid readings, the part check, "
                           "recent alerts and plain-language observations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sensor": sensor_param,
                    "window_s": {"type": "number", "description": "Seconds to look back, default 60."},
                },
                "required": ["sensor"],
            },
        },
        {
            "type": "function",
            "name": "show_chart",
            "description": "Show a chart on the cockpit's main screen. The previous chart moves back "
                           "into the history stack.",
            "parameters": {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "enum": ["timeseries"]},
                    "sensors": {"type": "array", "items": {"type": "string"}, "description": "Sensor id."},
                    "window_s": {"type": "number", "description": "Time window in seconds."},
                },
                "required": ["view"],
            },
        },
        {
            "type": "function",
            "name": "stage_control",
            "description": "Navigate the chart stack: 'back' shows the previous chart again, "
                           "'dismiss' clears the current chart.",
            "parameters": {
                "type": "object",
                "properties": {"action": {"type": "string", "enum": ["back", "dismiss"]}},
                "required": ["action"],
            },
        },
    ] + _extra_tools(sensor_param)


def _extra_tools(sensor_param: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": "get_part_check",
            "description": "The part check of a sensor: what is under it now (taught part, different part, "
                           "nothing), the taught part's position and allowed deviation, and the height when the "
                           "empty plate is taught.",
            "parameters": {"type": "object", "properties": {"sensor": sensor_param}},
        },
        {
            "type": "function",
            "name": "get_parts",
            "description": "The quality station of a sensor: how many parts, how many were the taught part, the "
                           "yield, parts per minute, the usual time per part and between parts, a height trend "
                           "of the good parts, and the last parts with their heights.",
            "parameters": {"type": "object", "properties": {"sensor": sensor_param}},
        },
        {
            "type": "function",
            "name": "make_chart",
            "description": "Build the chart that best answers a question. Of the readings: histogram (how they are "
                           "spread) or boxplot (spread per hour, 10 minutes or minute). Of the part log, one value "
                           "per part: parts (height of every part in order, with the band and the trend), "
                           "part_counts (bars of good and different parts per period) or part_heights (how the "
                           "part heights are spread). Returns findings with numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chart": {"type": "string",
                              "enum": ["histogram", "boxplot", "parts", "part_counts", "part_heights"]},
                    "sensors": {"type": "array", "items": sensor_param},
                    "window_s": {"type": "number",
                                 "description": "Look-back in seconds; leave out for the part charts to use the "
                                                "whole run."},
                    "group_by": {"type": "string", "enum": ["minute", "10min", "hour"]},
                },
                "required": ["chart"],
            },
        },
        {
            "type": "function",
            "name": "explain_chart",
            "description": "Explain the chart in front: returns the steps to say, in order. The cockpit "
                           "highlights each step on the chart while you speak.",
            "parameters": {"type": "object", "properties": {}},
        },
        {
            "type": "function",
            "name": "create_report",
            "description": "Write an incident report for an alert (default: the latest one) and show it "
                           "on screen. Returns the likely causes and next steps.",
            "parameters": {
                "type": "object",
                "properties": {"event_id": {"type": "string",
                                            "description": "Alert id; leave out for the latest alert."}},
            },
        },
        {
            "type": "function",
            "name": "search_manual",
            "description": "Look up the Micro-Epsilon manual library (operating instructions of all product "
                           "families). Returns passages with product, document, section and page. Without a "
                           "product it searches the connected sensor's manuals, or the product named in the query. "
                           "Use it for any question about a sensor, controller or interface: specifications, "
                           "settings, commands, mounting, wiring, error values or limits. The result says which "
                           "product the passages are for (scope); never apply them to another product.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string",
                              "description": "The question or a few keywords, in the operator's words."},
                    "product": {"type": "string",
                                "description": "Model to search, for example ILD1420, IFC2411, DT6120 or "
                                               "scanCONTROL 2950. Leave out for the connected sensor."},
                },
                "required": ["query"],
            },
        },
    ]


def session_updates(settings: Settings) -> list[dict[str, Any]]:
    """Session configuration the browser sends after connecting.

    Split in two so that an optional feature (input transcription) can never
    take the essential configuration down with it if the API rejects it.
    """
    essential = {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": instructions(settings),
            "tools": tools(settings),
            "tool_choice": "auto",
            "audio": {"input": {"turn_detection": None}},
        },
    }
    transcription = {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "audio": {"input": {"transcription": {"model": settings.transcribe_model}}},
        },
    }
    return [essential, transcription]


async def create_client_secret(settings: Settings,
                               client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    if not settings.openai_api_key:
        raise RealtimeError("Voice is off: set OPENAI_API_KEY in backend/.env", status_code=503)
    body = {
        "session": {
            "type": "realtime",
            "model": settings.realtime_model,
            "instructions": instructions(settings),
            "audio": {"output": {"voice": settings.realtime_voice}},
        }
    }
    headers = {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"}
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0)
    try:
        response = await client.post(CLIENT_SECRETS_URL, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise RealtimeError(f"Could not reach OpenAI: {exc}") from exc
    finally:
        if owns_client:
            await client.aclose()
    if response.status_code >= 400:
        try:
            detail = response.json().get("error", {}).get("message", response.text)
        except ValueError:
            detail = response.text
        log.error("client secret request failed (%s): %s", response.status_code, detail)
        raise RealtimeError(f"OpenAI refused the session ({response.status_code}): {detail}")
    data = response.json()
    value = data.get("value") or (data.get("client_secret") or {}).get("value")
    if not value:
        raise RealtimeError("OpenAI returned no client secret")
    return {
        "client_secret": value,
        "expires_at": data.get("expires_at"),
        "model": settings.realtime_model,
        "calls_url": CALLS_URL,
        "session_updates": session_updates(settings),
        "alert_prefix": ALERT_PREFIX,
    }
