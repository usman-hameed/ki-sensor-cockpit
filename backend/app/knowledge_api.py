"""HTTP routes for the manuals. Mounted by main.create_app.

Reading what is loaded and what was already prepared is open, like the rest of the
read-only API. Everything that writes a file or spends API credit needs the cockpit
token.

Questions (the Manuals panel's question box and the copilot's search_manual tool)
are answered by manual_rag.ManualRag: section- and page-exact passages and a
written answer that cites them. The manual list and its keyword search stay in knowledge.py.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable
from urllib.parse import quote, unquote

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .knowledge import KnowledgeBase, KnowledgeError, clean_name, parse_document
from .manual_rag import KnowledgeBase as ManualRag
from .manual_rag import KnowledgeError as RagError


class SearchRequest(BaseModel):
    query: str
    k: int = 5
    product: str | None = None              # a model such as ILD1420; empty = from the question or sensor


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=500)
    product: str | None = None


MANUAL_RULE = ("Answer only from these passages and name the document and page. If they do not answer the question, "
               "say the loaded manuals do not cover it. Speak only numbers that appear in the passages.")


async def search_manual(kb: KnowledgeBase, query: str, limit: int = 4) -> dict[str, Any]:
    query = " ".join(str(query or "").split())
    if not query:
        return {"ok": False, "error": "Give a question or a few keywords to look up."}
    if not kb.documents:
        return {"ok": True, "documents": 0, "passages": [],
                "message": "No manual is loaded. Add manuals in the Manuals panel first."}
    hits = await kb.search(query, k=limit)
    return {"ok": True, "speak_rule": MANUAL_RULE, "query": query, "documents": len(kb.documents),
            "passages": [{"id": f"P{n}", **hit.passage.public(hit.score)} for n, hit in enumerate(hits, 1)],
            "message": "" if hits else "Nothing in the loaded manuals matches this."}


def add_routes(app: FastAPI, kb: KnowledgeBase, require_token: Callable[..., None],
               rag: ManualRag | None = None) -> None:
    background: set[asyncio.Future[Any]] = set()

    def full_status() -> dict[str, Any]:
        return {**kb.status(), "ai": bool(kb.client and kb.client.enabled)}

    # -- manuals -------------------------------------------------------------------

    @app.get("/api/knowledge")
    async def knowledge_status() -> dict[str, Any]:
        return full_status()

    @app.post("/api/knowledge/upload", dependencies=[Depends(require_token)])
    async def knowledge_upload(request: Request) -> dict[str, Any]:
        raw = await request.body()
        name = unquote(request.headers.get("x-file-name", "")).strip() or "manual.pdf"
        try:
            parsed = await asyncio.to_thread(parse_document, name, raw)
        except KnowledgeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        document = kb.add_parsed(parsed, raw)
        task = asyncio.ensure_future(kb.warm())
        background.add(task)
        task.add_done_callback(background.discard)
        return {"document": document, **full_status()}

    @app.get("/api/knowledge/file/{name}")
    async def knowledge_file(name: str) -> FileResponse:
        """The manual itself, so a quote can link to its page (PDF viewers open `#page=N`)."""
        try:
            clean = clean_name(name)
        except KnowledgeError as exc:
            raise HTTPException(status_code=404, detail="no such manual") from exc
        document = kb.documents.get(clean)
        if document is None:
            raise HTTPException(status_code=404, detail=f"no manual called {clean!r}")
        media = {"pdf": "application/pdf", "markdown": "text/markdown; charset=utf-8",
                 "text": "text/plain; charset=utf-8"}[document.kind]
        return FileResponse(kb.folder / clean, media_type=media,
                            headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(clean)}"})

    @app.delete("/api/knowledge/{name}", dependencies=[Depends(require_token)])
    async def knowledge_delete(name: str) -> dict[str, Any]:
        try:
            found = kb.remove(name)
        except KnowledgeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        if not found:
            raise HTTPException(status_code=404, detail=f"no manual called {name!r}")
        return full_status()

    @app.post("/api/knowledge/search", dependencies=[Depends(require_token)])
    async def knowledge_search(req: SearchRequest) -> dict[str, Any]:
        hits = await kb.search(req.query, k=req.k)
        return {"hits": [h.passage.public(h.score) | {"via": h.via} for h in hits]}

    @app.post("/api/knowledge/ask", dependencies=[Depends(require_token)])
    async def knowledge_ask(req: AskRequest) -> dict[str, Any]:
        """A written answer from the manuals, every value cited with document, section and page."""
        if rag is None:
            raise HTTPException(status_code=503, detail="Manual answers are not set up.")
        try:
            return await asyncio.to_thread(rag.answer, req.question, 8, None, req.product)
        except RagError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # -- copilot tool -------------------------------------------------------------------

    @app.post("/api/tools/search_manual", dependencies=[Depends(require_token)])
    async def tool_search_manual(req: SearchRequest) -> dict[str, Any]:
        if rag is None:
            return await search_manual(kb, req.query, limit=max(1, min(req.k, 6)))
        if not " ".join(req.query.split()):
            return {"ok": False, "error": "Give a question or a few keywords to look up."}
        return await asyncio.to_thread(rag.tool_result, req.query, None, max(1, min(req.k, 6)), req.product)

    # -- the manual library behind the answers ---------------------------------------

    @app.get("/api/knowledge/library")
    async def library_status() -> dict[str, Any]:
        """How far the library is indexed, which product the answers are scoped to."""
        if rag is None:
            return {"state": "off"}
        return rag.status()

    @app.get("/api/knowledge/library/{name}")
    async def library_file(name: str) -> FileResponse:
        """A manual of the library, so a citation can open it at its page (#page=N)."""
        path = rag.file_path(name) if rag is not None else None
        if path is None or not path.is_file():
            raise HTTPException(status_code=404, detail=f"no manual called {name!r}")
        media = "application/pdf" if path.suffix.lower() == ".pdf" else "text/plain; charset=utf-8"
        return FileResponse(path, media_type=media,
                            headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(path.name)}"})
