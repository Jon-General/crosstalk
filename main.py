import json
import os
import re
import unicodedata
from io import BytesIO
from typing import Any
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pypinyin import Style, pinyin
from pypdf import PdfReader
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.pdfmetrics import registerFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

load_dotenv()

app = FastAPI()

PORT = int(os.getenv("PORT", "3000"))
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
WEB_USER_AGENT = "Mozilla/5.0 (compatible; CrosstalkTutor/0.2; +https://example.invalid)"
DOCUMENT_STORE: dict[str, dict[str, Any]] = {}

registerFont(UnicodeCIDFont("STSong-Light"))

PINYIN_FONT = "Helvetica"
for font_path in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
):
    if os.path.exists(font_path):
        try:
            registerFont(TTFont("PinyinUnicode", font_path))
            PINYIN_FONT = "PinyinUnicode"
            break
        except Exception:
            continue


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "aiConfigured": bool(DEEPSEEK_API_KEY),
        "model": MODEL,
    }


@app.post("/api/tutor-turn-stream")
async def tutor_turn_stream(request: Request):
    body = await request.json()

    if not DEEPSEEK_API_KEY:
        raise HTTPException(status_code=503, detail="DeepSeek API key is not configured on the server.")

    make_lesson_mode = bool(body.get("makeLessonMode"))
    user_message = clean_text(body.get("message", ""))
    topic = clean_text(body.get("topic", "daily life"))
    level = normalize_level(body.get("level"))
    history = normalize_history(body.get("history"))
    memory = normalize_memory(body.get("memory"))
    web = normalize_web_options(body.get("web"))
    document_id = clean_text(body.get("documentId", ""))
    document_context = build_document_context(document_id)

    if not user_message:
        raise HTTPException(status_code=400, detail="Message is required.")

    web_research = None
    if web["enabled"]:
        web_research = await build_web_research(user_message, topic, history, web)

    async def event_stream():
        assistant_text = ""
        deepseek_url = "https://api.deepseek.com/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        }
        payload = {
            "model": MODEL,
            "temperature": 0.35,
            "max_tokens": 520,
            "stream": True,
            "messages": build_deepseek_messages(
                history=history,
                memory=memory,
                make_lesson_mode=make_lesson_mode,
                level=level,
                topic=topic,
                user_message=user_message,
                web_research=web_research,
                document_context=document_context,
            ),
        }

        try:
            timeout = httpx.Timeout(30.0, connect=10.0, read=30.0)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                async with client.stream("POST", deepseek_url, headers=headers, json=payload) as response:
                    if response.status_code >= 400:
                        raw = await response.aread()
                        msg = "DeepSeek request failed."
                        try:
                            err = json.loads(raw.decode("utf-8", errors="ignore"))
                            msg = err.get("error", {}).get("message", msg)
                        except Exception:
                            pass
                        yield json.dumps({"type": "error", "error": msg}) + "\n"
                        return

                    async for line in response.aiter_lines():
                        if not line:
                            continue
                        if not line.startswith("data:"):
                            continue

                        data = line[5:].strip()
                        if data == "[DONE]":
                            break

                        try:
                            chunk = json.loads(data)
                        except Exception:
                            continue

                        delta = (
                            chunk.get("choices", [{}])[0]
                            .get("delta", {})
                            .get("content", "")
                        )
                        if not delta:
                            continue

                        assistant_text += delta
                        yield json.dumps({"type": "chunk", "text": delta}, ensure_ascii=False) + "\n"

            reply = normalize_reply_from_text(assistant_text, topic, level)
            if web_research and web_research.get("citations"):
                citations = pick_used_citations(assistant_text, web_research["citations"])
                reply["citations"] = citations
                reply["web"] = {"queries": web_research["queries"]}

            yield json.dumps({"type": "done", "reply": reply}, ensure_ascii=False) + "\n"
        except Exception as exc:
            yield json.dumps({"type": "error", "error": str(exc)}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson; charset=utf-8")


@app.get("/")
async def root():
    return FileResponse("index.html")


@app.post("/api/pdf/extract")
async def pdf_extract(file: UploadFile = File(...)):
        name = clean_text(file.filename or "document.pdf")
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        text = ""
        pages = 0

        if name.lower().endswith(".pdf") or (file.content_type or "").lower() == "application/pdf":
            try:
                reader = PdfReader(BytesIO(content))
                pages = len(reader.pages)
                chunks = []
                for page in reader.pages:
                    chunks.append(page.extract_text() or "")
                text = "\n\n".join(chunks)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}")
        else:
            try:
                text = content.decode("utf-8", errors="ignore")
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"Could not read text file: {exc}")

        cleaned = clean_document_text(text)
        if not cleaned:
            raise HTTPException(status_code=400, detail="No extractable text found in file.")

        doc_id = os.urandom(8).hex()
        DOCUMENT_STORE[doc_id] = {
            "id": doc_id,
            "name": name,
            "pages": pages,
            "chars": len(cleaned),
            "text": cleaned[:450000],
        }

        return {
            "id": doc_id,
            "name": name,
            "pages": pages,
            "chars": len(cleaned),
            "preview": clean_text(cleaned)[:500],
        }


@app.post("/api/pdf/graded-reader")
async def pdf_graded_reader(request: Request):
        body = await request.json()
        doc_id = clean_text(body.get("documentId", ""))
        level = normalize_level(body.get("level"))
        objective = clean_text(body.get("objective", ""))

        document = DOCUMENT_STORE.get(doc_id)
        if not document:
            raise HTTPException(status_code=404, detail="Document not found. Upload again.")

        if not DEEPSEEK_API_KEY:
            raise HTTPException(status_code=503, detail="DeepSeek API key is not configured on the server.")

        source_text = document.get("text", "")[:28000]
        prompt_payload = {
            "task": "Create a graded reader pack from source text.",
            "level": level,
            "objective": objective or "help learner understand and retain content",
            "schema": {
                "title": "short Chinese graded-reader title",
                "summary_en": "2-4 sentence English summary",
                "graded_lines": ["short Chinese lines 10-24 total"],
                "glossary": [{"term": "汉字词", "explain_en": "short simple explanation"}],
                "notes": ["brief note about difficult points"],
            },
            "constraints": [
                "Abridge and simplify source faithfully; do not invent key facts.",
                "Keep language at requested HSK level.",
                "Use short, readable lines suitable for graded reader format.",
                "Return only valid JSON.",
            ],
            "source": source_text,
        }

        timeout = httpx.Timeout(60.0, connect=10.0, read=60.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.post(
                "https://api.deepseek.com/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                },
                json={
                    "model": MODEL,
                    "temperature": 0.3,
                    "max_tokens": 1800,
                    "response_format": {"type": "json_object"},
                    "messages": [
                        {
                            "role": "system",
                            "content": "You create graded readers for Mandarin learners. Be faithful to source meaning. Return strict JSON only.",
                        },
                        {"role": "user", "content": json.dumps(prompt_payload, ensure_ascii=False)},
                    ],
                },
            )

        if response.status_code >= 400:
            msg = "DeepSeek request failed."
            try:
                err = response.json()
                msg = err.get("error", {}).get("message", msg)
            except Exception:
                pass
            raise HTTPException(status_code=response.status_code, detail=msg)

        payload = response.json()
        content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
        try:
            parsed = json.loads(content)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Invalid JSON from model: {exc}")

        graded_lines = [clean_text(x) for x in parsed.get("graded_lines", []) if clean_text(x)][:28]
        if not graded_lines:
            graded_lines = ["我们慢慢读这个内容。", "先看重点，再看细节。"]

        result = {
            "title": clean_text(parsed.get("title", f"{document['name']} · Graded Reader"))[:120],
            "summary_en": clean_text(parsed.get("summary_en", ""))[:1200],
            "graded_lines": graded_lines,
            "graded_token_lines": [{"tokens": tokenize_chinese_line(line)} for line in graded_lines],
            "glossary": [
                {
                    "term": clean_text(item.get("term", ""))[:80],
                    "explain_en": clean_text(item.get("explain_en", ""))[:220],
                }
                for item in parsed.get("glossary", [])
                if isinstance(item, dict) and clean_text(item.get("term", ""))
            ][:20],
            "notes": [clean_text(x) for x in parsed.get("notes", []) if clean_text(x)][:12],
            "level": level,
            "documentId": doc_id,
            "documentName": document.get("name", "document"),
        }
        return result


@app.post("/api/pdf/graded-reader-book")
async def pdf_graded_reader_book(request: Request):
        body = await request.json()
        doc_id = clean_text(body.get("documentId", ""))
        level = normalize_level(body.get("level"))
        objective = clean_text(body.get("objective", ""))

        document = DOCUMENT_STORE.get(doc_id)
        if not document:
            raise HTTPException(status_code=404, detail="Document not found. Upload again.")

        if not DEEPSEEK_API_KEY:
            raise HTTPException(status_code=503, detail="DeepSeek API key is not configured on the server.")

        sections = split_document_sections(document.get("text", ""))
        if not sections:
            raise HTTPException(status_code=400, detail="Could not split document into readable sections.")

        max_sections = 24
        truncated = len(sections) > max_sections
        sections = sections[:max_sections]

        chapter_results: list[dict[str, Any]] = []
        for idx, section in enumerate(sections):
            section_title = section.get("title") or f"Section {idx + 1}"
            section_text = section.get("text", "")
            if not section_text:
                continue

            prompt_payload = {
                "task": "Create one chapter of a graded reader from source text.",
                "level": level,
                "objective": objective or "make a complete beginner-friendly graded reader",
                "chapter_index": idx + 1,
                "chapter_title_hint": section_title,
                "schema": {
                    "chapter_title": "short Chinese chapter title",
                    "chapter_summary_en": "2-4 sentence English summary",
                    "graded_lines": ["short Chinese lines for this chapter, 12-36 total"],
                    "glossary": [{"term": "汉字词", "explain_en": "brief explanation"}],
                    "notes": ["short note for difficult points"],
                },
                "constraints": [
                    "Be faithful to source meaning.",
                    "Keep language at requested HSK level.",
                    "Write enough lines to cover this section; do not collapse to tiny summary.",
                    "Return only valid JSON.",
                ],
                "source": section_text[:18000],
            }

            parsed: dict[str, Any]
            used_fallback = False
            try:
                parsed = await request_deepseek_json(prompt_payload, max_tokens=2200)
            except HTTPException as exc:
                if is_content_exists_risk_error(exc.detail):
                    parsed = build_fallback_section_payload(section_title, section_text, level)
                    used_fallback = True
                else:
                    raise

            chapter_lines = [clean_text(x) for x in parsed.get("graded_lines", []) if clean_text(x)][:42]
            if not chapter_lines:
                chapter_lines = ["我们继续读这一章。", "先看主要内容，再看细节。"]

            chapter_results.append(
                {
                    "title": clean_text(parsed.get("chapter_title", section_title))[:120],
                    "summary_en": clean_text(parsed.get("chapter_summary_en", ""))[:800],
                    "graded_lines": chapter_lines,
                    "graded_token_lines": [{"tokens": tokenize_chinese_line(line)} for line in chapter_lines],
                    "glossary": [
                        {
                            "term": clean_text(item.get("term", ""))[:80],
                            "explain_en": clean_text(item.get("explain_en", ""))[:220],
                        }
                        for item in parsed.get("glossary", [])
                        if isinstance(item, dict) and clean_text(item.get("term", ""))
                    ][:16],
                    "notes": [clean_text(x) for x in parsed.get("notes", []) if clean_text(x)][:8],
                    "source_chars": len(section_text),
                    "fallback": used_fallback,
                }
            )

        if not chapter_results:
            raise HTTPException(status_code=500, detail="No chapter content was generated.")

        merged_glossary = merge_glossary(chapter_results)
        merged_notes = merge_notes(chapter_results)

        return {
            "title": clean_text(f"{document.get('name', 'Document')} · Graded Reader")[:140],
            "summary_en": clean_text(chapter_results[0].get("summary_en", ""))[:1200],
            "level": level,
            "documentId": doc_id,
            "documentName": document.get("name", "document"),
            "sections": chapter_results,
            "glossary": merged_glossary,
            "notes": merged_notes,
            "truncated": truncated,
        }


async def request_deepseek_json(prompt_payload: dict[str, Any], max_tokens: int = 1800) -> dict[str, Any]:
    timeout = httpx.Timeout(75.0, connect=10.0, read=75.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.post(
            "https://api.deepseek.com/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            },
            json={
                "model": MODEL,
                "temperature": 0.3,
                "max_tokens": max_tokens,
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": "You write graded readers for Mandarin learners and return strict JSON.",
                    },
                    {"role": "user", "content": json.dumps(prompt_payload, ensure_ascii=False)},
                ],
            },
        )

    if response.status_code >= 400:
        msg = "DeepSeek request failed."
        try:
            err = response.json()
            msg = err.get("error", {}).get("message", msg)
        except Exception:
            pass
        raise HTTPException(status_code=response.status_code, detail=msg)

    payload = response.json()
    content = payload.get("choices", [{}])[0].get("message", {}).get("content", "{}")
    try:
        return json.loads(content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Invalid JSON from model: {exc}")


def split_document_sections(text: str, max_chars: int = 14000, min_chars: int = 3600) -> list[dict[str, str]]:
    source = str(text or "").strip()
    if not source:
        return []

    lines = [line.strip() for line in source.split("\n")]
    heading_rx = re.compile(r"^(第[一二三四五六七八九十百千万0-9]+[章节回]|chapter\s+\d+|ch\.?\s*\d+)\b", re.I)

    sections: list[dict[str, str]] = []
    current_title = ""
    current_parts: list[str] = []

    def flush_section() -> None:
        nonlocal current_title, current_parts
        body = "\n".join(current_parts).strip()
        if body:
            sections.append({"title": current_title or f"Section {len(sections) + 1}", "text": body})
        current_title = ""
        current_parts = []

    for line in lines:
        if not line:
            if current_parts and current_parts[-1] != "":
                current_parts.append("")
            continue

        if heading_rx.search(line) and len("\n".join(current_parts)) >= min_chars:
            flush_section()
            current_title = line[:120]
            continue

        current_parts.append(line)
        if len("\n".join(current_parts)) >= max_chars:
            flush_section()

    flush_section()

    if not sections:
        return []

    merged: list[dict[str, str]] = []
    for section in sections:
        text_len = len(section.get("text", ""))
        if merged and text_len < min_chars // 2:
            merged[-1]["text"] = f"{merged[-1]['text']}\n\n{section['text']}"
            continue
        merged.append(section)
    return merged


def merge_glossary(sections: list[dict[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    seen = set()
    for section in sections:
        for item in section.get("glossary", []):
            term = clean_text(item.get("term", ""))
            explain = clean_text(item.get("explain_en", ""))
            if not term or term in seen:
                continue
            seen.add(term)
            out.append({"term": term, "explain_en": explain})
            if len(out) >= 80:
                return out
    return out


def merge_notes(sections: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    seen = set()
    for section in sections:
        for note in section.get("notes", []):
            value = clean_text(note)
            if not value or value in seen:
                continue
            seen.add(value)
            out.append(value)
            if len(out) >= 60:
                return out
    return out


def is_content_exists_risk_error(detail: Any) -> bool:
    text = str(detail or "").lower()
    return "content exists risk" in text or ("content" in text and "risk" in text)


def build_fallback_section_payload(section_title: str, section_text: str, level: str) -> dict[str, Any]:
    candidates = split_into_sentences(section_text)
    graded_lines = [line for line in candidates if contains_chinese(line)][:36]
    if not graded_lines:
        graded_lines = ["我们继续读这一章。", "先看主要内容，再看细节。"]

    level_hint = f"for {level} learners" if level else "for learners"
    return {
        "chapter_title": clean_text(section_title)[:120] or "本章",
        "chapter_summary_en": f"Fallback chapter compiled from source excerpts {level_hint} when model output was blocked.",
        "graded_lines": graded_lines,
        "glossary": [],
        "notes": ["This chapter was generated using fallback extraction because model content risk was triggered."],
    }


def split_into_sentences(text: str) -> list[str]:
    cleaned = str(text or "").replace("\r", "\n")
    chunks = re.split(r"[\n]+", cleaned)
    out: list[str] = []
    for chunk in chunks:
        piece = chunk.strip()
        if not piece:
            continue
        for sentence in re.split(r"(?<=[。！？!?])", piece):
            s = clean_text(sentence)
            if not s:
                continue
            if 4 <= len(s) <= 80:
                out.append(s)
            if len(out) >= 120:
                return out
    return out


def contains_chinese(text: str) -> bool:
    return re.search(r"[\u3400-\u9fff]", str(text or "")) is not None


@app.post("/api/pdf/graded-reader-pdf")
async def pdf_graded_reader_pdf(request: Request):
        body = await request.json()
        title = clean_text(body.get("title", "Graded Reader"))[:140]
        level = normalize_level(body.get("level"))
        summary = clean_text(body.get("summary_en", ""))[:3000]
        graded_lines = [clean_text(x) for x in body.get("graded_lines", []) if clean_text(x)][:80]
        graded_token_lines = body.get("graded_token_lines", [])
        notes = [clean_text(x) for x in body.get("notes", []) if clean_text(x)][:30]
        glossary = [x for x in body.get("glossary", []) if isinstance(x, dict)][:40]

        if not graded_lines:
            raise HTTPException(status_code=400, detail="No graded lines provided.")

        pdf_bytes = build_graded_reader_pdf(
            title=title,
            level=level,
            summary=summary,
            graded_lines=graded_lines,
            graded_token_lines=graded_token_lines,
            notes=notes,
            glossary=glossary,
        )

        safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", title).strip("-") or "graded-reader"
        headers = {"Content-Disposition": f'attachment; filename="{safe_name}.pdf"'}
        return StreamingResponse(BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)


@app.post("/api/pdf/graded-reader-book-pdf")
async def pdf_graded_reader_book_pdf(request: Request):
        body = await request.json()
        title = clean_text(body.get("title", "Book Graded Reader"))[:140]
        level = normalize_level(body.get("level"))
        summary = clean_text(body.get("summary_en", ""))[:3000]
        sections = body.get("sections", []) if isinstance(body.get("sections", []), list) else []
        glossary = [x for x in body.get("glossary", []) if isinstance(x, dict)][:120]
        notes = [clean_text(x) for x in body.get("notes", []) if clean_text(x)][:120]

        graded_lines: list[str] = []
        graded_token_lines: list[dict[str, Any]] = []
        for idx, section in enumerate(sections[:48]):
            section_title = clean_text(section.get("title", f"Section {idx + 1}"))[:120]
            heading = f"【{section_title}】"
            graded_lines.append(heading)
            graded_token_lines.append({"tokens": tokenize_chinese_line(heading)})

            for line in section.get("graded_lines", [])[:48]:
                clean_line = clean_text(line)
                if not clean_line:
                    continue
                graded_lines.append(clean_line)

            for token_line in section.get("graded_token_lines", [])[:48]:
                if isinstance(token_line, dict) and isinstance(token_line.get("tokens"), list):
                    graded_token_lines.append({"tokens": token_line.get("tokens", [])})

        if not graded_lines:
            raise HTTPException(status_code=400, detail="No graded book content provided.")

        pdf_bytes = build_graded_reader_pdf(
            title=title,
            level=level,
            summary=summary,
            graded_lines=graded_lines[:2400],
            graded_token_lines=graded_token_lines[:2400],
            notes=notes,
            glossary=glossary,
        )

        safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", title).strip("-") or "graded-reader-book"
        headers = {"Content-Disposition": f'attachment; filename="{safe_name}.pdf"'}
        return StreamingResponse(BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)


@app.post("/api/pdf/hanzi-pinyin")
async def pdf_hanzi_pinyin(file: UploadFile = File(...)):
        name = clean_text(file.filename or "document.pdf")
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")

        if not (name.lower().endswith(".pdf") or (file.content_type or "").lower() == "application/pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files are supported.")

        try:
            reader = PdfReader(BytesIO(content))
            pages = [page.extract_text() or "" for page in reader.pages]
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Could not read PDF: {exc}")

        pdf_bytes = build_hanzi_pinyin_pdf(pages)
        safe_name = re.sub(r"[^a-zA-Z0-9_-]+", "-", name).strip("-") or "hanzi-pinyin"
        headers = {"Content-Disposition": f'attachment; filename="{safe_name}-pinyin.pdf"'}
        return StreamingResponse(BytesIO(pdf_bytes), media_type="application/pdf", headers=headers)


app.mount("/", StaticFiles(directory=".", html=True), name="static")


def clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:5000]


def clean_document_text(value: Any) -> str:
    raw = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    raw = raw.replace("\x00", " ")
    lines = [re.sub(r"\s+", " ", line).strip() for line in raw.split("\n")]
    compact_lines: list[str] = []
    blank_count = 0
    for line in lines:
        if not line:
            blank_count += 1
            if blank_count <= 1:
                compact_lines.append("")
            continue
        blank_count = 0
        compact_lines.append(line)
    return "\n".join(compact_lines).strip()[:450000]


def normalize_level(level_value: Any) -> str:
    match = re.match(r"^hsk\s*([1-7])$", str(level_value or "").lower())
    if not match:
        return "HSK 1"
    return f"HSK {match.group(1)}"


def normalize_history(history: Any) -> list[dict[str, str]]:
    if not isinstance(history, list):
        return []

    out: list[dict[str, str]] = []
    for item in history[-60:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        out.append({"role": role, "content": clean_text(content)})
    return out


def normalize_memory(memory: Any) -> list[str]:
    if not isinstance(memory, list):
        return []
    return [clean_text(x) for x in memory if clean_text(x)][-28:]


def normalize_web_options(web: Any) -> dict[str, Any]:
    web = web if isinstance(web, dict) else {}
    enabled = bool(web.get("enabled", False))
    follow_depth = int(web.get("followDepth", 1) or 0)
    follow_depth = max(0, min(3, follow_depth))
    seed_urls = normalize_seed_urls(web.get("seedUrls"))
    return {
        "enabled": enabled,
        "followDepth": follow_depth,
        "seedUrls": seed_urls,
        "useSearch": bool(web.get("useSearch", True)),
        "maxResultsPerQuery": 5,
        "maxPages": 8,
        "maxLinksPerPage": 4,
    }


def normalize_seed_urls(seed_urls: Any) -> list[str]:
    if not isinstance(seed_urls, list):
        return []
    out: list[str] = []
    seen = set()
    for item in seed_urls[:8]:
        url = str(item or "").strip()
        if not re.match(r"^https?://", url, re.I):
            continue
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out[:6]


def build_deepseek_messages(
    history: list[dict[str, str]],
    memory: list[str],
    make_lesson_mode: bool,
    level: str,
    topic: str,
    user_message: str,
    web_research: dict[str, Any] | None,
    document_context: str | None,
) -> list[dict[str, str]]:
    mode_line = (
        "Start a fresh micro-lesson with gentle scaffolding and repetition."
        if make_lesson_mode
        else "Continue naturally from context with short useful lines."
    )

    level_number = int(level.replace("HSK ", "") or "1")
    if level_number <= 2:
        level_line = "Use very simple words and short sentences."
    elif level_number <= 4:
        level_line = "Use simple but slightly richer vocabulary and short connected sentences."
    else:
        level_line = "Use natural intermediate vocabulary while staying clear and learner-friendly."

    memory_line = (
        f"Session memory to keep consistent: {' | '.join(memory)}"
        if memory
        else "Session memory to keep consistent: none"
    )

    web_line = (
        "You have web research context with numbered sources. Use these facts when relevant and cite source numbers inline like [1]."
        if web_research and web_research.get("context")
        else "No web research context provided."
    )
    doc_line = (
        "You have uploaded source material context. Use it to explain and simplify for the learner."
        if document_context
        else "No uploaded document context provided."
    )

    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": " ".join(
                [
                    "You are a Mandarin crosstalk tutor chatbot for English-speaking beginners.",
                    "Use Simplified Chinese and Mainland Mandarin vocabulary.",
                    "Do not require the learner to produce Chinese.",
                    "Keep Chinese aligned to the requested HSK level with clear, comprehensible phrasing.",
                    "For politics, Marxism, art, literature, Mao Zedong, and modern Chinese history, use a neutral casual textbook style.",
                    "Avoid dense biography dumps and avoid many dates or slogans.",
                    "Reply only with 3-8 lines of Chinese text.",
                    "No markdown, no JSON, no bullet list, no translation, no pinyin in output.",
                    "Treat recent multi-turn context as authoritative and stay consistent with prior turns.",
                    "If web facts are used, include source markers like [1] in the line.",
                    level_line,
                    memory_line,
                    web_line,
                    doc_line,
                ]
            ),
        }
    ]

    if web_research and web_research.get("context"):
        messages.append({"role": "system", "content": f"Web context:\n{web_research['context']}"})

    if document_context:
        messages.append({"role": "system", "content": f"Uploaded document context:\n{document_context}"})

    messages.extend(history)

    messages.append(
        {
            "role": "user",
            "content": "\n".join(
                [
                    f"Mode: {'new_lesson' if make_lesson_mode else 'continue_chat'}",
                    f"Guidance: {mode_line}",
                    f"Level: {level}",
                    f"Topic: {topic}",
                    f"Learner message: {user_message}",
                ]
            ),
        }
    )

    return messages


def rewrite_queries(topic: str, user_message: str, seed_urls: list[str] | None = None) -> list[str]:
    user_message = re.sub(r"https?://\S+", " ", str(user_message or ""))
    seed = clean_text(f"{topic} {user_message}")
    compact = re.sub(r"\s+", " ", re.sub(r"[?!.]", " ", seed)).strip()
    queries = [
        compact,
        f"{compact} background overview",
        f"{compact} reliable sources timeline",
    ]
    if seed_urls:
        first_host = urlparse(seed_urls[0]).netloc
        if first_host and compact:
            queries.append(f"site:{first_host} {compact}")
    deduped: list[str] = []
    seen = set()
    for query in queries:
        q = query[:180].strip()
        if not q or q in seen:
            continue
        seen.add(q)
        deduped.append(q)
    return deduped[:3]


async def build_web_research(
    user_message: str,
    topic: str,
    history: list[dict[str, str]],
    web: dict[str, Any],
) -> dict[str, Any] | None:
    last_turns = " ".join(item["content"] for item in history[-4:])
    seed_results = [
        {
            "title": "User-provided link",
            "url": url,
            "snippet": "Link shared by user in chat",
        }
        for url in web.get("seedUrls", [])
    ]

    queries = rewrite_queries(topic, f"{user_message} {last_turns}", web.get("seedUrls", []))
    search_results: list[dict[str, str]] = []
    if web.get("useSearch", True):
        search_results = await search_queries(queries, web["maxResultsPerQuery"])

    deduped_results: list[dict[str, str]] = []
    seen_urls = set()
    for item in seed_results + search_results:
        url = item.get("url", "")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        deduped_results.append(item)

    if not deduped_results:
        return None

    pages = await crawl_pages(
        deduped_results,
        follow_depth=web["followDepth"],
        max_pages=web["maxPages"],
        max_links_per_page=web["maxLinksPerPage"],
    )

    citations = []
    for index, page in enumerate(pages[:8]):
        citations.append(
            {
                "id": index + 1,
                "title": page.get("title") or page.get("url"),
                "url": page.get("url"),
                "snippet": page.get("snippet", ""),
            }
        )

    if not citations:
        return None

    parts = []
    for idx, citation in enumerate(citations):
        content = pages[idx].get("content", "")
        parts.append(
            "\n".join(
                [
                    f"[{citation['id']}] {citation['title']}",
                    f"URL: {citation['url']}",
                    f"Snippet: {citation['snippet']}",
                    f"Extract: {content}",
                ]
            )
        )

    context = "\n\n".join(parts)[:12000]
    return {"queries": queries, "citations": citations, "context": context}


async def search_queries(queries: list[str], max_results_per_query: int) -> list[dict[str, str]]:
    all_results: list[dict[str, str]] = []
    for query in queries:
        items = await search_duckduckgo(query, max_results_per_query)
        for item in items:
            item["query"] = query
            all_results.append(item)

    deduped: list[dict[str, str]] = []
    seen = set()
    for item in all_results:
        url = item.get("url", "")
        if not url or url in seen:
            continue
        seen.add(url)
        deduped.append(item)
    return deduped[:12]


async def search_duckduckgo(query: str, limit: int) -> list[dict[str, str]]:
    url = f"https://duckduckgo.com/html/?q={quote_plus(query)}"
    response = await fetch_with_timeout(
        url,
        headers={
            "User-Agent": WEB_USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
        },
    )

    if response is None or response.status_code >= 400:
        return []

    html = response.text
    soup = BeautifulSoup(html, "html.parser")
    results = []

    for el in soup.select(".result"):
        if len(results) >= limit:
            break

        link = el.select_one("a.result__a")
        title = clean_text(link.get_text(" ", strip=True)) if link else ""
        href = resolve_result_url(link.get("href", "") if link else "")
        snippet_el = el.select_one(".result__snippet")
        snippet = clean_text(snippet_el.get_text(" ", strip=True) if snippet_el else "")

        if not href:
            continue

        results.append(
            {
                "title": title or href,
                "url": href,
                "snippet": snippet,
            }
        )

    return results


def resolve_result_url(raw_href: str) -> str:
    if not raw_href:
        return ""

    try:
        if raw_href.startswith("http://") or raw_href.startswith("https://"):
            return raw_href

        full = urljoin("https://duckduckgo.com", raw_href)
        parsed = urlparse(full)
        query = parse_qs(parsed.query)
        redirected = query.get("uddg", [None])[0]
        if redirected:
            return unquote(redirected)
        return full
    except Exception:
        return ""


async def crawl_pages(
    seed_results: list[dict[str, Any]],
    follow_depth: int,
    max_pages: int,
    max_links_per_page: int,
) -> list[dict[str, Any]]:
    queue = [{**item, "depth": 0} for item in seed_results]
    visited: set[str] = set()
    pages: list[dict[str, Any]] = []

    while queue and len(pages) < max_pages:
        next_item = queue.pop(0)
        url = next_item.get("url")
        if not url or url in visited:
            continue
        visited.add(url)

        page = await fetch_page_content(url)
        if not page:
            continue

        pages.append(
            {
                "title": next_item.get("title") or page.get("title") or url,
                "url": url,
                "snippet": next_item.get("snippet") or page.get("snippet", ""),
                "content": page.get("content", ""),
            }
        )

        if next_item.get("depth", 0) >= follow_depth:
            continue

        for link in page.get("links", [])[:max_links_per_page]:
            if link not in visited:
                queue.append({"title": "", "snippet": "", "url": link, "depth": next_item.get("depth", 0) + 1})

    return pages


async def fetch_page_content(url: str) -> dict[str, Any] | None:
    if not re.match(r"^https?://", url, re.I):
        return None

    response = await fetch_with_timeout(
        url,
        headers={
            "User-Agent": WEB_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )

    if response is None or response.status_code >= 400:
        return None

    content_type = response.headers.get("content-type", "")
    if "text/html" not in content_type:
        return None

    soup = BeautifulSoup(response.text, "html.parser")
    for tag in soup.select("script,style,noscript,svg,iframe,header,footer,nav,aside"):
        tag.decompose()

    title = clean_text((soup.title.get_text(" ", strip=True) if soup.title else ""))
    text = clean_text(soup.get_text(" ", strip=True))
    if not text:
        return None

    links = []
    for a in soup.select("a[href]"):
        if len(links) >= 12:
            break
        href = a.get("href", "")
        try:
            resolved = urljoin(url, href)
            parsed = urlparse(resolved)
            if parsed.scheme not in ("http", "https"):
                continue
            if re.search(r"\.(jpg|jpeg|png|gif|webp|pdf|zip|mp4|mp3)$", resolved, re.I):
                continue
            if resolved not in links:
                links.append(resolved)
        except Exception:
            continue

    return {
        "title": title,
        "snippet": text[:260],
        "content": text[:1600],
        "links": links,
    }


async def fetch_with_timeout(url: str, headers: dict[str, str], timeout_seconds: float = 9.0):
    timeout = httpx.Timeout(timeout_seconds, connect=min(timeout_seconds, 10.0))
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            return await client.get(url, headers=headers)
    except Exception:
        return None


def pick_used_citations(text: str, citations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    matches = re.findall(r"\[(\d+)]", str(text or ""))
    used_ids = {int(m) for m in matches if m.isdigit()}
    if not used_ids:
        return citations[:4]
    out = [citation for citation in citations if citation.get("id") in used_ids]
    return out[:8]


def build_document_context(document_id: str) -> str | None:
        if not document_id:
            return None
        doc = DOCUMENT_STORE.get(document_id)
        if not doc:
            return None

        name = doc.get("name", "document")
        text = clean_text(doc.get("text", ""))[:9000]
        if not text:
            return None
        return f"Document: {name}\n{text}"


def build_graded_reader_pdf(
        title: str,
        level: str,
        summary: str,
        graded_lines: list[str],
    graded_token_lines: list[dict[str, Any]],
        notes: list[str],
        glossary: list[dict[str, Any]],
) -> bytes:
        buffer = BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=A4)
        width, height = A4
        margin_x = 42
        min_y = 58
        y = height - 48

        def new_page():
            nonlocal y
            pdf.showPage()
            y = height - 48

        def ensure_room(required: int):
            if y - required < min_y:
                new_page()

        def write_line(text: str, size: int = 11, leading: int = 16, indent: int = 0, font: str = "STSong-Light"):
            nonlocal y
            pdf.setFont(font, size)
            wrapped = wrap_text(text, max_chars=max(14, int((width - margin_x * 2 - indent) / (size * 0.9))))
            for line in wrapped:
                ensure_room(leading)
                pdf.setFont(font, size)
                pdf.drawString(margin_x + indent, y, line)
                y -= leading

        def write_interlinear(tokens: list[dict[str, str]], hanzi_size: int = 13, pinyin_size: int = 8):
            nonlocal y
            if not tokens:
                return

            max_x = width - margin_x
            x = margin_x
            line_step = hanzi_size + pinyin_size + 11
            ensure_room(line_step)

            def new_row():
                nonlocal x, y
                y -= line_step
                if y < min_y:
                    new_page()
                x = margin_x

            for token in tokens:
                hanzi = clean_text(token.get("hanzi", ""))
                py = pdf_safe_pinyin(clean_text(token.get("pinyin", "")))
                if not hanzi:
                    continue

                hanzi_w = pdf.stringWidth(hanzi, "STSong-Light", hanzi_size)
                py_w = pdf.stringWidth(py, PINYIN_FONT, pinyin_size) if py else 0
                cell_w = max(hanzi_w, py_w, 10) + 8

                if x + cell_w > max_x:
                    new_row()

                cx = x + (cell_w / 2)
                if py:
                    pdf.setFont(PINYIN_FONT, pinyin_size)
                    pdf.drawCentredString(cx, y, py)

                pdf.setFont("STSong-Light", hanzi_size)
                pdf.drawCentredString(cx, y - (pinyin_size + 6), hanzi)
                x += cell_w

            y -= line_step

        write_line(title, size=18, leading=24)
        write_line(f"Level: {level}", size=11, leading=16)
        y -= 4
        write_line("Summary", size=13, leading=20)
        write_line(summary or "(No summary)")
        y -= 6
        write_line("Graded Reader (Interlinear)", size=13, leading=20)

        token_lines = []
        if isinstance(graded_token_lines, list):
            for item in graded_token_lines[:2400]:
                if isinstance(item, dict):
                    raw_tokens = item.get("tokens", [])
                else:
                    raw_tokens = []
                tokens = []
                if isinstance(raw_tokens, list):
                    for token in raw_tokens:
                        if not isinstance(token, dict):
                            continue
                        hanzi = clean_text(token.get("hanzi", ""))
                        pinyin_value = clean_text(token.get("pinyin", ""))
                        if hanzi:
                            tokens.append({"hanzi": hanzi, "pinyin": pinyin_value})
                if tokens:
                    token_lines.append(tokens)

        if not token_lines:
            token_lines = [tokenize_chinese_line(line) for line in graded_lines if clean_text(line)]

        for tokens in token_lines:
            write_interlinear(tokens, hanzi_size=13, pinyin_size=8)

        if glossary:
            y -= 6
            write_line("Glossary", size=13, leading=20)
            for item in glossary:
                term = clean_text(item.get("term", ""))
                explain = clean_text(item.get("explain_en", ""))
                if not term:
                    continue
                write_line(f"- {term}: {explain}", size=11, leading=16)

        if notes:
            y -= 6
            write_line("Notes", size=13, leading=20)
            for note in notes:
                write_line(f"- {note}", size=11, leading=16)

        pdf.showPage()
        pdf.save()
        return buffer.getvalue()


def wrap_text(text: str, max_chars: int = 60) -> list[str]:
        source = str(text or "").strip()
        if not source:
            return [""]

        lines = []
        current = ""
        for ch in source:
            current += ch
            if len(current) >= max_chars and ch in " ，。！？,.!?;；:：":
                lines.append(current.strip())
                current = ""

        if current.strip():
            while len(current) > max_chars:
                lines.append(current[:max_chars].strip())
                current = current[max_chars:]
            if current.strip():
                lines.append(current.strip())

        return lines[:300]


def is_chinese_char(char: str) -> bool:
    return re.search(r"[\u3400-\u9fff]", char) is not None


def is_punctuation(char: str) -> bool:
    return re.search(r"[，。？！、：；,.!?;:\"'“”‘’（）()《》【】\-]", char) is not None


def tone_mark_for_char(char: str) -> str:
    result = pinyin(char, style=Style.TONE, heteronym=False, strict=False)
    if not result or not result[0]:
        return ""
    return result[0][0]


def pdf_safe_pinyin(text: str) -> str:
    value = str(text or "").strip()
    if not value:
        return ""
    return unicodedata.normalize("NFC", value)


def tokenize_chinese_line(line: str) -> list[dict[str, str]]:
    source = str(line or "").strip()
    if not source:
        return []

    tokens: list[dict[str, str]] = []
    latin_buffer = ""

    def flush_latin() -> None:
        nonlocal latin_buffer
        if not latin_buffer:
            return
        tokens.append({"hanzi": latin_buffer, "pinyin": ""})
        latin_buffer = ""

    for char in source:
        if re.search(r"\s", char):
            flush_latin()
            continue

        if is_punctuation(char):
            flush_latin()
            tokens.append({"hanzi": char, "pinyin": ""})
            continue

        if is_chinese_char(char):
            flush_latin()
            tokens.append({"hanzi": char, "pinyin": tone_mark_for_char(char)})
            continue

        latin_buffer += char

    flush_latin()
    return tokens[:80]


def tokenize_original_line_for_pinyin(line: str) -> list[dict[str, str]]:
    tokens: list[dict[str, str]] = []
    for char in str(line or ""):
        if char == "\r":
            continue
        tokens.append(
            {
                "hanzi": char,
                "pinyin": tone_mark_for_char(char) if is_chinese_char(char) else "",
            }
        )
    return tokens


def build_hanzi_pinyin_pdf(pages: list[str]) -> bytes:
    buffer = BytesIO()
    pdf = canvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    margin_x = 42
    y = height - 48

    hanzi_size = 13
    pinyin_size = 8
    line_step = hanzi_size + pinyin_size + 10
    pinyin_y_offset = 0
    hanzi_y_offset = -(pinyin_size + 6)
    max_x = width - margin_x

    def new_page():
        nonlocal y
        pdf.showPage()
        y = height - 48

    def ensure_room(min_height: int = 58):
        nonlocal y
        if y < min_height:
            new_page()

    def draw_interlinear_line(tokens: list[dict[str, str]]):
        nonlocal y
        if not tokens:
            y -= line_step // 2
            ensure_room()
            return

        x = margin_x
        for token in tokens:
            hanzi = token.get("hanzi", "")
            py = pdf_safe_pinyin(token.get("pinyin", ""))
            if not hanzi:
                continue

            hanzi_w = pdf.stringWidth(hanzi, "STSong-Light", hanzi_size)
            py_w = pdf.stringWidth(py, PINYIN_FONT, pinyin_size) if py else 0
            cell_w = max(hanzi_w, py_w, 5) + 3

            if x + cell_w > max_x and hanzi.strip():
                y -= line_step
                ensure_room()
                x = margin_x

            cx = x + (cell_w / 2)
            if py:
                pdf.setFont(PINYIN_FONT, pinyin_size)
                pdf.drawCentredString(cx, y + pinyin_y_offset, py)

            if hanzi.strip():
                pdf.setFont("STSong-Light", hanzi_size)
                pdf.drawCentredString(cx, y + hanzi_y_offset, hanzi)

            x += cell_w

        y -= line_step
        ensure_room()

    for page_index, page_text in enumerate(pages):
        raw_lines = str(page_text or "").splitlines()
        if not raw_lines:
            raw_lines = [""]

        for raw_line in raw_lines:
            if not raw_line.strip():
                y -= line_step // 2
                ensure_room()
                continue
            draw_interlinear_line(tokenize_original_line_for_pinyin(raw_line))

        if page_index < len(pages) - 1:
            new_page()

    pdf.save()
    return buffer.getvalue()


def normalize_reply_from_text(text: str, topic: str, level: str) -> dict[str, Any]:
    normalized_text = re.sub(r"\s+", " ", str(text or "").replace("\r", "\n")).strip()
    line_candidates = []
    for line in re.split(r"\n+", normalized_text):
        parts = re.split(r"(?<=[。？！!?])", line)
        for part in parts:
            cleaned = re.sub(r"^\s*[-*\d.、)）]+\s*", "", part)
            cleaned = re.sub(r"\[\d+\]", "", cleaned).strip()
            if cleaned:
                line_candidates.append(cleaned)

    lines = []
    for line in line_candidates[:8]:
        tokens = tokenize_chinese_line(line)
        if tokens:
            lines.append({"tokens": tokens})

    fallback = "我们继续慢慢学中文。" if level == "HSK 2" else "我们慢慢听中文。"
    if not lines:
        lines = [{"tokens": tokenize_chinese_line(fallback)}]

    return {
        "reply": {"lines": lines},
        "topic": topic,
        "level": level,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=False)
