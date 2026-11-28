"""Typed chat with the copilot when voice is off.

The same instructions and tools as the voice copilot, through the OpenAI
Responses API. The browser runs the tool calls (as it does for voice, so a
chart or the manual card opens on screen) and sends the results back; the
conversation continues with ``previous_response_id``.
"""

from __future__ import annotations

import re
from typing import Any

from . import realtime
from .config import Settings
from .openai_client import OpenAIClient, OpenAIError

TEXT_MODE = """

Text mode:
- The operator is typing to you in the chat panel, not speaking. Everything above about speaking applies to your written replies: short, plain sentences, the most important number first.
- You may use a short bullet list or a small Markdown table when it helps, but no headings.
- Small talk such as a greeting gets one friendly sentence and a hint of what you can do.
- A short follow-up continues the previous request: "sensor 2" after "how are the readings spread" means the same question for Sensor 2. Answer it instead of asking what is meant.
- A yes/no question ("is sensor 2 working?") starts with a clear yes or no, then the numbers behind it.
- Always name the sensor your answer is about.
- For questions about the sensor itself, search_manual returns passages with a cite (section and page). Answer from them and give the cite."""


class ChatError(RuntimeError):
    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _tools(settings: Settings) -> list[dict[str, Any]]:
    return [{**tool, "strict": False} for tool in realtime.tools(settings)]


async def respond(settings: Settings, client: OpenAIClient, items: list[dict[str, Any]],
                  previous_response_id: str | None = None) -> dict[str, Any]:
    """One model turn: returns its text and the tool calls the browser should run."""
    if not client.enabled:
        raise ChatError("The AI chat is off: set OPENAI_API_KEY in backend/.env", status_code=503)
    body: dict[str, Any] = {
        "model": settings.chat_model,
        "instructions": realtime.instructions(settings) + TEXT_MODE,
        "input": items,
        "tools": _tools(settings),
        "tool_choice": "auto",
    }
    if previous_response_id:
        body["previous_response_id"] = previous_response_id
    if settings.chat_reasoning and re.match(r"^(gpt-5|o\d)", settings.chat_model):
        body["reasoning"] = {"effort": settings.chat_reasoning}
    try:
        data = await client.request("POST", "/responses", body, timeout=60.0)
    except OpenAIError as exc:
        raise ChatError(str(exc), status_code=502 if exc.status is None else min(max(exc.status, 400), 599)) from exc
    texts: list[str] = []
    calls: list[dict[str, str]] = []
    for item in data.get("output", []):
        if item.get("type") == "message":
            texts.extend(part.get("text", "") for part in item.get("content", [])
                         if part.get("type") == "output_text")
        elif item.get("type") == "function_call":
            calls.append({"call_id": item.get("call_id", ""), "name": item.get("name", ""),
                          "arguments": item.get("arguments", "{}")})
    return {"id": data.get("id"), "text": "\n".join(t for t in texts if t).strip(), "calls": calls}
