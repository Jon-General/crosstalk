import React, { useEffect, useMemo, useRef, useState } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(React.createElement);
const MEMORY_KEY = "crosstalk-session-memory-v2";

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

function extractSeedUrls(text) {
  const seen = new Set();
  const urls = [];
  for (const match of String(text || "").matchAll(/https?:\/\/[^\s)\]}>"']+/gi)) {
    const url = match[0].replace(/[.,;!?]+$/, "");
    if (url && !seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls.slice(0, 4);
}

function App() {
  const [tab, setTab] = useState("chat");
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
      return saved.filter((fact) => !/^Current level:/i.test(String(fact))).slice(-28);
    } catch {
      return [];
    }
  });

  const [busy, setBusy] = useState(false);

  const [docMeta, setDocMeta] = useState(null);
  const [docBusy, setDocBusy] = useState(false);
  const [gradedStage, setGradedStage] = useState("");
  const [pinyinStage, setPinyinStage] = useState("");
  const [gradedStageStartedAt, setGradedStageStartedAt] = useState(0);
  const [pinyinStageStartedAt, setPinyinStageStartedAt] = useState(0);
  const [tick, setTick] = useState(0);
  const [bookPack, setBookPack] = useState(null);
  const [bookPdfLink, setBookPdfLink] = useState("");
  const [bookPdfName, setBookPdfName] = useState("");
  const [pinyinPdfLink, setPinyinPdfLink] = useState("");
  const [pinyinPdfName, setPinyinPdfName] = useState("");

  const chatLogRef = useRef(null);
  const inputRef = useRef(null);
  const gradedUploadRef = useRef(null);
  const pinyinUploadRef = useRef(null);
  const activeGradedFileRef = useRef(null);

  const createdFileUrlsRef = useRef([]);
  const hskLabel = useMemo(() => LEVELS.find((x) => x.value === level)?.label || "HSK 1", [level]);

  useEffect(() => {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory.slice(-28)));
  }, [memory]);

  useEffect(() => {
    return () => {
      createdFileUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      createdFileUrlsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!gradedStage && !pinyinStage) return;
    const timer = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(timer);
  }, [gradedStage, pinyinStage]);

  function trackBlobUrl(url) {
    createdFileUrlsRef.current.push(url);
  }

  function parseDownloadName(response, fallback) {
    const disposition = response.headers.get("content-disposition") || "";
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) return decodeURIComponent(utf8Match[1]).trim();
    const nameMatch = disposition.match(/filename="?([^";]+)"?/i);
    if (nameMatch?.[1]) return nameMatch[1].trim();
    return fallback;
  }

  function startGradedStage(stage) {
    setGradedStage(stage);
    setGradedStageStartedAt(Date.now());
  }

  function stopGradedStage() {
    setGradedStage("");
    setGradedStageStartedAt(0);
  }

  function startPinyinStage(stage) {
    setPinyinStage(stage);
    setPinyinStageStartedAt(Date.now());
  }

  function stopPinyinStage() {
    setPinyinStage("");
    setPinyinStageStartedAt(0);
  }

  function elapsedSeconds(startedAt) {
    if (!startedAt) return 0;
    return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  }

  function gradedStageLabel(stage) {
    if (stage === "uploading") return "Uploading file";
    if (stage === "generating") return "Generating reader chapters";
    if (stage === "building") return "Building reader PDF";
    return "Processing";
  }

  function pinyinStageLabel(stage) {
    if (stage === "converting") return "Converting to Hanzi + Pinyin PDF";
    return "Processing";
  }

  function scrollToBottomSoon() {
    requestAnimationFrame(() => {
      if (chatLogRef.current) {
        chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
      }
    });
  }

  function addUserMessage(text) {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", text }]);
    scrollToBottomSoon();
  }

  function addNotice(text) {
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), type: "notice", text }]);
    scrollToBottomSoon();
  }

  function upsertScopedFact(prefix, value) {
    const cleanValue = String(value || "").trim();
    if (!cleanValue) return;
    const scoped = `${prefix}${cleanValue}`;
    setMemory((prev) => {
      const next = prev.filter((fact) => !String(fact).startsWith(prefix));
      next.push(scoped);
      return next.slice(-28);
    });
  }

  function extractMemoryFromUserMessage(text) {
    const src = String(text || "").trim();
    if (!src) return [];
    const facts = [];

    const remember = src.match(/remember(?:\s+that)?\s+(.+)$/i);
    if (remember?.[1]) facts.push(`User says to remember: ${remember[1].trim()}`);

    const name = src.match(/\bmy name is\s+([a-z][a-z\s'-]{1,40})/i);
    if (name?.[1]) facts.push(`User name: ${name[1].trim()}`);

    const goal = src.match(/\b(my goal is|i want to|i need to)\s+(.+)$/i);
    if (goal?.[2]) facts.push(`User goal: ${goal[2].trim()}`);

    const preference = src.match(/\b(i like|i prefer|i enjoy|i dislike|i hate)\s+(.+)$/i);
    if (preference?.[2]) facts.push(`User preference: ${preference[2].trim()}`);

    const urls = extractSeedUrls(src);
    if (urls.length) facts.push(`User shared links: ${urls.join(" | ")}`);

    if (src.length > 10 && src.length <= 140 && facts.length === 0) {
      facts.push(`Recent user note: ${src}`);
    }

    return facts.slice(0, 5);
  }

  function deriveRecentIntentFacts(nextHistory) {
    const recents = nextHistory
      .filter((item) => item.role === "user")
      .slice(-6)
      .map((item) => String(item.content || "").trim())
      .filter(Boolean)
      .slice(-3);
    return recents.map((line) => `Recent user intent: ${line.slice(0, 140)}`);
  }

  function toHistoryPayload(nextHistory) {
    return nextHistory.slice(-60).map((item) => ({ role: item.role, content: item.content }));
  }

  function clearChat() {
    setHistory([]);
    setMemory([]);
    setError("");
    setMessages([
      { id: crypto.randomUUID(), type: "notice", text: "New session started." },
      { id: crypto.randomUUID(), type: "notice", text: "Chat ready." },
    ]);
  }

  async function requestTutorTurn(userMessage) {
    setBusy(true);
    setError("");

    const pendingId = crypto.randomUUID();
    setMessages((prev) => [...prev, { id: pendingId, role: "assistant", pending: true, text: "" }]);

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
        return next.slice(-28);
      });
    }

    const levelFact = `Current level: ${hskLabel}`;
    const stableMemory = memory.filter((fact) => !String(fact).startsWith("Current level:"));
    const recentIntentFacts = deriveRecentIntentFacts(nextHistory || []);
    const memoryPayload = [...stableMemory, ...recentIntentFacts, levelFact, ...extracted].slice(-28);

    const webTrigger = /^\s*\/web\b|search:|\b(search web|web search|look up|find online|browse web|check online|open link|follow link|read this link|check this link)\b/i;
    const seedUrls = extractSeedUrls(userMessage);
    const webEnabled = webTrigger.test(userMessage) || seedUrls.length > 0;

    try {
      const response = await fetch("/api/tutor-turn-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level,
          topic: "current chat",
          makeLessonMode: false,
          message: userMessage,
          history: toHistoryPayload(nextHistory || []),
          memory: memoryPayload,
          web: { enabled: webEnabled, followDepth: 2, seedUrls },
        }),
      });

      if (!response.ok) {
        const raw = await response.text();
        const payload = raw ? JSON.parse(raw) : {};
        throw new Error(payload?.error || "AI request failed.");
      }

      if (!response.body) throw new Error("Model stream not available.");

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

          if (event.type === "error") throw new Error(event.error || "Streaming failed.");
          if (event.type === "done") finalReply = event.reply;
        }
      }

      const lines = normalizeLines(finalReply?.reply?.lines || []);
      if (!lines.length) throw new Error("Model response did not include usable lesson lines.");

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
    await requestTutorTurn(text);
  }

  async function handleGradedUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    activeGradedFileRef.current = file;
    setDocBusy(true);
    startGradedStage("uploading");
    setError("");
    setBookPack(null);
    setBookPdfLink("");
    setBookPdfName("");

    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/pdf/extract", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "Failed to extract PDF.");
      setDocMeta(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to upload document.";
      setError(message);
    } finally {
      setDocBusy(false);
      stopGradedStage();
      event.target.value = "";
    }
  }

  async function generateWholeBookReader() {
    if (!docMeta?.id || docBusy) return;
    setDocBusy(true);
    startGradedStage("generating");
    setError("");
    setBookPack(null);
    setBookPdfLink("");
    setBookPdfName("");

    try {
      const response = await fetch("/api/pdf/graded-reader-book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: docMeta.id,
          level,
          objective: "produce a full-length graded reader from this book; process chapter-by-chapter if needed",
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.detail || payload?.error || "Failed to build graded reader.");
      setBookPack(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to build graded reader.";
      setError(message);
    } finally {
      setDocBusy(false);
      stopGradedStage();
    }
  }

  async function buildBookPdfLink() {
    if (!bookPack || docBusy) return;
    setDocBusy(true);
    startGradedStage("building");
    setError("");

    try {
      const response = await fetch("/api/pdf/graded-reader-book-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bookPack),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || payload?.error || "Failed to generate reader PDF.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const fallback = `${(bookPack.title || "graded-reader-book").replace(/[^a-z0-9_-]+/gi, "-")}.pdf`;
      const name = parseDownloadName(response, fallback);
      trackBlobUrl(url);
      setBookPdfLink(url);
      setBookPdfName(name);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to generate reader PDF.";
      setError(message);
    } finally {
      setDocBusy(false);
      stopGradedStage();
    }
  }

  async function handlePinyinUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setDocBusy(true);
    startPinyinStage("converting");
    setError("");
    setPinyinPdfLink("");
    setPinyinPdfName("");

    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/pdf/hanzi-pinyin", { method: "POST", body: form });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.detail || payload?.error || "Failed to generate Hanzi+Pinyin PDF.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const fallback = file.name.replace(/\.[^.]+$/, "") + "-pinyin.pdf";
      const name = parseDownloadName(response, fallback);
      trackBlobUrl(url);
      setPinyinPdfLink(url);
      setPinyinPdfName(name);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to generate Hanzi+Pinyin PDF.";
      setError(message);
    } finally {
      setDocBusy(false);
      stopPinyinStage();
      event.target.value = "";
    }
  }

  return html`
    <div className="app-shell">
      <main className="chat-shell" aria-label="Tutor app">
        <div className="chat-header">
          <span className="chat-header-title">crosstalk</span>
          <div className="top-tabs" role="tablist" aria-label="App tabs">
            <button type="button" className=${`tab-btn ${tab === "chat" ? "active" : ""}`} onClick=${() => setTab("chat")}>Tutor Chat</button>
            <button type="button" className=${`tab-btn ${tab === "studio" ? "active" : ""}`} onClick=${() => setTab("studio")}>PDF Studio</button>
          </div>
        </div>

        ${tab === "chat"
          ? html`
              <section className="chat-log" id="chatLog" aria-live="polite" ref=${chatLogRef}>
                ${messages.map((msg) => html`<${MessageBubble} key=${msg.id} msg=${msg} />`)}
              </section>

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
            `
          : html`
              <section className="studio-pane" aria-live="polite">
                <article className="studio-card">
                  <h3>Whole-Book Graded Reader</h3>
                  <p className="studio-note">Upload one PDF, then generate a long graded reader. The backend will process chapter-by-chapter when the full book is too large for one context window.</p>

                  <input ref=${gradedUploadRef} className="hidden-upload" type="file" accept="application/pdf,text/plain,.pdf,.txt,.md" onChange=${handleGradedUpload} />
                  <div className="studio-actions">
                    <button type="button" disabled=${docBusy} onClick=${() => gradedUploadRef.current?.click()}>
                      ${gradedStage === "uploading" ? "Uploading..." : "Upload Book PDF"}
                    </button>
                    <button type="button" disabled=${docBusy || !docMeta?.id} onClick=${generateWholeBookReader}>
                      ${gradedStage === "generating" ? "Generating..." : "Generate Reader"}
                    </button>
                    <button type="button" disabled=${docBusy || !bookPack} onClick=${buildBookPdfLink}>
                      ${gradedStage === "building" ? "Building..." : "Build Reader PDF"}
                    </button>
                  </div>

                  ${gradedStage
                    ? html`<div className="studio-progress" key=${tick}>
                        <span className="spinner"></span>
                        <span>${gradedStageLabel(gradedStage)} · ${elapsedSeconds(gradedStageStartedAt)}s</span>
                      </div>`
                    : null}

                  ${docMeta
                    ? html`<p className="studio-meta">Loaded: ${docMeta.name} · ${docMeta.pages || 0} pages · ${docMeta.chars} chars</p>`
                    : html`<p className="studio-meta muted">No document uploaded yet.</p>`}

                  ${bookPack
                    ? html`<div className="studio-result">
                        <p><strong>${bookPack.title}</strong> (${bookPack.level})</p>
                        <p>Sections: ${bookPack.sections?.length || 0}${bookPack.truncated ? " (truncated for API safety)" : ""}</p>
                        <ul>
                          ${(bookPack.sections || []).slice(0, 12).map((section, idx) => html`<li key=${idx}>${section.title || `Section ${idx + 1}`}</li>`)}
                        </ul>
                      </div>`
                    : null}

                  ${bookPdfLink
                    ? html`<p className="studio-link-wrap"><a className="file-link" href=${bookPdfLink} download=${bookPdfName} target="_blank" rel="noopener noreferrer">${bookPdfName || "Download graded-reader PDF"}</a></p>`
                    : null}
                </article>

                <article className="studio-card">
                  <h3>Add Pinyin to PDF</h3>
                  <p className="studio-note">Upload a PDF and generate a Hanzi+Pinyin version with line-by-line interlinear output.</p>

                  <input ref=${pinyinUploadRef} className="hidden-upload" type="file" accept="application/pdf" onChange=${handlePinyinUpload} />
                  <div className="studio-actions">
                    <button type="button" disabled=${docBusy} onClick=${() => pinyinUploadRef.current?.click()}>
                      ${pinyinStage === "converting" ? "Converting..." : "Upload and Convert"}
                    </button>
                  </div>

                  ${pinyinStage
                    ? html`<div className="studio-progress" key=${tick + 1}>
                        <span className="spinner"></span>
                        <span>${pinyinStageLabel(pinyinStage)} · ${elapsedSeconds(pinyinStageStartedAt)}s</span>
                      </div>`
                    : null}

                  ${pinyinPdfLink
                    ? html`<p className="studio-link-wrap"><a className="file-link" href=${pinyinPdfLink} download=${pinyinPdfName} target="_blank" rel="noopener noreferrer">${pinyinPdfName || "Download Hanzi+Pinyin PDF"}</a></p>`
                    : html`<p className="studio-meta muted">No converted file yet.</p>`}
                </article>
              </section>
            `}
      </main>

      ${error ? html`<div className="floating-error">${error}</div>` : null}
    </div>
  `;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
