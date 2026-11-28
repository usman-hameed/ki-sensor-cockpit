"""Manual Q&A (RAG): written answers from the sensor manuals, with section and page.

It reads the same folder as the manual list (``backend/data/knowledge``, see
knowledge.py), so a manual added or removed under Manuals is picked up on the
next question. knowledge.py keeps the manual list and its keyword search; this
module answers the operator's questions in the Manuals panel, the chat and the
voice tool search_manual.

On first use the folder is read into chunks that never cross a section or a page, so every
passage carries an exact citation: document, section number and title, the
page number printed on the page, and any table or figure caption on it.
Footnotes a passage refers to (``[6]``) are attached to it, because on
datasheets the test conditions live in the footnotes.

Search is BM25 over those chunks and works offline. With ``OPENAI_API_KEY``
set, the chunks are also embedded once (cached on disk) and both rankings are
fused, so "how hot can it get" still finds "Temperature range". The voice
copilot gets the passages from :meth:`KnowledgeBase.tool_result` and phrases
the answer itself; :meth:`KnowledgeBase.answer` writes a grounded text answer
for typed questions, or quotes the best lines when there is no key.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

import numpy as np

from .openai_client import OpenAIClient, OpenAIError

log = logging.getLogger("cockpit.knowledge")
# the PDF reader warns about every rotated label and font it cannot fully decode; the text is still read
logging.getLogger("pypdf").setLevel(logging.ERROR)

INDEX_VERSION = 8
DOC_SUFFIXES = (".pdf", ".md", ".markdown", ".txt")
# notes that live in the manuals folder but are not manuals
IGNORED_FILES = frozenset({"readme.md", ".gitkeep"})
MAX_CHUNK_CHARS = 1000
EMBED_BATCH = 96
RRF_K = 60.0
# meaning outvotes loose keyword matches: "how hot can it get" must find "Temperature range"
SEMANTIC_WEIGHT = 1.6
# the best matches by meaning that always stay among the results (cross-language: German datasheets)
KEEP_SEMANTIC = 3
# cosine similarity below which an embedding-only match does not count as found
MIN_SEMANTIC = 0.30
# how the copilot must use the passages it gets from search_manual
SPEAK_RULE = ("Answer only from these passages. They are from the manuals of the product named in scope; never "
              "apply them to another product. Keep exact numbers, units, min/typ/max and test conditions. Say "
              "which product and model the value is for. Name the document, section and page (cite).")

STOPWORDS = frozenset("""
a an and are as at be by can do does for from has have how i if in into is it its me my of on or
please say tell than that the their them then there these this to us was what when where which who
why will with you your about give show find manual datasheet sensor sensors value values
der die das ein eine und ist im in den dem des zu mit von wie was wo welche welcher welches
für auf bei aus oder nicht sind wird werden kann ich mir sie es handbuch datenblatt
""".split())

_TOKEN_RE = re.compile(r"[\wµ°±]+(?:[-.,/][\wµ°±]+)*")
_PAGE_FOOTER_RE = re.compile(r"\bPage\s+(\d{1,4})\s*$", re.IGNORECASE)
_TOC_LINE_RE = re.compile(r"^\s*(\d+(?:\.\d+)*)\s+(.+?)\s*\.{4,}\s*(\d+)\s*$")
_HEADING_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,4})\s{2,}([A-Za-zÄÖÜäöü].{1,100})$")
_FOOTNOTE_RE = re.compile(r"^\[(\d{1,3})\]\s+(\S.*)$")
_FOOTNOTE_REF_RE = re.compile(r"(?<!^)\[(\d{1,3})\]")
_CAPTION_RE = re.compile(r"^((?:Tab|Fig)\.\s*\d+(?:\.\d+)*)\s*:?\s*(.*)$")
_MD_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


class KnowledgeError(RuntimeError):
    pass


# -- text helpers ----------------------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _stem(token: str) -> str:
    """Crude but robust: drop a plural and keep the first six letters, so that
    'operating', 'operation' and 'operational' all become 'operat'."""
    if not token.isalpha():
        return token
    if len(token) > 4 and token.endswith("ies"):
        token = token[:-3] + "y"
    elif len(token) > 4 and token.endswith("s") and not token.endswith("ss"):
        token = token[:-1]
    return token[:6]


def tokenize(text: str) -> list[str]:
    """Lower-case words; 'ILD5500-10' gives 'ild5500-10', 'ild5500' and '10'."""
    out: list[str] = []
    for match in _TOKEN_RE.findall(text.lower()):
        parts = [p for p in re.split(r"[-./,]", match) if p]
        if len(parts) > 1 and not all(p.isdigit() for p in parts):
            out.append(match)
        for part in parts:
            if part not in STOPWORDS and (len(part) > 1 or part.isdigit()):
                out.append(_stem(part))
    return out


def _tidy(line: str) -> str:
    """Layout text uses runs of spaces for table columns; keep them as ' | '."""
    return re.sub(r" {3,}", " | ", line.strip())


# -- chunks ----------------------------------------------------------------------

_DOC_KINDS = {"dat": "Datasheet", "man": "Manual", "maq": "Quick guide", "mav": "Interface manual",
              "set": "Setup guide", "cat": "Catalogue"}


def doc_label(filename: str) -> str:
    """A short name for citations, from Micro-Epsilon's file names:
    'dat--optoNCDT-ILD5500-10DR--de.pdf' gives 'Datasheet ILD5500-10DR (de)',
    'man--optoNCDT-5500-EtherCAT--en.pdf' gives 'Manual 5500 EtherCAT'.
    Any other file name is used as it is, without its extension."""
    stem = Path(filename).stem
    m = re.match(r"^(dat|man|maq|mav|set|cat)--(.+?)(?:-{1,2}(de-en|de|en))?$", stem, re.IGNORECASE)
    if not m:
        return stem
    name = re.sub(r"^optoNCDT-", "", m.group(2), flags=re.IGNORECASE).replace("--", " ").replace("-", " ")
    name = re.sub(r"\bILD(\d+) (\d+\w*)", r"ILD\1-\2", name)  # keep model numbers such as ILD5500-10DR whole
    lang = (m.group(3) or "").lower()
    return f"{_DOC_KINDS[m.group(1).lower()]} {name}" + (" (de)" if lang == "de" else "")

@dataclass
class Chunk:
    id: str
    doc: str                 # file name
    doc_title: str
    section: str             # "3.3" or ""
    section_title: str
    page: int | None         # page in the PDF file, from 1
    printed_page: int | None  # the number printed in the page footer
    labels: list[str] = field(default_factory=list)   # "Tab. 3.1: LEDs on the receiver"
    footnotes: list[str] = field(default_factory=list)
    text: str = ""

    def citation(self) -> str:
        parts = [doc_label(self.doc)]
        if self.section:
            parts.append(f"Section {self.section} {self.section_title}".strip())
        elif self.section_title:
            parts.append(self.section_title)
        parts.extend(label.split(":")[0] for label in self.labels[:2])
        page = self.printed_page or self.page
        if page:
            parts.append(f"Page {page}")
        return ", ".join(p for p in parts if p) or self.doc_title

    def search_text(self) -> str:
        head = f"{self.section} {self.section_title}"
        # The document title is left out on purpose: in every chunk it would make words like
        # "operating" (from "Operating Instructions") worthless. See KnowledgeBase._doc_bonus.
        return " ".join([head, head, " ".join(self.labels), self.text, " ".join(self.footnotes)])


@dataclass
class _Page:
    number: int
    printed: int | None
    lines: list[str]


def _read_pdf(path: Path) -> list[_Page]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - listed in requirements.txt
        raise KnowledgeError("pypdf is missing: run pip install -r requirements.txt") from exc
    reader = PdfReader(str(path))
    pages: list[_Page] = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text(extraction_mode="layout")
        except Exception:  # noqa: BLE001 - some pages only work in plain mode
            text = page.extract_text() or ""
        pages.append(_Page(i, None, [ln.rstrip() for ln in text.splitlines()]))
    return pages


def _strip_furniture(pages: list[_Page]) -> None:
    """Remove running headers and footers; keep the printed page number."""
    edge = Counter()
    for page in pages:
        filled = [ln.strip() for ln in page.lines if ln.strip()]
        edge.update(set(filled[:1] + filled[-1:]))
    repeated = {line for line, n in edge.items() if n >= 3 and len(line) < 120}
    for page in pages:
        lines = page.lines
        for idx in range(len(lines) - 1, -1, -1):
            if lines[idx].strip():
                match = _PAGE_FOOTER_RE.search(lines[idx])
                if match:
                    page.printed = int(match.group(1))
                    lines[idx] = ""
                break
        filled = [i for i, ln in enumerate(lines) if ln.strip()]
        for idx in filled[:1] + filled[-1:]:
            if lines[idx].strip() in repeated:
                lines[idx] = ""


def _toc(pages: list[_Page]) -> tuple[dict[str, str], set[int]]:
    """Section numbers and titles from the table of contents, and the TOC pages."""
    entries: dict[str, str] = {}
    toc_pages: set[int] = set()
    for page in pages:
        filled = [ln for ln in page.lines if ln.strip()]
        hits = [m for m in (_TOC_LINE_RE.match(ln) for ln in filled) if m]
        if filled and len(hits) >= max(5, len(filled) * 0.4):
            toc_pages.add(page.number)
            for m in hits:
                entries.setdefault(m.group(1), re.sub(r"\s+", " ", m.group(2)).strip())
    return entries, toc_pages


def _match_heading(line: str, toc: dict[str, str]) -> tuple[str, str] | None:
    m = _HEADING_RE.match(line.strip())
    if not m:
        return None
    number, title = m.group(1), re.sub(r"\s+", " ", m.group(2)).strip()
    if toc:
        known = toc.get(number)
        if known is None:
            return None
        a, b = _norm(title)[:24], _norm(known)[:24]
        if not (a.startswith(b[:12]) or b.startswith(a[:12])):
            return None
        return number, known
    if "|" in _tidy(title) or len(title) > 90:
        return None
    return number, title


def _page_footnotes(lines: list[str]) -> dict[str, str]:
    notes: dict[str, str] = {}
    current: str | None = None
    for raw in lines:
        line = raw.strip()
        m = _FOOTNOTE_RE.match(line)
        if m:
            current = m.group(1)
            notes[current] = m.group(2).strip()
        elif current and line and not _HEADING_RE.match(line):
            notes[current] += " " + line
        else:
            current = None
    return {k: re.sub(r"\s+", " ", v) for k, v in notes.items()}


def _split_blocks(lines: list[str], limit: int) -> list[str]:
    """Join lines into pieces of at most ``limit`` characters, cutting at blank lines."""
    blocks: list[list[str]] = [[]]
    for line in lines:
        if line.strip():
            blocks[-1].append(_tidy(line))
        elif blocks[-1]:
            blocks.append([])
    pieces: list[str] = []
    current = ""
    for block in (b for b in blocks if b):
        text = "\n".join(block)
        if len(text) > limit:  # a long table: cut it by lines
            for line in block:
                if current and len(current) + len(line) + 1 > limit:
                    pieces.append(current)
                    current = ""
                current = f"{current}\n{line}" if current else line
            continue
        if current and len(current) + len(text) + 2 > limit:
            pieces.append(current)
            current = ""
        current = f"{current}\n\n{text}" if current else text
    if current.strip():
        pieces.append(current)
    return pieces


def _doc_title(path: Path, pages: list[_Page]) -> str:
    for page in pages[:1]:
        filled = [ln.strip() for ln in page.lines if ln.strip()]
        if filled:
            return " ".join(_tidy(ln) for ln in filled[:2]).replace(" | ", " ")[:90]
    return path.stem


def chunk_pdf(path: Path) -> list[Chunk]:
    pages = _read_pdf(path)
    title = _doc_title(path, pages)
    _strip_furniture(pages)
    toc, toc_pages = _toc(pages)
    notes_by_page = {p.number: _page_footnotes(p.lines) for p in pages}
    chunks: list[Chunk] = []
    section, section_title = "", ""
    for page in pages:
        if page.number in toc_pages:
            continue
        if page.number == 1 and toc and not any(_match_heading(ln, toc) for ln in page.lines):
            continue  # the cover: model names and an address, no content
        # cut the page wherever a section starts
        runs: list[tuple[str, str, list[str]]] = [(section, section_title, [])]
        for line in page.lines:
            heading = _match_heading(line, toc)
            if heading:
                section, section_title = heading
                runs.append((section, section_title, [line.strip()]))
            else:
                runs[-1][2].append(line)
        for sec, sec_title, lines in runs:
            labels = []
            for line in lines:
                m = _CAPTION_RE.match(line.strip())
                if m:
                    labels.append(f"{m.group(1)}: {m.group(2).strip()}".rstrip(": "))
            for piece in _split_blocks(lines, MAX_CHUNK_CHARS):
                chunks.append(Chunk(
                    id="", doc=path.name, doc_title=title, section=sec, section_title=sec_title,
                    page=page.number, printed_page=page.printed, labels=labels,
                    footnotes=_footnotes_for(piece, page.number, notes_by_page), text=piece))
    return chunks


def _footnotes_for(text: str, page: int, notes_by_page: dict[int, dict[str, str]]) -> list[str]:
    refs: list[str] = []
    for line in text.splitlines():
        for ref in _FOOTNOTE_REF_RE.findall(line.strip()):
            if ref not in refs:
                refs.append(ref)
    out = []
    for ref in refs:
        if re.search(rf"(^|\n)\[{ref}\]\s", text):
            continue  # the footnote itself is already in this passage
        for candidate in (page, page + 1, page - 1):
            note = notes_by_page.get(candidate, {}).get(ref)
            if note:
                out.append(f"[{ref}] {note}")
                break
    return out


def chunk_text(path: Path) -> list[Chunk]:
    text = path.read_text(encoding="utf-8", errors="replace")
    chunks: list[Chunk] = []
    title = path.stem
    heading, lines = "", []

    def flush() -> None:
        for piece in _split_blocks(lines, MAX_CHUNK_CHARS):
            chunks.append(Chunk(id="", doc=path.name, doc_title=title, section="", section_title=heading,
                                page=None, printed_page=None, text=piece))

    for line in text.splitlines():
        m = _MD_HEADING_RE.match(line)
        if m:
            flush()
            heading, lines = m.group(2), []
            if len(m.group(1)) == 1 and title == path.stem:
                title = heading
        else:
            lines.append(line)
    flush()
    return chunks


def chunk_file(path: Path) -> list[Chunk]:
    return chunk_pdf(path) if path.suffix.lower() == ".pdf" else chunk_text(path)


# -- BM25 --------------------------------------------------------------------------

class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 0.9, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.n = len(docs)
        self.lengths = np.array([len(d) for d in docs], dtype=float)
        self.avg = float(self.lengths.mean()) if self.n else 1.0
        self.postings: dict[str, list[tuple[int, int]]] = {}
        for i, doc in enumerate(docs):
            for term, tf in Counter(doc).items():
                self.postings.setdefault(term, []).append((i, tf))

    def idf(self, term: str) -> float:
        df = len(self.postings.get(term, ()))
        return math.log(1.0 + (self.n - df + 0.5) / (df + 0.5)) if df else 0.0

    def scores(self, query: list[str]) -> np.ndarray:
        out = np.zeros(self.n)
        for term in set(query):
            idf = self.idf(term)
            for i, tf in self.postings.get(term, ()):
                denom = tf + self.k1 * (1 - self.b + self.b * self.lengths[i] / self.avg)
                out[i] += idf * tf * (self.k1 + 1) / denom
        return out


# -- products: which sensor a manual is about --------------------------------------------

# model prefixes the operator or MEDAQLib's SensorFinder use, and the product family of their manuals
_FAMILY_ALIASES = {
    "ild": "optoncdt", "ilr": "optoncdt", "ifc": "confocaldt", "ifd": "confocaldt", "ims": "interferometer",
    "llt": "scancontrol", "odc": "optocontrol", "acs": "colorcontrol", "cfo": "colorsensor", "dt": "",
}
# a number that is a quantity, not a model: "4000 Hz", "1024 port" stays a model only if a manual has it
_UNIT_AFTER = re.compile(r"\s*(mm|µm|um|nm|hz|khz|mhz|v|vdc|ma|w|°|%|ms|s|lux|bit|baud|kb|mb)\b", re.IGNORECASE)
_MODEL_NUMBER = re.compile(r"(?<![\d.,])(\d{3,4})(?![\d.,])")


@dataclass(frozen=True)
class Product:
    """What a manual is about, read from Micro-Epsilon's file name ('man--optoNCDT-5500-EtherCAT--en.pdf')."""

    family: str                      # "optoncdt"
    name: str                        # "optoNCDT 5500 EtherCAT"
    numbers: tuple[str, ...]         # model number patterns, x = any digit: ("5500",), ("29xx",), ("61x4",)

    def matches_number(self, number: str) -> bool:
        return any(len(p) == len(number) and all(a in ("x", b) for a, b in zip(p, number)) for p in self.numbers)


def product_of(filename: str) -> Product:
    stem = Path(filename).stem
    stem = re.sub(r"^(dat|man|maq|mav|set|cat)--", "", stem, flags=re.IGNORECASE)
    stem = re.sub(r"-{1,2}(de-en|en|de)$", "", stem, flags=re.IGNORECASE)
    parts = [p for p in re.split(r"[-_ ]+", stem) if p]
    family = parts[0].lower() if parts and not parts[0][0].isdigit() else ""
    numbers = []
    for part in parts:
        m = re.fullmatch(r"[A-Za-z]*(\d[\dxX]{2,3})[A-Za-z]*", part)
        if m and re.search(r"\d", m.group(1)):
            numbers.append(m.group(1).lower())
    return Product(family, " ".join(parts), tuple(dict.fromkeys(numbers)))


def mentioned_products(text: str, products: dict[str, Product]) -> set[str]:
    """The documents whose product a question or a model text names.

    A model number picks the manuals that cover it; a family named next to it ("ILD5500", "optoNCDT 5500")
    keeps out other families that happen to share the number (interferoMETER 5x00). Without a number the
    family decides, narrowed by a variant name such as thermoMETER "CT" or "CSL" when one is given.
    """
    text = str(text or "")
    words = {w.lower() for w in re.findall(r"[A-Za-z]+", text)}
    prefixes = {m.lower() for m in re.findall(r"([A-Za-z]{2,4})[\s-]?\d{3,4}", text)}
    known = {p.family for p in products.values() if p.family}
    families = {f for f in known if f in words}
    families |= {_FAMILY_ALIASES[w] for w in words | prefixes if _FAMILY_ALIASES.get(w)}
    # DT is the controller prefix of two families: DT30xx/DT31xx eddyNCDT, DT6xxx capaNCDT
    for m in re.finditer(r"(?<![A-Za-z])DT\s?-?([36])\d{2,3}", text, re.IGNORECASE):
        families.add("eddyncdt" if m.group(1) == "3" else "capancdt")

    numbers = [m.group(1) for m in _MODEL_NUMBER.finditer(text) if not _UNIT_AFTER.match(text, m.end())]
    docs = {doc for doc, prod in products.items() if any(prod.matches_number(n) for n in numbers)}
    if docs and families:
        same_family = {d for d in docs if products[d].family in families}
        docs = same_family or docs
    if docs:
        return docs

    docs = {doc for doc, prod in products.items() if prod.family in families}
    variants = {doc for doc in docs
                if words & {part.lower() for part in products[doc].name.split()[1:] if part.isalpha()}}
    return variants or docs


# -- indexing one file (also run in worker processes) ---------------------------------------------

def _file_key(path: Path) -> str:
    st = path.stat()
    return hashlib.sha1(f"v{INDEX_VERSION}|{path.name}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:16]


def _index_file(path_text: str, cache_text: str) -> tuple[str, str | None]:
    """Chunk one manual and cache its passages. Returns (file name, error)."""
    path, cache = Path(path_text), Path(cache_text)
    try:
        chunks = chunk_file(path)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps([asdict(c) for c in chunks]), encoding="utf-8")
        return path.name, None
    except Exception as exc:  # noqa: BLE001 - one bad file must not stop the rest
        return path.name, f"{type(exc).__name__}: {exc}"


# -- the knowledge base ----------------------------------------------------------------

class KnowledgeBase:
    """Every manual in the given folders, searchable by keyword and meaning, scoped to one product.

    The library can be large (all operating instructions of a manufacturer). Each file is chunked and
    embedded once and cached on its own, so adding a manual only indexes that manual. With
    ``background=True`` (the cockpit) a changed library is indexed in a worker thread while questions
    are answered from what is ready; without it (scripts, tests) a question waits for the index.
    """

    def __init__(self, folder: Path | list[Path] | tuple[Path, ...], client: OpenAIClient | None = None,
                 embedding_model: str = "text-embedding-3-small", answer_model: str = "gpt-5-mini",
                 cache_dir: Path | None = None, reasoning_effort: str = "low", embedding_dimensions: int = 512,
                 background: bool = False, active_product: Callable[[], str | None] | None = None) -> None:
        folders = [Path(folder)] if isinstance(folder, (str, Path)) else [Path(f) for f in folder]
        self.folders = folders
        self.folder = folders[0]
        # a folder of its own inside the first folder's cache, next to the one knowledge.py keeps
        self.cache_dir = Path(cache_dir) if cache_dir else self.folder / ".cache" / "rag"
        self.client = client or OpenAIClient("")
        self.embedding_model = embedding_model
        self.embedding_dimensions = embedding_dimensions if embedding_model.startswith("text-embedding-3") else 0
        self.answer_model = answer_model
        self.reasoning_effort = reasoning_effort
        self.background = background
        self.active_product = active_product or (lambda: None)
        self._lock = threading.RLock()
        self._build_lock = threading.Lock()
        self._building = False
        self._signature: str | None = None
        self.chunks: list[Chunk] = []
        self.products: dict[str, Product] = {}
        self.paths: dict[str, Path] = {}
        self._bm25: BM25 | None = None
        self._vectors: np.ndarray | None = None       # one row per chunk; zero rows are not embedded yet
        self._embedded = np.zeros(0, dtype=bool)
        self._semantic_error: str | None = None
        self.errors: dict[str, str] = {}
        self.built_at: float | None = None
        self.progress: dict[str, Any] = {"state": "idle", "files": 0, "indexed": 0, "embedded": 0}

    # the library ------------------------------------------------------------

    def files(self) -> list[Path]:
        """Every manual in the folders; a file name that appears twice is read from the first folder."""
        seen: dict[str, Path] = {}
        for folder in self.folders:
            if not folder.is_dir():
                continue
            for p in sorted(folder.iterdir()):
                if (p.is_file() and p.suffix.lower() in DOC_SUFFIXES and not p.name.startswith(".")
                        and p.name.lower() not in IGNORED_FILES and p.name not in seen):
                    seen[p.name] = p
        return list(seen.values())

    def _library_signature(self, files: list[Path]) -> str:
        parts = [f"v{INDEX_VERSION}"] + [f"{p}:{p.stat().st_size}:{int(p.stat().st_mtime)}" for p in files]
        return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]

    def _cache_path(self, path: Path) -> Path:
        return self.cache_dir / "files" / f"{_file_key(path)}.json"

    def _vector_path(self, path: Path) -> Path:
        model = re.sub(r"[^a-z0-9.-]", "_", self.embedding_model.lower())
        return self.cache_dir / "files" / f"{_file_key(path)}-{model}-{self.embedding_dimensions or 'full'}.npy"

    # building ---------------------------------------------------------------

    def ensure(self, force: bool = False, wait_s: float = 20.0) -> None:
        """Index the library when files were added, changed or removed.

        In background mode this starts the work and returns; questions use what is ready meanwhile.
        """
        files = self.files()
        signature = self._library_signature(files)
        if not force and signature == self._signature:
            return
        if not self.background:
            self._build(files, signature)
            return
        with self._lock:
            start = not self._building
            self._building = True
        if start:
            threading.Thread(target=self._build_and_embed, args=(files, signature), name="manual-rag-index",
                             daemon=True).start()
        # a question before the first build is done waits briefly: cached manuals load in seconds
        deadline = time.time() + wait_s
        while not self.chunks and self._building and time.time() < deadline:
            time.sleep(0.2)

    def _build_and_embed(self, files: list[Path], signature: str) -> None:
        try:
            self._build(files, signature)
            self._embed_library()
        except Exception as exc:  # noqa: BLE001 - a broken library must not stop the cockpit
            log.warning("could not index the manuals: %s", exc)
            self.progress["state"] = f"error: {exc}"
        finally:
            with self._lock:
                self._building = False

    def _build(self, files: list[Path], signature: str) -> None:
        with self._build_lock:
            started = time.time()
            self.progress.update(state="indexing", files=len(files), indexed=0)
            missing = [p for p in files if not self._cache_path(p).exists()]
            errors: dict[str, str] = {}
            if missing:
                log.info("manuals: indexing %d of %d files", len(missing), len(files))
                for name, error in self._index_files(missing):
                    if error:
                        errors[name] = error
                        log.warning("could not read %s: %s", name, error)
                    self.progress["indexed"] += 1
            chunks: list[Chunk] = []
            for path in files:
                if path.name in errors:
                    continue
                try:
                    raw = json.loads(self._cache_path(path).read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    errors[path.name] = str(exc)
                    continue
                key = _file_key(path)[:8]
                for n, c in enumerate(raw, start=1):
                    c["id"] = f"{key}-{n}"
                    chunks.append(Chunk(**c))
            bm25 = BM25([tokenize(c.search_text()) for c in chunks])
            with self._lock:
                old = {c.id: i for i, c in enumerate(self.chunks)}
                vectors, embedded = self._carry_vectors(chunks, old)
                self.chunks, self._bm25 = chunks, bm25
                self._vectors, self._embedded = vectors, embedded
                self.paths = {p.name: p for p in files}
                self.products = {p.name: product_of(p.name) for p in files}
                self.errors = errors
                self._signature = signature
                self.built_at = time.time()
            self.progress.update(state="ready" if not self.client.enabled else "embedding",
                                 indexed=len(files), embedded=int(embedded.sum()))
            log.info("manuals indexed: %d passages from %d files in %.1f s",
                     len(chunks), len(files) - len(errors), time.time() - started)

    def _carry_vectors(self, chunks: list[Chunk], old: dict[str, int]) -> tuple[np.ndarray | None, np.ndarray]:
        """Keep the vectors of passages that were already embedded when the library changes."""
        embedded = np.zeros(len(chunks), dtype=bool)
        if self._vectors is None or not len(self._vectors):
            return None, embedded
        vectors = np.zeros((len(chunks), self._vectors.shape[1]), dtype=np.float32)
        for i, c in enumerate(chunks):
            j = old.get(c.id)
            if j is not None and self._embedded[j]:
                vectors[i], embedded[i] = self._vectors[j], True
        return vectors, embedded

    def _index_files(self, paths: list[Path]):
        """Chunk files in parallel processes (PDF reading is CPU work); one by one where that fails."""
        jobs = [(str(p), str(self._cache_path(p))) for p in paths]
        if len(jobs) > 2:
            try:
                from concurrent.futures import ProcessPoolExecutor
                with ProcessPoolExecutor(max_workers=max(1, min(6, (os.cpu_count() or 2) - 1))) as pool:
                    yield from pool.map(_index_file, *zip(*jobs))
                return
            except Exception as exc:  # noqa: BLE001 - no process pool (e.g. frozen app): do it here
                log.info("manuals: indexing in this process (%s)", exc)
        for path_text, cache_text in jobs:
            if not Path(cache_text).exists():
                yield _index_file(path_text, cache_text)

    def warm_in_background(self) -> None:
        """Index and embed the library at startup, so the first question does not wait."""
        self.background = True
        self.ensure(wait_s=0.0)

    # embeddings (optional) ------------------------------------------------------

    @property
    def semantic(self) -> bool:
        return self.client.enabled and self._semantic_error is None

    def _post(self, path: str, payload: dict[str, Any], timeout: float = 60.0) -> dict[str, Any]:
        """One OpenAI call through the shared client. Runs in a worker thread, never on the event loop."""
        return asyncio.run(self.client.request("POST", path, payload, timeout=timeout))

    def _post_retrying(self, path: str, payload: dict[str, Any], attempts: int = 8) -> dict[str, Any]:
        """Wait and try again when OpenAI says the rate limit is reached (a large library hits it)."""
        for attempt in range(attempts):
            try:
                return self._post(path, payload)
            except OpenAIError as exc:
                if exc.status != 429 or "quota" in str(exc).lower() or attempt == attempts - 1:
                    raise
                m = re.search(r"try again in ([\d.]+)\s*(ms|s)", str(exc))
                wait = (float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)) if m else 2.0 ** attempt
                time.sleep(min(30.0, wait + 0.5 + attempt))
        raise AssertionError("unreachable")

    def _embed(self, texts: list[str]) -> np.ndarray:
        vectors: list[list[float]] = []
        for start in range(0, len(texts), EMBED_BATCH):
            body: dict[str, Any] = {"model": self.embedding_model,
                                    "input": [t[:8000] for t in texts[start:start + EMBED_BATCH]]}
            if self.embedding_dimensions:
                body["dimensions"] = self.embedding_dimensions
            data = self._post_retrying("/embeddings", body)
            vectors.extend(d["embedding"] for d in sorted(data["data"], key=lambda d: d["index"]))
        arr = np.asarray(vectors, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        return arr / np.maximum(norms, 1e-9)

    @staticmethod
    def _embed_text(c: Chunk) -> str:
        return f"{c.citation()}\n{c.text}\n{' '.join(c.footnotes)}"

    def _embed_library(self) -> None:
        """Embed every manual that has no vectors yet, file by file, cached per file."""
        if not self.semantic or not self.chunks:
            self.progress["state"] = "ready"
            return
        with self._lock:
            chunks = list(self.chunks)
        by_doc: dict[str, list[int]] = {}
        for i, c in enumerate(chunks):
            by_doc.setdefault(c.doc, []).append(i)

        def one(doc: str) -> tuple[list[int], np.ndarray] | None:
            rows = by_doc[doc]
            path = self.paths.get(doc)
            vec_path = self._vector_path(path) if path else None
            if vec_path and vec_path.exists():
                try:
                    vecs = np.load(vec_path)
                    if vecs.shape[0] == len(rows):
                        return rows, vecs
                except (OSError, ValueError):
                    pass
            vecs = self._embed([self._embed_text(chunks[i]) for i in rows])
            if vec_path:
                try:
                    vec_path.parent.mkdir(parents=True, exist_ok=True)
                    np.save(vec_path, vecs)
                except OSError:
                    pass
            return rows, vecs

        from concurrent.futures import ThreadPoolExecutor
        todo = [doc for doc, rows in by_doc.items() if not self._embedded[rows].all()]
        started = time.time()
        with ThreadPoolExecutor(max_workers=2) as pool:
            for result in pool.map(lambda d: self._safe(one, d), todo):
                if result is None:
                    continue
                rows, vecs = result
                with self._lock:
                    if self.chunks is not chunks and [c.id for c in self.chunks] != [c.id for c in chunks]:
                        return  # the library changed meanwhile; the next build embeds again
                    if self._vectors is None or self._vectors.shape[1] != vecs.shape[1]:
                        self._vectors = np.zeros((len(chunks), vecs.shape[1]), dtype=np.float32)
                        self._embedded = np.zeros(len(chunks), dtype=bool)
                    self._vectors[rows] = vecs
                    self._embedded[rows] = True
                    self.progress["embedded"] = int(self._embedded.sum())
        self.progress["state"] = "ready" if self._semantic_error is None else f"keyword only: {self._semantic_error}"
        if todo:
            log.info("manuals embedded: %d passages in %.1f s", int(self._embedded.sum()), time.time() - started)

    def _safe(self, fn: Callable[[str], Any], doc: str) -> Any:
        if self._semantic_error is not None:
            return None
        try:
            return fn(doc)
        except (OpenAIError, KeyError, ValueError) as exc:
            self._semantic_error = str(exc)
            log.warning("embeddings unavailable, using keyword search only: %s", exc)
            return None

    def _chunk_vectors(self) -> np.ndarray | None:
        """The vectors that are ready; in blocking mode the whole library is embedded first."""
        if not self.semantic or not self.chunks:
            return None
        if not self.background and not self._embedded.all():
            self._embed_library()
        return self._vectors if self._vectors is not None and self._embedded.any() else None

    # scope: which product's manuals answer --------------------------------------------

    def scope(self, question: str, product: str | None = None) -> dict[str, Any]:
        """Which manuals may answer: the product the question or the caller names, else the connected sensor."""
        if product:
            docs = mentioned_products(product, self.products)
            if docs:
                return {"docs": docs, "source": "requested", "product": product}
        docs = mentioned_products(question, self.products)
        if docs:
            names = sorted({self.products[d].name for d in docs})
            return {"docs": docs, "source": "question", "product": ", ".join(names[:4])}
        active = self.active_product()
        if active:
            docs = mentioned_products(active, self.products)
            if docs:
                return {"docs": docs, "source": "connected sensor", "product": active}
        return {"docs": None, "source": "all manuals", "product": None}

    def status(self) -> dict[str, Any]:
        families: Counter = Counter(p.family for p in self.products.values() if p.family)
        return {**self.progress, "documents": len(self.paths), "passages": len(self.chunks),
                "families": dict(families.most_common()), "active_product": self.active_product(),
                "search": "hybrid" if self.semantic else "keyword", "errors": self.errors}

    # searching ---------------------------------------------------------------

    def documents(self) -> dict[str, Any]:
        self.ensure()
        per_doc: dict[str, dict[str, Any]] = {}
        for c in self.chunks:
            d = per_doc.setdefault(c.doc, {"name": c.doc, "title": c.doc_title, "label": doc_label(c.doc),
                                           "product": self.products.get(c.doc, product_of(c.doc)).name,
                                           "passages": 0, "pages": 0})
            d["passages"] += 1
            d["pages"] = max(d["pages"], c.page or 0)
        return {"documents": list(per_doc.values()), "errors": self.errors,
                "search": "hybrid" if self.client.enabled else "keyword", "folder": self.folder.name,
                "status": self.status()}

    def search(self, query: str, k: int = 5, document: str | None = None,
               product: str | None = None) -> dict[str, Any]:
        self.ensure()
        query = " ".join(str(query or "").split())[:500]
        if not query:
            raise KnowledgeError("Ask a question or give search words.")
        with self._lock:
            chunks, bm25_index, vectors, embedded = self.chunks, self._bm25, self._vectors, self._embedded
        if not chunks:
            message = ("The manuals are still being indexed. Ask again in a minute."
                       if self._building else
                       "No manual is loaded. Add one under Manuals, or set MANUAL_LIBRARY_DIRS in backend/.env.")
            return {"query": query, "found": False, "hits": [], "mode": "keyword", "message": message,
                    "scope": {"source": "none", "product": None}}
        k = int(min(max(k, 1), 12))
        scope = self.scope(query, product)
        result = self._ranked(query, k, document, scope["docs"], chunks, bm25_index, vectors, embedded)
        if not result["found"] and scope["source"] == "connected sensor":
            # not in the connected sensor's manuals: look in the whole library, and say so
            scope = {"docs": None, "source": "all manuals (not in the connected sensor's manuals)",
                     "product": scope["product"]}
            result = self._ranked(query, k, document, None, chunks, bm25_index, vectors, embedded)
        result["scope"] = {"source": scope["source"], "product": scope["product"],
                           "documents": len(scope["docs"]) if scope["docs"] else len(self.paths)}
        return result

    def _ranked(self, query: str, k: int, document: str | None, docs: set[str] | None, chunks: list[Chunk],
                bm25_index: BM25 | None, vectors: np.ndarray | None, embedded: np.ndarray) -> dict[str, Any]:
        allowed = np.ones(len(chunks), dtype=bool)
        if docs is not None:
            allowed &= np.array([c.doc in docs for c in chunks])
        if document:
            want = document.lower()
            allowed &= np.array([want in c.doc.lower() or want in c.doc_title.lower() for c in chunks])
        terms = tokenize(query)
        bm25 = bm25_index.scores(terms) if bm25_index else np.zeros(len(chunks))
        bm25 = np.where(allowed, bm25 * self._doc_bonus(terms, chunks), -1.0)
        cosine = None
        if self.semantic and vectors is not None and embedded.any():
            try:
                cosine = vectors @ self._embed([query])[0]
                cosine = np.where(allowed & embedded, cosine, -1.0)
            except (OpenAIError, KeyError, ValueError) as exc:
                log.warning("query embedding failed, keyword search only: %s", exc)
        fused = np.zeros(len(chunks))
        for ranking, weight in ((bm25, 1.0), (cosine, SEMANTIC_WEIGHT)):
            if ranking is None:
                continue
            order = np.argsort(-ranking, kind="stable")
            ranks = np.empty(len(order))
            ranks[order] = np.arange(1, len(order) + 1)
            fused += np.where(ranking > 0, weight / (RRF_K + ranks), 0.0)
        order = [int(i) for i in np.argsort(-fused, kind="stable") if fused[i] > 0][:k]
        if cosine is not None:
            # keywords cannot match an English question to a German datasheet, so the best matches by
            # meaning always stay in, in place of the weakest fused ones
            kept = [int(i) for i in np.argsort(-cosine, kind="stable")[:min(KEEP_SEMANTIC, k)]
                    if cosine[i] >= MIN_SEMANTIC]
            order = (kept + [i for i in order if i not in kept])[:k]
            order.sort(key=lambda i: -fused[i])
        hits = []
        for i in order:
            c = chunks[i]
            hits.append({
                "id": c.id, "doc": c.doc, "doc_title": c.doc_title, "section": c.section,
                "section_title": c.section_title, "page": c.page, "printed_page": c.printed_page,
                "labels": c.labels, "citation": c.citation(), "text": c.text, "footnotes": c.footnotes,
                "product": self.products.get(c.doc, product_of(c.doc)).name,
                "keyword_score": round(float(max(bm25[i], 0.0)), 3),
                "semantic_score": None if cosine is None else round(float(cosine[i]), 3),
                "url": self.file_url(c),
            })
        found = any(h["keyword_score"] > 0 or (h["semantic_score"] or 0) >= MIN_SEMANTIC for h in hits)
        return {"query": query, "found": found, "hits": hits if found else [],
                "mode": "hybrid" if cosine is not None else "keyword",
                **({} if found else {"message": "Nothing in the manuals matches this question."})}

    def _doc_bonus(self, terms: list[str], chunks: list[Chunk]) -> np.ndarray:
        """A query that names a product ("optoNCDT 5500") prefers that manual's passages."""
        bonus = np.ones(len(chunks))
        wanted = {t for t in terms if any(ch.isdigit() for ch in t)}
        if not wanted:
            return bonus
        titles: dict[str, bool] = {}
        for i, c in enumerate(chunks):
            if c.doc not in titles:
                titles[c.doc] = bool(wanted & set(tokenize(f"{c.doc_title} {c.doc}")))
            if titles[c.doc]:
                bonus[i] = 1.25
        return bonus

    def file_path(self, name: str) -> Path | None:
        """The manual file behind a document name, for opening it at a page."""
        return self.paths.get(name)

    @staticmethod
    def file_url(chunk: Chunk) -> str:
        url = f"/api/knowledge/library/{quote(chunk.doc)}"
        return f"{url}#page={chunk.page}" if chunk.page else url

    @staticmethod
    def passage(hit: dict[str, Any], n: int) -> dict[str, Any]:
        """A hit in the shape the cockpit's manual card shows (uid, doc, page, section, text), plus the citation."""
        return {"id": f"P{n}", "uid": hit["id"], "doc": hit["doc"], "page": hit["page"], "url": hit["url"],
                "section": hit["citation"], "cite": hit["citation"], "product": hit.get("product"),
                "text": hit["text"][:1400], **({"footnotes": hit["footnotes"]} if hit["footnotes"] else {})}

    def tool_result(self, query: str, document: str | None = None, k: int = 4,
                    product: str | None = None) -> dict[str, Any]:
        """Passages for the copilot's search_manual tool, with the rule for using them."""
        result = self.search(query, k=k, document=document, product=product)
        out: dict[str, Any] = {
            "ok": True, "query": result["query"], "found": result["found"], "documents": len(self.paths),
            "scope": result.get("scope"),
            "passages": [self.passage(h, n) for n, h in enumerate(result["hits"], start=1)],
            "message": "" if result["found"] else (result.get("message") or "Nothing in the loaded manuals matches this."),
        }
        out["speak_rule"] = (SPEAK_RULE if result["found"] else
                             "Say that the loaded manuals do not cover this. Do not answer from memory.")
        return out

    # answering -----------------------------------------------------------------

    def answer(self, question: str, k: int = 8, document: str | None = None,
               product: str | None = None) -> dict[str, Any]:
        result = self.search(question, k=k, document=document, product=product)
        hits = result["hits"]
        base = {"question": result["query"], "found": result["found"], "sources": hits, "search": result["mode"],
                "scope": result.get("scope")}
        if not result["found"]:
            return {**base, "mode": "none",
                    "answer": "This specification is not mentioned in the provided manuals."}
        if self.client.enabled:
            try:
                return {**base, "mode": "generated", "model": self.answer_model,
                        "answer": self._generate(result["query"], hits, result.get("scope"))}
            except (OpenAIError, KeyError, ValueError) as exc:
                log.warning("answer generation failed, quoting the manual instead: %s", exc)
        return {**base, "mode": "extractive", "answer": self._extract(result["query"], hits)}

    def _generate(self, question: str, hits: list[dict[str, Any]], scope: dict[str, Any] | None = None) -> str:
        context = "\n\n".join(
            f"[S{n}] [{h['citation']}] (product: {h.get('product') or 'unknown'})\n{h['text']}"
            + (f"\nFootnotes: {' '.join(h['footnotes'])}" if h["footnotes"] else "")
            for n, h in enumerate(hits, start=1))
        scope_line = ""
        if scope and scope.get("product"):
            scope_line = (f"The passages were selected for: {scope['product']} ({scope['source']}). ")
        instructions = (
            "You are Epsilon, a precision technical assistant for Micro-Epsilon sensors and measuring systems. "
            "The passages come from the manufacturer's operating instructions, quick guides, interface manuals, "
            "datasheets (some in German) and setup guides; each passage names its product. " + scope_line +
            "Answer ONLY from the passages given. Never use outside knowledge for specifications, pin assignments, "
            "commands or tolerances. "
            "One product per statement: never take a value from one product's manual and present it for another "
            "product, and never mix values of different products in one statement. Say which product (and model "
            "variant) each value belongs to. If the passages come from several products and the question does "
            "not say which one is meant, give the value per product with its name, and ask which product is "
            "meant in one closing sentence. If the passages are about a different product than the one asked "
            "about, say that the manuals for the asked product do not cover it instead of answering. "
            "A product's own manual covers its whole system: the sensors, controllers, cables and interfaces it "
            "describes belong to that product. When a value of a controller depends on the sensor connected to "
            "it (measuring range, resolution), list it per sensor model from the table instead of refusing. "
            "A default or factory setting is answered from the factory settings or parameter tables. "
            "Merged table cells: when a row has fewer values than the header has models, a value spans several "
            "neighbouring models (for example 'Linearity | ≤ ±0.08 % FSO | ≤ ±0,1...0,2 % FSO' under six models "
            "means the first value covers the smaller ranges). Decide which cell a model falls under with a row "
            "that has one value per model: a % FSO value times the measuring range must equal the µm value of "
            "the same model (0.08 % of 50 mm = 40 µm). Give both the µm and the % FSO value when the table has both. "
            "A datasheet and a manual can both give a value; prefer the one for the exact model and interface "
            "asked about (for example the EtherCAT or PROFINET variant), and say when they differ. "
            "Only if the passages contain nothing that answers the question, reply exactly: \"This is not "
            "mentioned in the provided manuals.\" (translated to the language of the question) and nothing else. "
            "If they answer it partly, give what they say and name in one sentence what they leave open; never "
            "add the refusal sentence to an answer. Read an everyday question generously: \"how hot can it get\" "
            "asks for the operating temperature range. For safety topics (laser class, supply voltage, "
            "mounting, hazards) quote the manual's wording and never weaken a warning. "
            "Keep exact values, min/typ/max, units and test conditions, never round. "
            "Read table rows carefully: layout text separates columns with ' | '. A cell can wrap over the "
            "line above and below its row label (for example '< ±7.5 µm' above 'Linearity [6]', '% FSO' below); "
            "join the pieces column by column and state the merged value plainly. Include footnotes that apply. "
            "If the value differs between model variants and the question names none, list each variant. "
            "Start with the direct answer, then conditions and caveats. Cite every value with the full citation "
            "given with its passage, including the document, for example [Manual 5500, Section 3.3, Page 12] or "
            "[Datasheet ILD5500-10DR (de), Page 1]; never shorten it to the section or page alone. Use a Markdown "
            "table when comparing variants or pins. Write the whole answer in the language the QUESTION is written "
            "in, never in the language of the passages: some passages are German, and an English question still "
            "gets an English answer (translate the labels, keep every number and unit exactly).")
        body: dict[str, Any] = {"model": self.answer_model, "instructions": instructions,
                                "input": f"Manual passages:\n\n{context}\n\nQuestion (answer in its language): {question}"}
        if self.reasoning_effort and re.match(r"^(gpt-5|o\d)", self.answer_model):
            body["reasoning"] = {"effort": self.reasoning_effort}
        data = self._post("/responses", body)
        texts = [part.get("text", "") for item in data.get("output", []) if item.get("type") == "message"
                 for part in item.get("content", []) if part.get("type") == "output_text"]
        text = "\n".join(t for t in texts if t).strip()
        if not text:
            raise ValueError("the model returned no text")
        return text

    def _extract(self, question: str, hits: list[dict[str, Any]]) -> str:
        """Without a model: quote the lines that best match the question.

        Words weigh by how rare they are in the manuals. Model numbers weigh
        little, because in a spec table they name the column, not the row.
        Table cells in layout text wrap over several lines, so each picked line
        comes with its neighbours, and with the table's header row.
        """
        weights: dict[str, float] = {}
        for term in set(tokenize(question)):
            idf = self._bm25.idf(term) if self._bm25 else 1.0
            weights[term] = idf * (0.2 if any(ch.isdigit() for ch in term) else 1.0)
        blocks: list[str] = []
        first_best = 0.0
        for h in hits[:2]:
            lines = [ln for ln in h["text"].splitlines() if ln.strip()]
            scores = [sum(weights.get(t, 0.0) for t in set(tokenize(ln))) for ln in lines]
            best = max(scores, default=0.0)
            if best <= 0 or best < first_best * 0.75:
                continue  # the second passage only if it matches about as well as the first
            first_best = first_best or best
            keep: set[int] = set()
            for i, score in enumerate(scores):
                if score >= best * 0.6 and score > 0:
                    keep.update(j for j in (i - 1, i, i + 1) if 0 <= j < len(lines))
            header = next((i for i, ln in enumerate(lines) if "|" in ln and not _HEADING_RE.match(ln)), None)
            if header is not None and any(i > header and "|" in lines[i] for i in keep):
                keep.add(header)
            picked = [lines[i] for i in sorted(keep)][:10]
            refs = set(_FOOTNOTE_REF_RE.findall("\n".join(" " + ln for ln in picked)))
            notes = [n for n in h["footnotes"] if n[1:n.index("]")] in refs]
            blocks.append("\n".join(picked + notes) + f"\n[{h['citation']}]")
        if not blocks:
            top = hits[0]
            return f"{top['text'][:400].strip()}\n[{top['citation']}]"
        return "\n\n".join(blocks)
