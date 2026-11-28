"""Written answers from the manuals (manual_rag) and the typed chat, offline or with a fake OpenAI."""

from __future__ import annotations

import json
from dataclasses import replace

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.manual_rag import KnowledgeBase
from app.openai_client import OpenAIClient

MANUAL = """# Operating Instructions Test Sensor

## Proper environment

Protection class: IP67
Temperature range operation: 0 ... +50 °C
Temperature range storage: -20 ... +70 °C

## Control and indicator elements

State LED red: No distance value available, target outside the measuring range.
State LED green: Target within the measuring range.
"""

TOKEN = {"X-Cockpit-Token": "test-token"}


@pytest.fixture()
def manual_dir(tmp_path):
    folder = tmp_path / "manuals"
    folder.mkdir()
    (folder / "test-manual.md").write_text(MANUAL, encoding="utf-8")
    (folder / "README.md").write_text("# Manuals the AI reads\n\nPut manuals here.", encoding="utf-8")
    return folder


def test_search_finds_section_with_citation(manual_dir):
    result = KnowledgeBase(manual_dir).search("what does the red LED mean")
    assert result["found"] and result["mode"] == "keyword"
    top = result["hits"][0]
    assert top["section_title"] == "Control and indicator elements" and "red" in top["text"]


def test_folder_note_is_not_a_manual(manual_dir):
    assert [p.name for p in KnowledgeBase(manual_dir).files()] == ["test-manual.md"]


def test_answer_without_key_quotes_the_manual(manual_dir):
    answer = KnowledgeBase(manual_dir).answer("operating temperature range")
    assert answer["found"] and answer["mode"] == "extractive" and "+50" in answer["answer"]


def test_unknown_question_is_not_answered(manual_dir):
    answer = KnowledgeBase(manual_dir).answer("zzqx flux capacitor")
    assert not answer["found"] and answer["mode"] == "none"


def test_answer_with_key_is_written_by_the_model(manual_dir):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(request.url.path)
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(200, json={"data": [{"index": i, "embedding": [1.0, float(i)]}
                                                      for i in range(len(body["input"]))]})
        assert "Manual passages" in body["input"] and body["reasoning"] == {"effort": "low"}
        return httpx.Response(200, json={"output": [{"type": "message", "content": [
            {"type": "output_text", "text": "IP67 [Section Proper environment]"}]}]})

    client = OpenAIClient("sk-test", factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    answer = KnowledgeBase(manual_dir, client).answer("protection class")
    assert answer["mode"] == "generated" and answer["answer"].startswith("IP67")
    assert any(p.endswith("/responses") for p in seen)


def test_routes_in_the_cockpit(settings, manual_dir):
    app = create_app(replace(settings, knowledge_dir=manual_dir))
    with TestClient(app) as client:
        ask = client.post("/api/knowledge/ask", json={"question": "protection class"}, headers=TOKEN).json()
        assert ask["found"] and "IP67" in ask["answer"] and ask["sources"][0]["citation"]
        tool = client.post("/api/tools/search_manual", json={"query": "green LED"}, headers=TOKEN).json()
        first = tool["passages"][0]
        assert tool["ok"] and tool["found"] and first["doc"] == "test-manual.md" and first["uid"] and first["cite"]
        assert "speak_rule" in tool
        assert client.post("/api/knowledge/ask", json={"question": "x"}).status_code == 401
        assert client.post("/api/knowledge/ask", json={"question": ""}, headers=TOKEN).status_code == 422


def test_chat_turn_returns_text_and_tool_calls(settings, manual_dir):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith("/embeddings"):  # the manuals warm up in the background
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            return httpx.Response(200, json={"data": [{"index": i, "embedding": [1.0, 0.0]}
                                                      for i in range(len(inputs))]})
        seen["body"] = body
        return httpx.Response(200, json={"id": "resp_1", "output": [
            {"type": "function_call", "call_id": "c1", "name": "search_manual", "arguments": '{"query":"red LED"}'},
            {"type": "message", "content": [{"type": "output_text", "text": "Checking the manual."}]},
        ]})

    app = create_app(replace(settings, knowledge_dir=manual_dir, openai_api_key="sk-test"),
                     openai_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    with TestClient(app) as client:
        turn = client.post("/api/chat", headers=TOKEN, json={
            "items": [{"role": "user", "content": "red LED?"}], "previous_response_id": "resp_0"}).json()
    assert turn == {"id": "resp_1", "text": "Checking the manual.",
                    "calls": [{"call_id": "c1", "name": "search_manual", "arguments": '{"query":"red LED"}'}]}
    body = seen["body"]
    assert body["previous_response_id"] == "resp_0" and "Text mode" in body["instructions"]
    assert "search_manual" in {t["name"] for t in body["tools"]}


def test_chat_without_key_is_refused(settings):
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/chat", headers=TOKEN, json={"items": [{"role": "user", "content": "hi"}]})
        assert response.status_code == 503


# -- a library of several products: answers come from the right product's manuals -----------------

ILD1420 = """# Operating Instructions optoNCDT 1420

## Technical data

Measuring rate: 4 kHz
Operating temperature: 0 ... +50 °C
Laser class 2
"""

CAPA6200 = """# Operating Instructions capaNCDT 6200

## Technical data

Measuring rate: 20 kHz
Operating temperature: +10 ... +50 °C
Capacitive sensor for conductive targets
"""


@pytest.fixture()
def library(tmp_path):
    first, second = tmp_path / "uploads", tmp_path / "library"
    first.mkdir()
    second.mkdir()
    (second / "man--optoNCDT-1420--en.md").write_text(ILD1420, encoding="utf-8")
    (second / "man--capaNCDT-6200--en.md").write_text(CAPA6200, encoding="utf-8")
    # the same file name in two folders is read once, from the first folder
    (first / "man--capaNCDT-6200--en.md").write_text(CAPA6200, encoding="utf-8")
    return [first, second]


def docs_of(result):
    return {h["doc"] for h in result["hits"]}


def test_question_naming_a_model_only_reads_that_products_manuals(library):
    kb = KnowledgeBase(library)
    assert [p.name for p in kb.files()] == ["man--capaNCDT-6200--en.md", "man--optoNCDT-1420--en.md"]
    result = kb.search("measuring rate of the ILD1420")
    assert docs_of(result) == {"man--optoNCDT-1420--en.md"}
    assert result["scope"]["source"] == "question" and "1420" in result["scope"]["product"]


def test_connected_sensor_scopes_a_question_that_names_no_model(library):
    kb = KnowledgeBase(library, active_product=lambda: "capaNCDT 6200")
    result = kb.search("operating temperature")
    assert docs_of(result) == {"man--capaNCDT-6200--en.md"}
    assert result["scope"] == {"source": "connected sensor", "product": "capaNCDT 6200", "documents": 1}


def test_named_model_wins_over_the_connected_sensor(library):
    kb = KnowledgeBase(library, active_product=lambda: "capaNCDT 6200")
    assert docs_of(kb.search("operating temperature of the ILD1420")) == {"man--optoNCDT-1420--en.md"}
    assert docs_of(kb.search("operating temperature", product="ILD1420")) == {"man--optoNCDT-1420--en.md"}


def test_not_in_the_sensors_manuals_falls_back_to_the_library_and_says_so(library):
    kb = KnowledgeBase(library, active_product=lambda: "capaNCDT 6200")
    result = kb.search("laser class")
    assert docs_of(result) == {"man--optoNCDT-1420--en.md"}
    assert result["scope"]["source"].startswith("all manuals (not in the connected sensor")


def test_without_model_or_sensor_all_manuals_are_searched(library):
    result = KnowledgeBase(library).search("operating temperature")
    assert result["scope"]["source"] == "all manuals" and result["scope"]["product"] is None


def test_adding_a_manual_only_indexes_that_file(library):
    kb = KnowledgeBase(library)
    kb.search("measuring rate")
    cached = sorted((library[0] / ".cache" / "rag" / "files").glob("*.json"))
    assert len(cached) == 2
    (library[1] / "man--optoNCDT-1320--en.md").write_text(ILD1420.replace("1420", "1320"), encoding="utf-8")
    assert docs_of(kb.search("measuring rate of the ILD1320")) == {"man--optoNCDT-1320--en.md"}
    assert len(sorted((library[0] / ".cache" / "rag" / "files").glob("*.json"))) == 3


def test_background_index_answers_after_the_first_build(library):
    kb = KnowledgeBase(library, background=True)
    result = kb.search("measuring rate of the ILD1420")   # waits briefly for the first build
    assert docs_of(result) == {"man--optoNCDT-1420--en.md"}


def test_library_routes_serve_status_and_files(settings, library):
    app = create_app(replace(settings, knowledge_dir=library[0], manual_library=(library[1],)))
    with TestClient(app) as client:
        tool = client.post("/api/tools/search_manual", headers=TOKEN,
                           json={"query": "measuring rate", "product": "ILD1420"}).json()
        assert tool["scope"]["source"] == "requested" and tool["passages"][0]["doc"] == "man--optoNCDT-1420--en.md"
        url = tool["passages"][0]["url"]
        assert url.startswith("/api/knowledge/library/") and client.get(url.split("#")[0]).status_code == 200
        assert client.get("/api/knowledge/library/nothing.pdf").status_code == 404
        status = client.get("/api/knowledge/library").json()
        assert status["documents"] == 2 and set(status["families"]) == {"optoncdt", "capancdt"}
