"""FastAPI application: REST API, WebSocket streams and the built frontend."""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Callable

import httpx

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import __version__, explore, insights, report, tools, views
from .config import FRONTEND_DIST, Settings, load_settings
from .engine import Engine, EngineError
from .hub import COCKPIT, PHONE, Hub
from .knowledge import KnowledgeBase
from . import chat
from .knowledge_api import add_routes as add_knowledge_routes
from .manual_rag import KnowledgeBase as ManualRag
from .openai_client import OpenAIClient
from .partcheck import PartCheckError
from .photos import PhotoError
from .realtime import ALERT_PREFIX, RealtimeError, create_client_secret
from .station import StationError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("cockpit")


class ToolRequest(BaseModel):
    sensor: str = "s1"
    window_s: float | None = None


class ChatRequest(BaseModel):
    items: list[dict[str, Any]] = Field(..., min_length=1, max_length=20)
    previous_response_id: str | None = None


class PartLearnRequest(BaseModel):
    kind: str = "part"                      # part (a good part) or empty (nothing under the sensor)
    add: bool = False                       # true: one more good part, the band grows to cover it
    margin_um: float | None = None          # allowed deviation around the taught parts, in µm


class PartMarginRequest(BaseModel):
    margin_um: float


class PartForgetRequest(BaseModel):
    what: str = "all"                       # all, part or empty


class ReportRequest(BaseModel):
    event_id: str | None = None


def create_app(settings: Settings | None = None,
               openai_factory: Callable[[], httpx.AsyncClient] | None = None) -> FastAPI:
    settings = settings or load_settings()
    hub = Hub()
    engine = Engine(settings, hub)
    openai = OpenAIClient(settings.openai_api_key, base_url=settings.openai_base_url, factory=openai_factory)
    knowledge = KnowledgeBase(settings.knowledge_dir, openai, settings.embed_model)

    def active_product() -> str | None:
        """The sensor the manuals answer for: the model the SensorFinder found, else the configured one."""
        for cfg in settings.sensors:
            found = getattr(engine.sources.get(cfg.id), "found", None)
            if found is not None and getattr(found, "model", ""):
                return str(found.model)
            if cfg.model:
                return cfg.model
        return None

    rag = ManualRag([settings.knowledge_dir, *settings.manual_library], openai,
                    embedding_model=settings.embed_model, answer_model=settings.answer_model,
                    reasoning_effort=settings.answer_reasoning, embedding_dimensions=settings.embed_dimensions,
                    background=True, active_product=active_product)
    for warning in knowledge.warnings:
        log.warning("manual skipped: %s", warning)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await engine.start()
        if openai.enabled and knowledge.passages:
            warm = asyncio.ensure_future(knowledge.warm())
            app.state.warm = warm
        rag.warm_in_background()
        log.info("manuals: %d documents, %d passages", len(knowledge.documents), len(knowledge.passages))
        log.info("cockpit ready on http://localhost:%s (voice %s)", settings.port,
                 "on, model " + settings.realtime_model if settings.voice_enabled else "off")
        yield
        await engine.stop()

    app = FastAPI(title="KI Sensor Cockpit", version=__version__, lifespan=lifespan)
    app.state.engine = engine
    app.state.settings = settings
    app.state.knowledge = knowledge
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["*"], allow_headers=["*"])

    def require_token(x_cockpit_token: str | None = Header(default=None)) -> None:
        if settings.cockpit_token and x_cockpit_token != settings.cockpit_token:
            raise HTTPException(status_code=401, detail="Missing or wrong cockpit token. "
                                "Open the cockpit once with ?token=<COCKPIT_TOKEN>.")

    def sensor_or_400(text: str | None) -> str:
        try:
            return engine.resolve_sensor(text)
        except EngineError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    def public_config() -> dict[str, Any]:
        return {
            "title": settings.cockpit.title,
            "team": settings.cockpit.team,
            "assistant_name": settings.cockpit.assistant_name,
            "language": settings.cockpit.language,
            "sensors": [s.public() for s in settings.sensors],
            "voice": {"enabled": settings.voice_enabled, "model": settings.realtime_model},
            "token_required": bool(settings.cockpit_token),
            "alert_prefix": ALERT_PREFIX,
            "version": __version__,
        }

    # -- REST: read-only -----------------------------------------------------

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "uptime_s": round(time.time() - engine.started_at)}

    @app.get("/api/config")
    def config() -> dict[str, Any]:
        return public_config()

    @app.get("/api/status")
    def status() -> dict[str, Any]:
        return engine.status_message()

    @app.get("/api/events")
    def events(limit: int = Query(50, ge=1, le=300)) -> dict[str, Any]:
        return {"events": engine.recent_events(limit)}

    @app.get("/api/history")
    def history(sensors: str = "s1", window_s: float = 300.0,
                max_points: int = Query(1200, ge=50, le=5000)) -> dict[str, Any]:
        ids = [sensor_or_400(s) for s in sensors.split(",") if s.strip()]
        return views.history(engine, ids or [sensor_or_400(None)], window_s, max_points)

    @app.get("/api/explore")
    def explore_chart(chart: str, sensors: str = "s1", window_s: float | None = None,
                      group_by: str | None = None, metric: str | None = None) -> dict[str, Any]:
        ids = [sensor_or_400(s) for s in sensors.split(",") if s.strip()] or [sensor_or_400(None)]
        try:
            return explore.build(engine, chart, ids, window_s, group_by, metric)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/insights")
    def chart_insights(view: str, sensors: str = "s1", window_s: float | None = None,
                       event_id: str | None = None) -> dict[str, Any]:
        """The steps for explaining one of the live chart views."""
        ids = [sensor_or_400(s) for s in sensors.split(",") if s.strip()] or [sensor_or_400(None)]
        if view == "timeseries":
            steps = insights.for_history(engine, views.history(engine, ids[:1], window_s or 300.0))
        else:
            raise HTTPException(status_code=400, detail=f"no explanation for view {view!r}")
        return {"view": view, "insights": steps}

    # -- REST: AI tools ------------------------------------------------------

    @app.post("/api/tools/get_data")
    def tool_get_data(req: ToolRequest) -> dict[str, Any]:
        try:
            return tools.get_data(engine, req.sensor, req.window_s or 10.0)
        except EngineError as exc:
            return {"ok": False, "error": str(exc)}

    @app.post("/api/tools/analyze")
    def tool_analyze(req: ToolRequest) -> dict[str, Any]:
        try:
            return tools.analyze(engine, req.sensor, req.window_s or 60.0)
        except EngineError as exc:
            return {"ok": False, "error": str(exc)}

    @app.post("/api/tools/create_report")
    def tool_create_report(req: ReportRequest) -> dict[str, Any]:
        try:
            rep = report.build(engine, req.event_id)
        except report.ReportError as exc:
            return {"ok": False, "error": str(exc)}
        hub.broadcast({"type": "report", "id": rep["id"], "title": rep["title"]}, kinds=(COCKPIT,))
        return {"ok": True, "id": rep["id"], "title": rep["title"], "url": f"/report/{rep['id']}",
                "likely_causes": rep["causes"], "next_steps": rep["actions"]}

    # -- REST: part check (teach one part, flag every other) ---------------------

    @app.get("/api/part/{sensor}")
    def part_state(sensor: str) -> dict[str, Any]:
        return engine.partcheck.public(sensor_or_400(sensor))

    @app.post("/api/part/{sensor}/learn", dependencies=[Depends(require_token)])
    def part_learn(sensor: str, req: PartLearnRequest) -> dict[str, Any]:
        sid = sensor_or_400(sensor)
        try:
            return engine.partcheck.learn(sid, engine.buffers[sid], req.kind, req.add, req.margin_um)
        except PartCheckError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/part/{sensor}/margin", dependencies=[Depends(require_token)])
    def part_margin(sensor: str, req: PartMarginRequest) -> dict[str, Any]:
        try:
            return engine.partcheck.set_margin(sensor_or_400(sensor), req.margin_um)
        except PartCheckError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/part/{sensor}/forget", dependencies=[Depends(require_token)])
    def part_forget(sensor: str, req: PartForgetRequest) -> dict[str, Any]:
        return engine.partcheck.forget(sensor_or_400(sensor), req.what)

    # -- REST: quality station (every part that rested under the sensor) ------------

    @app.get("/api/parts/{sensor}")
    def parts(sensor: str, limit: int = Query(100, ge=1, le=5000)) -> dict[str, Any]:
        sid = sensor_or_400(sensor)
        return {"sensor": sid, **engine.station.public(sid, time.time(), limit=limit)}

    @app.get("/api/parts/{sensor}/csv", include_in_schema=False)
    def parts_csv(sensor: str) -> PlainTextResponse:
        """The part log as a table for Excel: one row per part."""
        sid = sensor_or_400(sensor)
        rows = ["part;start;stay_s;gap_s;verdict;height_mm;top_surface_mm;difference_to_taught_mm;notes"]
        for r in engine.station.records(sid):
            when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r.t_start))
            mm = (lambda v: "" if v is None else f"{v / 1000.0:.4f}".replace(".", ","))
            rows.append(";".join([str(r.number), when, f"{r.dwell_s:.2f}".replace(".", ","),
                                  "" if r.gap_s is None else f"{r.gap_s:.2f}".replace(".", ","), r.verdict,
                                  mm(r.height_um), mm(r.position_um), mm(r.deviation_um), " ".join(r.flags)]))
        name = f"part-log-{settings.sensor(sid).name.replace(' ', '-')}.csv"
        return PlainTextResponse("\ufeff" + "\r\n".join(rows) + "\r\n", media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.post("/api/parts/{sensor}/reset", dependencies=[Depends(require_token)])
    def parts_reset(sensor: str) -> dict[str, Any]:
        sid = sensor_or_400(sensor)
        try:
            data = engine.station.new_run(sid, time.time())
            engine.photos.clear(sid)
        except StationError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        hub.broadcast({"type": "part", "sensor": sid, "part": None, "station": data}, kinds=(COCKPIT, PHONE))
        return {"sensor": sid, **data}

    @app.get("/api/reports/{event_id}")
    def report_json(event_id: str) -> dict[str, Any]:
        try:
            return report.build(engine, event_id)
        except report.ReportError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    # -- camera pictures and part passports ----------------------------------------

    @app.post("/api/parts/{sensor}/{number}/photo", dependencies=[Depends(require_token)])
    async def part_photo(sensor: str, number: int, request: Request) -> dict[str, Any]:
        """The cockpit's camera picture of a part while it rests under the sensor (a JPEG body)."""
        sid = sensor_or_400(sensor)
        try:
            url = engine.photos.save(sid, number, await request.body())
        except PhotoError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"ok": True, "url": url}

    @app.get("/photos/{sensor}/{number}.jpg", include_in_schema=False)
    def photo_file(sensor: str, number: int) -> FileResponse:
        try:
            path = engine.photos.path(sensor, number)
        except PhotoError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if not path.is_file():
            raise HTTPException(status_code=404, detail="no picture of this part")
        return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})

    @app.get("/part/{sensor}/{number}", include_in_schema=False)
    def passport_page(sensor: str, number: int, embed: bool = False) -> HTMLResponse:
        page = report.render_passport_html(engine, sensor_or_400(sensor), number, embed=embed)
        if page is None:
            return HTMLResponse(f"<h1>Part {number}</h1><p>This part is not in the part log (yet). A part is "
                                "logged when it leaves the sensor.</p>", status_code=404)
        return HTMLResponse(page)

    @app.get("/run-report/{sensor}", include_in_schema=False)
    def run_report_page(sensor: str, embed: bool = False) -> HTMLResponse:
        """Every part and every alert of the current run of the quality station, one page."""
        return HTMLResponse(report.render_run_html(engine, sensor_or_400(sensor), embed=embed))

    @app.get("/report/{event_id}", include_in_schema=False)
    def report_page(event_id: str, embed: bool = False) -> HTMLResponse:
        try:
            return HTMLResponse(report.render_html(report.build(engine, event_id), embed=embed))
        except report.ReportError as exc:
            return HTMLResponse(f"<h1>No report</h1><p>{exc}</p>", status_code=404)

    # -- REST: voice ---------------------------------------

    @app.post("/api/realtime/session", dependencies=[Depends(require_token)])
    async def realtime_session() -> dict[str, Any]:
        try:
            return await create_client_secret(settings)
        except RealtimeError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.post("/api/chat", dependencies=[Depends(require_token)])
    async def chat_turn(req: ChatRequest) -> dict[str, Any]:
        """The typed chat when voice is off: one model turn, the browser runs the tool calls."""
        try:
            return await chat.respond(settings, openai, req.items, req.previous_response_id)
        except chat.ChatError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    @app.get("/api/auth/check", dependencies=[Depends(require_token)])
    def auth_check() -> dict[str, bool]:
        return {"ok": True}

    app.state.rag = rag
    add_knowledge_routes(app, knowledge, require_token, rag=rag)

    # -- WebSockets ----------------------------------------------------------

    async def serve_socket(ws: WebSocket, kind: str, hello: dict[str, Any]) -> None:
        await ws.accept()
        client = hub.add(ws, kind)
        hub.send(client, hello)
        pump = asyncio.create_task(hub.pump(client))
        try:
            while True:
                message = await ws.receive_text()
                if message == "ping":
                    hub.send(client, {"type": "pong", "t": time.time()})
        except WebSocketDisconnect:
            pass
        finally:
            pump.cancel()
            hub.remove(client)

    @app.websocket("/ws/cockpit")
    async def ws_cockpit(ws: WebSocket) -> None:
        await serve_socket(ws, COCKPIT, {"type": "hello", "config": public_config(),
                                         "events": engine.recent_events(30),
                                         "status": engine.status_message()})

    @app.websocket("/ws/phone")
    async def ws_phone(ws: WebSocket) -> None:
        await serve_socket(ws, PHONE, {
            "type": "hello",
            "title": settings.cockpit.title,
            "team": settings.cockpit.team,
            "sensors": [{"id": s.id, "name": s.name} for s in settings.sensors],
            "events": engine.recent_events(5),
        })

    # -- Frontend ------------------------------------------------------------

    def frontend_file(name: str) -> FileResponse | HTMLResponse:
        path = FRONTEND_DIST / name
        if path.exists():
            return FileResponse(path)
        return HTMLResponse(
            "<h1>Frontend not built</h1><p>Run <code>npm install</code> and <code>npm run build</code> "
            "in the <code>frontend</code> folder, or use the dev server at "
            "<a href='http://localhost:5173'>http://localhost:5173</a>.</p>", status_code=503)

    @app.get("/", include_in_schema=False)
    def index() -> Any:
        return frontend_file("index.html")

    @app.get("/phone", include_in_schema=False)
    def phone() -> Any:
        return frontend_file("phone.html")

    @app.get("/{path:path}", include_in_schema=False)
    def static_files(path: str) -> Any:
        if path.startswith(("api/", "ws/")):
            raise HTTPException(status_code=404)
        candidate = (FRONTEND_DIST / path).resolve()
        if FRONTEND_DIST.exists() and candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        # "/phone/" or a doubled "/phone/phone" (QR scanners, pasted links) must
        # still open the phone page, never the full cockpit
        if path.rstrip("/").split("/")[0] == "phone":
            return frontend_file("phone.html")
        return frontend_file("index.html")

    return app


app = create_app()
