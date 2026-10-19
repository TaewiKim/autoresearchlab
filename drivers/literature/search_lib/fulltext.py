"""Full text of an arXiv paper, cached with its provenance, for deep reading.

Screening reads abstracts. A deep read has to read the paper: which component
actually carries the reported gain, which ablation is missing, what the method
takes for granted. So the full text is fetched once, cached under
``.research-lab/literature/fulltext/<arxiv id>/`` and addressed by section,
table, figure and quote, and the harness checks every evidence reference a
deep-read card makes against this exact text (``sha256`` of ``fulltext.txt``).

Sources, best first:
  1. ``arxiv.org/html/<id>``  -- arXiv's own LaTeXML rendering (papers from late 2023 on);
  2. ``ar5iv.labs.arxiv.org/html/<id>`` -- the same rendering for older papers;
  3. ``arxiv.org/pdf/<id>`` -- text extracted with the best extractor available:
     PyMuPDF, pypdf, poppler ``pdftotext``, then a stdlib-only fallback (the
     scout image has none of the others; its output is marked degraded).

HTML is preferred: its sections, figure and table captions are structural, not
guessed from line layout. Only public paper IDs leave the process.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import zlib
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

from .http_client import fetch_bytes

FULLTEXT_ROOT_ENV = "RESEARCHLAB_FULLTEXT_ROOT"
DEFAULT_FULLTEXT_ROOT = Path(__file__).resolve().parents[3] / ".research-lab" / "literature" / "fulltext"
MANIFEST_VERSION = "fulltext-v1"
# A rendering shorter than this is an error page or a stub, not a paper.
MIN_PAPER_CHARS = 4000
FULLTEXT_TIMEOUT_SECONDS = 60

_NEW_ID = re.compile(r"(?P<id>\d{4}\.\d{4,5})(?P<version>v\d+)?")
_OLD_ID = re.compile(r"(?P<id>[a-z][a-z.-]+/\d{7})(?P<version>v\d+)?", re.IGNORECASE)


def fulltext_root(root: Path | str | None = None) -> Path:
    if root:
        return Path(root)
    configured = (os.environ.get(FULLTEXT_ROOT_ENV) or "").strip()
    return Path(configured) if configured else DEFAULT_FULLTEXT_ROOT


def normalize_arxiv_id(raw: str) -> tuple[str, str | None]:
    """``(base id, version or None)`` from ``arXiv:2303.04137v2``, a URL, or a bare id."""
    text = (raw or "").strip()
    # Landscapes cite arXiv papers by their DataCite DOI: doi:10.48550/arxiv.2406.09246.
    text = re.sub(
        r"^(?:arxiv:|(?:doi:|https?://doi\.org/)?10\.48550/arxiv\.|https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/)",
        "", text, flags=re.IGNORECASE,
    )
    text = re.sub(r"\.pdf$", "", text)
    for pattern in (_NEW_ID, _OLD_ID):
        match = pattern.fullmatch(text)
        if match:
            return match.group("id"), match.group("version")
    raise ValueError(f"not an arXiv identifier: {raw!r}")


def cache_dir_for(arxiv_id: str, root: Path | str | None = None) -> Path:
    base, _ = normalize_arxiv_id(arxiv_id)
    return fulltext_root(root) / base.replace("/", "_")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --- HTML (LaTeXML) -------------------------------------------------------------

_VOID_TAGS = {"br", "img", "hr", "meta", "link", "input", "source", "col", "wbr"}
_SKIP_TAGS = {"script", "style", "nav", "header", "footer", "noscript", "button", "svg", "annotation", "annotation-xml"}
_BLOCK_TAGS = {
    "p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "figure", "figcaption",
    "blockquote", "pre", "dt", "dd", "caption",
}
_HEADING_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# "3.2 Method", "Appendix B Details", and the Roman "IV Experiments" of IEEE papers.
_NUMBER_PREFIX = re.compile(
    r"^(?:Appendix\s+)?(?P<number>(?:[IVX]{1,5}(?=[\s.])|[A-Z]|\d+)(?:\.\d+)*)\.?\s+(?P<title>\S.*)$"
)
_LABEL_PREFIX = re.compile(
    r"^(?P<kind>Figure|Fig\.|Table|Algorithm|Listing)\s*(?P<number>[A-Z]?\d+(?:\.\d+)?)\s*[:.]?", re.IGNORECASE
)


class _LatexmlText(HTMLParser):
    """LaTeXML HTML to plain text, with a section index, captions and links."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.sections: list[dict] = []
        self.labels: list[dict] = []
        self.links: list[str] = []
        self._skip_depth = 0
        self._math_depth = 0
        self._heading: dict | None = None
        self._caption: dict | None = None
        self._stack: list[tuple[str, str | None]] = []

    def _emit(self, text: str) -> None:
        if self._heading is not None:
            self._heading["buffer"].append(text)
            return
        if self._caption is not None:
            self._caption["buffer"].append(text)
        self.parts.append(text)

    def _nearest_id(self) -> str | None:
        for _, value in reversed(self._stack):
            if value:
                return value
        return None

    def handle_starttag(self, tag, attrs):  # noqa: ANN001
        attributes = dict(attrs)
        if tag in _VOID_TAGS:
            if tag == "br" and not (self._skip_depth or self._math_depth):
                self._emit("\n")
            return
        self._stack.append((tag, attributes.get("id")))
        if self._skip_depth or tag in _SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._math_depth:
            self._math_depth += 1
            return
        if tag == "math":
            alt = attributes.get("alttext") or ""
            if alt:
                self._emit(f" {alt} ")
            self._math_depth = 1
            return
        if tag == "a":
            href = attributes.get("href") or ""
            if href.startswith("http"):
                self.links.append(href)
        if tag in {"td", "th"}:
            self._emit(" | ")
        if tag == "tr":
            self._emit("\n")
        if tag in _HEADING_TAGS:
            self._heading = {"level": int(tag[1]), "id": self._nearest_id(), "buffer": []}
            return
        if self._caption is None and tag == "figcaption":
            self._caption = {"id": self._nearest_id(), "buffer": [], "tag": tag, "depth": len(self._stack)}
        if tag in _BLOCK_TAGS:
            self._emit("\n")

    def handle_endtag(self, tag):  # noqa: ANN001
        if tag in _VOID_TAGS or not any(open_tag == tag for open_tag, _ in self._stack):
            return
        depth_before = len(self._stack)
        while self._stack:
            popped, _ = self._stack.pop()
            if self._skip_depth:
                self._skip_depth -= 1
            elif self._math_depth:
                self._math_depth -= 1
            if popped == tag:
                break
        if self._skip_depth or self._math_depth:
            return
        if tag in _HEADING_TAGS and self._heading is not None:
            heading = self._heading
            self._heading = None
            title = re.sub(r"\s+", " ", "".join(heading["buffer"])).strip()
            if title:
                match = _NUMBER_PREFIX.match(title)
                self.parts.append("\n\n" + "#" * min(heading["level"], 6) + " " + title + "\n")
                self.sections.append({
                    "id": heading["id"],
                    "level": heading["level"],
                    "number": match.group("number") if match else None,
                    "title": match.group("title") if match else title,
                    "heading": title,
                })
            return
        if self._caption is not None and tag == self._caption["tag"] and depth_before <= self._caption["depth"]:
            caption = self._caption
            self._caption = None
            text = re.sub(r"\s+", " ", "".join(caption["buffer"])).strip()
            match = _LABEL_PREFIX.match(text)
            if text and match:
                self.labels.append({
                    "label": _canonical_label(match.group("kind"), match.group("number")),
                    "id": caption["id"],
                    "caption": text[:600],
                })
        if tag in _BLOCK_TAGS:
            self._emit("\n")

    def handle_data(self, data):  # noqa: ANN001
        if self._skip_depth or self._math_depth:
            return
        # HTML whitespace is not significant outside <pre>; block tags carry the
        # line structure. Raw newlines between table cells would put every cell
        # of a results table on its own line.
        if not any(tag == "pre" for tag, _ in self._stack):
            data = re.sub(r"\s+", " ", data)
        self._emit(data)


def _canonical_label(kind: str, number: str) -> str:
    kind = kind.lower().rstrip(".")
    name = {"fig": "Figure", "figure": "Figure", "table": "Table", "algorithm": "Algorithm", "listing": "Listing"}[kind]
    return f"{name} {number}"


def _tidy(text: str) -> str:
    text = text.replace(" ", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


def _locate(text: str, items: list[dict], key: str) -> None:
    """Offsets into the final (tidied) text, found in document order."""
    cursor = 0
    for item in items:
        probe = re.sub(r"\s+", " ", item.get(key) or "")[:80]
        position = text.find(probe, cursor) if probe else -1
        if position < 0 and probe:
            position = text.find(probe)
        item["offset"] = position if position >= 0 else None
        if position >= 0:
            cursor = position


def extract_latexml_html(raw: str) -> dict:
    """Text, section index, caption labels and outbound links of a LaTeXML page."""
    parser = _LatexmlText()
    parser.feed(raw)
    parser.close()
    text = _tidy("".join(parser.parts))
    _locate(text, parser.sections, "heading")
    _locate(text, parser.labels, "caption")
    return {"text": text, "sections": parser.sections, "labels": parser.labels, "links": sorted(set(parser.links))}


def _looks_like_paper_html(raw: str) -> bool:
    return "ltx_document" in raw or "ltx_page_main" in raw


# --- PDF ------------------------------------------------------------------------

_PDF_SECTION = re.compile(
    r"^(?P<number>(?:\d+(?:\.\d+){0,3}|[A-H](?:\.\d+){1,2}))\.?\s+(?P<title>[A-Z][A-Za-z0-9 ,:&()/'-]{2,80})$"
)
_PDF_UNNUMBERED = re.compile(
    r"^(Abstract|Introduction|Related Work|Conclusions?|References|Acknowledg(?:e)?ments?|Appendix|Limitations)$",
    re.IGNORECASE,
)
_PDF_LABEL = re.compile(r"^(?P<kind>Figure|Fig\.|Table|Algorithm)\s*(?P<number>\d+)\s*[:.|]", re.IGNORECASE)


def _pdf_text_pymupdf(data: bytes) -> str | None:
    try:
        import pymupdf  # type: ignore
    except ImportError:
        try:
            import fitz as pymupdf  # type: ignore
        except ImportError:
            return None
    with pymupdf.open(stream=data, filetype="pdf") as document:
        return "\n\f".join(page.get_text("text") for page in document)


def _pdf_text_pypdf(data: bytes) -> str | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return None
    reader = PdfReader(io.BytesIO(data))
    return "\n\f".join(page.extract_text() or "" for page in reader.pages)


def _pdf_text_pdftotext(data: bytes) -> str | None:
    binary = shutil.which("pdftotext")
    if not binary:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / "paper.pdf"
        source.write_bytes(data)
        completed = subprocess.run(
            [binary, "-enc", "UTF-8", str(source), "-"], capture_output=True, timeout=120, check=False
        )
        if completed.returncode != 0:
            return None
        return completed.stdout.decode("utf-8", errors="replace")


_PDF_STREAM_START = re.compile(rb">>\s*stream\r?\n")
_PDF_TEXT_OP = re.compile(rb"\((?P<lit>(?:\\.|[^\\)])*)\)\s*(?:Tj|'|\")|\[(?P<arr>[^\]]*)\]\s*TJ|(?P<nl>T\*|Td|TD|ET)")
_PDF_ARRAY_PART = re.compile(rb"\((?P<lit>(?:\\.|[^\\)])*)\)|(?P<kern>-?\d+(?:\.\d+)?)")
_PDF_ESCAPES = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12, ord("("): 40, ord(")"): 41, 0x5C: 0x5C}


def _pdf_literal(raw: bytes) -> str:
    out = bytearray()
    index = 0
    while index < len(raw):
        char = raw[index]
        if char == 0x5C and index + 1 < len(raw):  # backslash escape
            nxt = raw[index + 1]
            if nxt in _PDF_ESCAPES:
                out.append(_PDF_ESCAPES[nxt])
                index += 2
                continue
            octal = re.match(rb"[0-7]{1,3}", raw[index + 1:index + 4])
            if octal:
                out.append(int(octal.group(0), 8) & 0xFF)
                index += 1 + len(octal.group(0))
                continue
            index += 1
            continue
        out.append(char)
        index += 1
    text = out.decode("latin-1")
    # pdfTeX's standard Type1 ligature slots.
    for slot, ligature in (("\x0b", "ff"), ("\x0c", "fi"), ("\x0d", "fl"), ("\x0e", "ffi"), ("\x0f", "ffl")):
        text = text.replace(slot, ligature)
    return text


def _pdf_streams(data: bytes):
    """Decoded content streams: each ``stream`` keyword, its object header, its body."""
    for match in _PDF_STREAM_START.finditer(data):
        header_start = data.rfind(b" obj", max(0, match.start() - 2000), match.start())
        header = data[header_start if header_start >= 0 else max(0, match.start() - 600): match.start()]
        if b"/Image" in header or b"/FontFile" in header or b"/Length1" in header:
            continue
        end = data.find(b"endstream", match.end())
        if end < 0:
            continue
        body = data[match.end(): end]
        if b"FlateDecode" in header:
            try:
                body = zlib.decompressobj().decompress(body)
            except zlib.error:
                continue
        elif b"/Filter" in header:
            continue  # another codec; not text we can read without a library
        yield body


def _pdf_text_stdlib(data: bytes) -> str | None:
    """Best-effort Tj/TJ extraction from Flate streams. Degraded by design."""
    chunks: list[str] = []
    for body in _pdf_streams(data):
        if b"BT" not in body:
            continue
        line: list[str] = []
        for op in _PDF_TEXT_OP.finditer(body):
            if op.group("lit") is not None:
                line.append(_pdf_literal(op.group("lit")))
            elif op.group("arr") is not None:
                for part in _PDF_ARRAY_PART.finditer(op.group("arr")):
                    if part.group("lit") is not None:
                        line.append(_pdf_literal(part.group("lit")))
                    elif float(part.group("kern")) < -200:
                        line.append(" ")
            elif line:
                chunks.append("".join(line))
                line = []
        if line:
            chunks.append("".join(line))
    text = "\n".join(chunk for chunk in chunks if chunk.strip())
    return text or None


PDF_EXTRACTORS: list[tuple[str, Callable[[bytes], str | None]]] = [
    ("pymupdf", _pdf_text_pymupdf),
    ("pypdf", _pdf_text_pypdf),
    ("pdftotext", _pdf_text_pdftotext),
    ("stdlib-minimal", _pdf_text_stdlib),
]


def extract_pdf(data: bytes) -> dict:
    errors = []
    for name, extractor in PDF_EXTRACTORS:
        try:
            raw = extractor(data)
        except Exception as error:  # a broken extractor must not hide the next one
            errors.append(f"{name}: {type(error).__name__}: {error}"[:300])
            continue
        if raw and len(raw.strip()) >= MIN_PAPER_CHARS:
            return {**_index_pdf_text(raw), "extractor": name, "extractor_errors": errors,
                    "degraded": name == "stdlib-minimal"}
        errors.append(f"{name}: unavailable or too little text")
    raise ValueError("no PDF text extractor produced the paper text: " + "; ".join(errors))


def _index_pdf_text(raw: str) -> dict:
    out: list[str] = []
    sections: list[dict] = []
    labels: list[dict] = []
    lines = [line.strip() for line in raw.replace("\f", "\n").splitlines()]
    merged: list[str] = []
    for line in lines:
        # Extractors often put a heading's number on its own line ("3.1" / "Game-Inspired Curriculum").
        if merged and re.fullmatch(r"(?:\d+(?:\.\d+){0,3}|[A-H](?:\.\d+){1,2})\.?", merged[-1]) and line[:1].isupper() and len(line) <= 80:
            merged[-1] = f"{merged[-1]} {line}"
        else:
            merged.append(line)
    for line in merged:
        section = _PDF_SECTION.match(line) if len(line) <= 90 else None
        if section or _PDF_UNNUMBERED.match(line):
            sections.append({
                "id": None,
                "level": 2 + (section.group("number").count(".") if section else 0),
                "number": section.group("number") if section else None,
                "title": section.group("title") if section else line,
                "heading": line,
            })
            out.append(f"\n## {line}")
            continue
        label = _PDF_LABEL.match(line)
        if label:
            labels.append({
                "label": _canonical_label(label.group("kind"), label.group("number")),
                "id": None,
                "caption": line[:600],
            })
        out.append(line)
    text = _tidy("\n".join(out))
    _locate(text, sections, "heading")
    _locate(text, labels, "caption")
    links = sorted(set(re.findall(r"https?://[^\s)\]}>\"']+", raw)))
    return {"text": text, "sections": sections, "labels": labels, "links": links}


# --- fetch + cache --------------------------------------------------------------


def _source_urls(base_id: str, version: str | None) -> list[tuple[str, str]]:
    ref = f"{base_id}{version or ''}"
    return [
        ("arxiv-html", f"https://arxiv.org/html/{ref}"),
        ("ar5iv-html", f"https://ar5iv.labs.arxiv.org/html/{ref}"),
        ("arxiv-pdf", f"https://arxiv.org/pdf/{ref}"),
    ]


def _read_manifest(directory: Path) -> dict | None:
    try:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    text_path = directory / "fulltext.txt"
    if not text_path.is_file() or manifest.get("sha256") != _sha256(text_path.read_bytes()):
        return None  # a cache whose text no longer matches its hash is not evidence
    manifest["cache_dir"] = str(directory)
    return manifest


def _default_fetch(url: str) -> bytes:
    return fetch_bytes(url, timeout=FULLTEXT_TIMEOUT_SECONDS)


def fetch_fulltext(
    arxiv_id: str,
    *,
    root: Path | str | None = None,
    refresh: bool = False,
    fetch: Callable[[str], bytes] | None = None,
) -> dict:
    """Fetch, extract and cache one paper's full text; return its manifest.

    The manifest names the source URL actually used, ``sha256`` of the cached
    ``fulltext.txt`` (the text evidence references are checked against), the
    extractor, and every source tried. A paper no source renders raises
    ``ValueError`` carrying those attempts.
    """
    base_id, version = normalize_arxiv_id(arxiv_id)
    directory = cache_dir_for(base_id, root)
    if not refresh:
        cached = _read_manifest(directory)
        if cached is not None:
            cached["cache_hit"] = True
            return cached
    fetch = fetch or _default_fetch
    attempts: list[dict] = []
    extracted = None
    for kind, url in _source_urls(base_id, version):
        try:
            data = fetch(url)
        except urllib.error.HTTPError as error:
            attempts.append({"url": url, "kind": kind, "status": error.code})
            continue
        except Exception as error:  # network policy refusal, timeout, DNS
            attempts.append({"url": url, "kind": kind, "error": f"{type(error).__name__}: {error}"[:300]})
            continue
        try:
            if kind.endswith("html"):
                raw = data.decode("utf-8", errors="replace")
                if not _looks_like_paper_html(raw):
                    attempts.append({"url": url, "kind": kind, "status": 200, "rejected": "not a LaTeXML paper rendering"})
                    continue
                result = extract_latexml_html(raw)
                result.update({"extractor": "latexml-html", "extractor_errors": [], "degraded": False})
                raw_name = "source.html"
            else:
                if not data.startswith(b"%PDF"):
                    attempts.append({"url": url, "kind": kind, "status": 200, "rejected": "response is not a PDF"})
                    continue
                result = extract_pdf(data)
                raw_name = "source.pdf"
        except ValueError as error:
            attempts.append({"url": url, "kind": kind, "status": 200, "rejected": str(error)[:300]})
            continue
        if len(result["text"]) < MIN_PAPER_CHARS:
            attempts.append({"url": url, "kind": kind, "status": 200, "rejected": f"only {len(result['text'])} characters"})
            continue
        attempts.append({"url": url, "kind": kind, "status": 200, "used": True})
        extracted = (kind, url, data, raw_name, result)
        break
    if extracted is None:
        raise ValueError(json.dumps({"arxiv_id": base_id, "error": "no full-text source rendered this paper", "attempts": attempts}))
    kind, url, data, raw_name, result = extracted
    directory.mkdir(parents=True, exist_ok=True)
    text_bytes = result["text"].encode("utf-8")
    (directory / raw_name).write_bytes(data)
    (directory / "fulltext.txt").write_bytes(text_bytes)
    index = {"sections": result["sections"], "labels": result["labels"], "links": result["links"]}
    (directory / "sections.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest = {
        "version": MANIFEST_VERSION,
        "arxiv_id": base_id,
        "requested_version": version,
        "source_kind": kind,
        "source_url": url,
        "sha256": _sha256(text_bytes),
        "raw_sha256": _sha256(data),
        "raw_file": raw_name,
        "text_file": "fulltext.txt",
        "index_file": "sections.json",
        "extractor": result["extractor"],
        "degraded": bool(result.get("degraded")),
        "extractor_errors": result.get("extractor_errors") or [],
        "char_count": len(result["text"]),
        "section_count": len(result["sections"]),
        "label_count": len(result["labels"]),
        "link_count": len(result["links"]),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "attempts": attempts,
    }
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    manifest["cache_dir"] = str(directory)
    manifest["cache_hit"] = False
    return manifest


def load_fulltext(arxiv_id: str, root: Path | str | None = None) -> tuple[dict, str, dict] | None:
    """``(manifest, text, index)`` of a cached paper, or ``None``."""
    directory = cache_dir_for(arxiv_id, root)
    manifest = _read_manifest(directory)
    if manifest is None:
        return None
    text = (directory / "fulltext.txt").read_text(encoding="utf-8")
    try:
        index = json.loads((directory / "sections.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {"sections": [], "labels": [], "links": []}
    return manifest, text, index


def fulltext_summary(manifest: dict) -> dict:
    """What a scout needs to start reading: where the text is and how it is cut."""
    directory = Path(manifest["cache_dir"])
    try:
        index = json.loads((directory / manifest.get("index_file", "sections.json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {"sections": [], "labels": []}
    return {
        "arxiv_id": manifest["arxiv_id"],
        "fulltext_source": {"url": manifest["source_url"], "sha256": manifest["sha256"]},
        "text_path": str(directory / manifest["text_file"]),
        "index_path": str(directory / manifest.get("index_file", "sections.json")),
        "extractor": manifest.get("extractor"),
        "degraded": manifest.get("degraded"),
        "char_count": manifest.get("char_count"),
        "cache_hit": manifest.get("cache_hit"),
        "sections": [
            {key: section.get(key) for key in ("number", "title", "level")}
            for section in index.get("sections", [])[:120]
        ],
        "labels": [label.get("label") for label in index.get("labels", [])][:120],
        "attempts": manifest.get("attempts"),
    }
