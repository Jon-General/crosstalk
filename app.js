import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const MEMORY_KEY = "crosstalk-session-memory-v1";

const QUICK_REPLIES = [
  "Give two more examples like this.",
  "Please make it easier and shorter.",
  "Can you summarize this in 4 short lines?",
];

const GRADED_QUICK_REPLIES = [
  "Abridge this document to my current HSK level.",
  "Keep key ideas but simplify hard parts.",
  "Make a printable graded-reader PDF.",
];

const GRADED_COMMAND = /^\s*(\/grade|grade\s+reader|abridge\s+(this\s+)?(pdf|document)|annotate\s+(this\s+)?(pdf|document))\b/i;

const LEVELS = Array.from({ length: 7 }, (_, i) => ({
  value: `hsk${i + 1}`,
  label: `HSK ${i + 1}`,
}));

function normalizeTokens(tokens) {
  if (!Array.isArray(tokens)) return [];
  return tokens
    .map((token) => ({
      hanzi: String(token?.hanzi || token?.text || "").trim(),
      pinyin: String(token?.pinyin || "").trim(),
    }))
    .filter((token) => token.hanzi);
}

function splitFallbackTokens(text) {
  const src = String(text || "").trim();
  if (!src) return [];
  const out = [];
  for (const ch of src) {
    if (/\s/.test(ch)) continue;
    out.push({ hanzi: ch, pinyin: "" });
  }
  return out;
}

function normalizeLine(line) {
  const tokens = normalizeTokens(line?.tokens || line);
  if (tokens.length) return { tokens };
  return { tokens: splitFallbackTokens(line?.text || line) };
}

function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.map(normalizeLine).filter((line) => line.tokens.length);
}

function toPlainText(lines) {
  return lines.map((line) => line.tokens.map((t) => t.hanzi).join("")).join("\n");
}

function TokenLine({ tokens }) {
  return html`<div className="interlinear-line">
    ${tokens.map((token, idx) => {
      if (/^[，。？！、：；]$/.test(token.hanzi)) {
        return html`<span key=${idx} className="punct">${token.hanzi}</span>`;
      }
      return html`<ruby key=${idx} className="word">
        ${token.hanzi}
        ${token.pinyin ? html`<rt>${token.pinyin}</rt>` : null}
      </ruby>`;
    })}
  </div>`;
}

function MessageBubble({ msg }) {
  if (msg.type === "notice") {
    return html`<article className="message notice">${msg.text}</article>`;
  }

  if (msg.role === "user") {
    return html`<article className="message user"><p>${msg.text}</p></article>`;
  }

  if (msg.pending) {
    return html`<article className="message tutor pending"><p className="pending-text">${msg.text || "Thinking..."}</p></article>`;
  }

  return html`<article className="message tutor">
    ${msg.lines.map((line, idx) => html`<${TokenLine} key=${idx} tokens=${line.tokens} />`)}
    ${msg.citations?.length
      ? html`<div className="citations">
          <p>Sources</p>
          <ul>
            ${msg.citations.map(
              (citation) => html`<li key=${citation.id}>
                <a href=${citation.url} target="_blank" rel="noopener noreferrer">[${citation.id}] ${citation.title || citation.url}</a>
              </li>`,
            )}
          </ul>
        </div>`
      : null}
  </article>`;
}

function App() {
  const [mode, setMode] = useState("casual");
  const [level, setLevel] = useState("hsk1");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState([
    { id: crypto.randomUUID(), type: "notice", text: "New session started." },
    { id: crypto.randomUUID(), type: "notice", text: "Chat ready." },
  ]);
  const [history, setHistory] = useState([]);
  const [memory, setMemory] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(MEMORY_KEY) || "[]");
      if (!Array.isArray(saved)) return [];
      return saved
        .filter((fact) => !/^Current level:/i.test(String(fact)) && !/^Current topic:/i.test(String(fact)))
        .slice(-16);
    } catch {
      return [];
    }
  });
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [documentMeta, setDocumentMeta] = useState(null);
  const [gradedPack, setGradedPack] = useState(null);

  const chatLogRef = useRef(null);
  const inputRef = useRef(null);
  const uploadRef = useRef(null);

  const hskLabel = useMemo(() => LEVELS.find((x) => x.value === level)?.label || "HSK 1", [level]);
  const activeQuickReplies = mode === "graded" ? GRADED_QUICK_REPLIES : QUICK_REPLIES;

  useEffect(() => {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory.slice(-16)));
  }, [memory]);

  function scrollToBottomSoon() {
    requestAnimationFrame(() => {
      if (chatLogRef.current) {
        chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
      }
    });
  }

  function addUserMessage(text) {
    const msg = { id: crypto.randomUUID(), role: "user", text };
    setMessages((prev) => [...prev, msg]);
    scrollToBottomSoon();
  }

  function addNotice(text) {
    const msg = { id: crypto.randomUUID(), type: "notice", text };
    setMessages((prev) => [...prev, msg]);
    scrollToBottomSoon();
  }

  function rememberFact(fact) {
    const value = String(fact || "").trim();
    if (!value) return;
    setMemory((prev) => {
      if (prev.includes(value)) return prev;
      return [...prev.slice(-15), value];
    });
  }

  function upsertScopedFact(prefix, value) {
    const cleanValue = String(value || "").trim();
    if (!cleanValue) return;
    const scoped = `${prefix}${cleanValue}`;
    setMemory((prev) => {
      const next = prev.filter((fact) => !String(fact).startsWith(prefix));
      next.push(scoped);
      return next.slice(-16);
    });
  }

  function extractMemoryFromUserMessage(text) {
    const src = String(text || "").trim();
    if (!src) return [];
    const facts = [];

    const remember = src.match(/remember\s+(.+)$/i);
    if (remember?.[1]) {
      facts.push(`User says to remember: ${remember[1].trim()}`);
    }

    const name = src.match(/\bmy name is\s+([a-z][a-z\s'-]{1,30})/i);
    if (name?.[1]) {
      facts.push(`User name: ${name[1].trim()}`);
    }

    const preference = src.match(/\b(i like|i prefer|i want)\s+(.+)$/i);
    if (preference?.[2]) {
      facts.push(`User preference: ${preference[2].trim()}`);
    }

    if (src.length > 8 && src.length <= 120 && facts.length === 0) {
      facts.push(`Recent user message: ${src}`);
    }

    return facts.slice(0, 3);
  }

  function clearChat() {
    setHistory([]);
    setMemory([]);
    setDocumentMeta(null);
    setGradedPack(null);
    setError("");
    setMessages([
      { id: crypto.randomUUID(), type: "notice", text: "New session started." },
      { id: crypto.randomUUID(), type: "notice", text: "Chat ready." },
    ]);
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setMenuOpen(false);
    addNotice(nextMode === "casual" ? "Mode: Casual conversation" : "Mode: PDF to graded reader");
  }

  function toHistoryPayload(nextHistory) {
    return nextHistory.slice(-12).map((item) => ({ role: item.role, content: item.content }));
  }

  async function requestTutorTurn(userMessage, makeLessonMode) {
    setBusy(true);
    setError("");

    const pendingId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", pending: true, text: "" }]);
    scrollToBottomSoon();

    let nextHistory;
    setHistory((prev) => {
      nextHistory = [...prev, { role: "user", content: userMessage }];
      return nextHistory;
    });

    const extracted = extractMemoryFromUserMessage(userMessage);
    if (extracted.length) {
      setMemory((prev) => {
        const next = [...prev];
        extracted.forEach((fact) => {
          if (!next.includes(fact)) next.push(fact);
        });
        return next.slice(-16);
      });
    }

    const topicFact = "Current topic: current chat";
    const levelFact = `Current level: ${hskLabel}`;
    const stableMemory = memory.filter(
      (fact) => !String(fact).startsWith("Current topic:") && !String(fact).startsWith("Current level:"),
    );
    const memoryPayload = [...stableMemory, topicFact, levelFact, ...extracted].slice(-16);

    try {
      const response = await fetch("/api/tutor-turn-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level,
          topic: "current chat",
          makeLessonMode,
          message: userMessage,
          history: toHistoryPayload(nextHistory || []),
          memory: memoryPayload,
          web: { enabled: true, followDepth: 2 },
          documentId: documentMeta?.id || "",
        }),
      });

      if (!response.ok) {
        const raw = await response.text();
        const payload = raw ? JSON.parse(raw) : {};
        throw new Error(payload?.error || "AI request failed.");
      }

      if (!response.body) {
        throw new Error("Model stream not available.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalReply = null;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");

          if (!line) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "chunk") {
            const chunk = String(event.text || "");
            setMessages((prev) => prev.map((m) => (m.id === pendingId ? { ...m, text: (m.text || "") + chunk } : m)));
            scrollToBottomSoon();
            continue;
          }

          if (event.type === "error") {
            throw new Error(event.error || "Streaming failed.");
          }

          if (event.type === "done") {
            finalReply = event.reply;
          }
        }
      }

      const lines = normalizeLines(finalReply?.reply?.lines || []);
      if (!lines.length) {
        throw new Error("Model response did not include usable lesson lines.");
      }

      const citations = Array.isArray(finalReply?.citations) ? finalReply.citations : [];
      setMessages((prev) => prev.map((m) => (m.id === pendingId ? { id: pendingId, role: "assistant", lines, citations } : m)));
      setHistory((prev) => [...prev, { role: "assistant", content: toPlainText(lines) }]);

      if (finalReply?.web?.queries?.length) {
        addNotice(`Web queries used: ${finalReply.web.queries.join(" | ")}`);
      }

      scrollToBottomSoon();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unexpected error.";
      setMessages((prev) => prev.filter((m) => m.id !== pendingId));
      addNotice(`Error: ${message}`);
      setError(message);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    addUserMessage(text);

    if (GRADED_COMMAND.test(text)) {
      if (!documentMeta?.id) {
        addNotice("Upload a PDF first, then run the grade reader command.");
        return;
      }
      await makeGradedReader();
      return;
    }

    if (mode === "graded" && /\b(make|create|generate)\b.*\b(reader|graded|pdf)\b/i.test(text) && documentMeta?.id) {
      await makeGradedReader();
      return;
    }

    await requestTutorTurn(text, false);
  }

  async function handleUploadPdf(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setPdfBusy(true);
    setError("");

    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/pdf/extract", {
        method: "POST",
        body: form,
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Failed to extract PDF.");
      }

      setDocumentMeta(payload);
      setGradedPack(null);
      addNotice(`Loaded: ${payload.name} (${payload.pages || 0} pages, ${payload.chars} chars)`);
      if (payload.preview) {
        addNotice(`Preview: ${payload.preview.slice(0, 220)}...`);
      }
      rememberFact(`Loaded document: ${payload.name}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to upload document.";
      setError(message);
      addNotice(`Error: ${message}`);
    } finally {
      setPdfBusy(false);
      event.target.value = "";
    }
  }

  async function makeGradedReader() {
    if (!documentMeta?.id || busy || pdfBusy) return;

    setPdfBusy(true);
    setError("");
    addNotice("Generating graded reader pack from your document...");

    try {
      const response = await fetch("/api/pdf/graded-reader", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: documentMeta.id,
          level,
          objective: "annotate and abridge difficult content into a graded reader",
        }),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || payload?.error || "Failed to build graded reader.");
      }

      setGradedPack(payload);

      const lines = normalizeLines(payload.graded_token_lines || (payload.graded_lines || []).map((line) => ({ text: line })));
      if (lines.length) {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "assistant", lines }]);
        setHistory((prev) => [...prev, { role: "assistant", content: toPlainText(lines) }]);
      }
      addNotice("Graded reader ready. You can download PDF now.");
      scrollToBottomSoon();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to build graded reader.";
      setError(message);
      addNotice(`Error: ${message}`);
    } finally {
      setPdfBusy(false);
    }
  }

  async function downloadGradedPdf() {
    if (!gradedPack || busy || pdfBusy) return;
    setPdfBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pdf/graded-reader-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(gradedPack),
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || payload?.error || "Failed to generate PDF.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(gradedPack.title || "graded-reader").replace(/[^a-z0-9_-]+/gi, "-")}.pdf`;
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to download PDF.";
      setError(message);
      addNotice(`Error: ${message}`);
    } finally {
      setPdfBusy(false);
    }
  }

  return html`
    <div className="app-shell">
      <main className="chat-shell" aria-label="Tutor chat">
        <div>
          <div className="chat-header">
            <span className="chat-header-title">
              crosstalk
              <span className="chat-header-mode">${mode === "graded" ? "· PDF Reader" : "· Casual"}</span>
            </span>
            <button
              type="button"
              className=${`menu-toggle ${menuOpen ? "open" : ""}`}
              onClick=${() => setMenuOpen((o) => !o)}
              aria-label=${menuOpen ? "Close menu" : "Open menu"}
              aria-expanded=${menuOpen}
            >
              ${menuOpen ? "✕" : "☰"}
            </button>
          </div>

          ${menuOpen
            ? html`<div className="menu-panel">
                <div className="menu-modes">
                  <button
                    type="button"
                    className=${`mode-btn ${mode === "casual" ? "active" : ""}`}
                    onClick=${() => switchMode("casual")}
                    disabled=${busy || pdfBusy}
                  >
                    Casual Conversation
                  </button>
                  <button
                    type="button"
                    className=${`mode-btn ${mode === "graded" ? "active" : ""}`}
                    onClick=${() => switchMode("graded")}
                    disabled=${busy || pdfBusy}
                  >
                    PDF → Graded Reader
                  </button>
                  <button
                    type="button"
                    className="mode-btn subtle"
                    disabled=${busy || pdfBusy}
                    onClick=${() => { clearChat(); setMenuOpen(false); }}
                  >
                    New Chat
                  </button>
                </div>

                ${mode === "graded"
                  ? html`<div className="menu-tools">
                      <input
                        ref=${uploadRef}
                        className="hidden-upload"
                        type="file"
                        accept="application/pdf,text/plain,.pdf,.txt,.md"
                        onChange=${handleUploadPdf}
                      />
                      <button type="button" disabled=${busy || pdfBusy} onClick=${() => uploadRef.current?.click()}>Upload PDF</button>
                      <button type="button" disabled=${busy || pdfBusy || !documentMeta?.id} onClick=${makeGradedReader}>Abridge + Grade</button>
                      <button type="button" disabled=${busy || pdfBusy || !gradedPack} onClick=${downloadGradedPdf}>Download PDF</button>
                      ${documentMeta
                        ? html`<span className="doc-chip">${documentMeta.name}</span>`
                        : html`<span className="doc-chip muted">No document loaded</span>`}
                    </div>`
                  : null}
              </div>`
            : null}
        </div>

        <section className="chat-log" id="chatLog" aria-live="polite" ref=${chatLogRef}>
          ${messages.map((msg) => html`<${MessageBubble} key=${msg.id} msg=${msg} />`)}
        </section>

        <div className="quick-replies">
          ${activeQuickReplies.map(
            (text) => html`<button key=${text} type="button" disabled=${busy} onClick=${async () => {
              addUserMessage(text);
              await requestTutorTurn(text, false);
            }}>
              ${text}
            </button>`,
          )}
        </div>

        <form className="chat-form" onSubmit=${sendMessage}>
          <select
            className="composer-level"
            value=${level}
            onChange=${(e) => {
              const next = e.target.value;
              setLevel(next);
              const label = LEVELS.find((item) => item.value === next)?.label || "HSK 1";
              upsertScopedFact("Current level: ", label);
            }}
            disabled=${busy}
            aria-label="HSK level"
          >
            ${LEVELS.map((item) => html`<option key=${item.value} value=${item.value}>${item.label}</option>`)}
          </select>
          <input
            ref=${inputRef}
            value=${input}
            onChange=${(e) => setInput(e.target.value)}
            type="text"
            placeholder="Ask anything"
            autoComplete="off"
            disabled=${busy}
          />
          <button className="send-arrow" type="submit" disabled=${busy} aria-label="Send">➤</button>
        </form>
      </main>
      ${error ? html`<div className="floating-error">${error}</div>` : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
