const STORAGE_KEY = "crosstalk-study-v1";

const scenes = [
  { id: "food", name: "Noodles", hint: "restaurant", title: "我们吃面。", topic: "ordering noodles in a small restaurant" },
  { id: "home", name: "Home", hint: "daily life", title: "这是我的家。", topic: "a simple apartment and daily routine" },
  { id: "art", name: "Art", hint: "painting", title: "这张画很安静。", topic: "looking at a painting in a museum" },
  { id: "history", name: "History", hint: "neutral", title: "这是一个复杂的问题。", topic: "modern Chinese history in a neutral textbook style" },
];

const lexicon = {
  今天: "jin1 tian1",
  我们: "wo3 men",
  慢慢: "man4 man4",
  听: "ting1",
  中文: "Zhong1 wen2",
  你: "ni3",
  不用: "bu2 yong4",
  说: "shuo1",
  吃: "chi1",
  面: "mian4",
  很: "hen3",
  热: "re4",
  水: "shui3",
  不: "bu4",
  他: "ta1",
  要: "yao4",
  一点: "yi4 dian3",
  一碗: "yi4 wan3",
  可以: "ke3 yi3",
  吗: "ma",
  好: "hao3",
  再: "zai4",
  一遍: "yi2 bian4",
  这是: "zhe4 shi4",
  我的: "wo3 de",
  家: "jia1",
  家里: "jia1 li3",
  有: "you3",
  桌子: "zhuo1 zi",
  椅子: "yi3 zi",
  人: "ren2",
  多: "duo1",
  看: "kan4",
  这里: "zhe4 li3",
  安静: "an1 jing4",
  画: "hua4",
  颜色: "yan2 se4",
  可是: "ke3 shi4",
  好看: "hao3 kan4",
  有人说: "you3 ren2 shuo1",
  也有人说: "ye3 you3 ren2 shuo1",
  也: "ye3",
  历史: "li4 shi3",
  问题: "wen4 ti2",
  复杂: "fu4 za2",
  简单: "jian3 dan1",
  没关系: "mei2 guan1 xi",
  考试: "kao3 shi4",
  图片: "tu2 pian4",
  汉字: "han4 zi4",
};

const fallbackVocab = [
  { hanzi: "今天", pinyin: "jin1 tian1", english: "today" },
  { hanzi: "我们", pinyin: "wo3 men", english: "we" },
  { hanzi: "慢慢", pinyin: "man4 man4", english: "slowly" },
  { hanzi: "不用", pinyin: "bu2 yong4", english: "do not need to" },
];

const study = loadStudy();
const state = {
  scene: scenes[0],
  level: "hsk1",
  currentLesson: null,
  activeSavedId: null,
};

const sceneGrid = document.querySelector("#sceneGrid");
const levelSelect = document.querySelector("#levelSelect");
const topicInput = document.querySelector("#topicInput");
const lessonTitle = document.querySelector("#lessonTitle");
const lessonMode = document.querySelector("#lessonMode");
const lessonLines = document.querySelector("#lessonLines");
const vocabList = document.querySelector("#vocabList");
const checksList = document.querySelector("#checksList");
const chatLog = document.querySelector("#chatLog");
const packetView = document.querySelector("#packetView");
const packetContent = document.querySelector("#packetContent");
const libraryList = document.querySelector("#libraryList");
const notesInput = document.querySelector("#notesInput");
const savedCount = document.querySelector("#savedCount");
const reviewCount = document.querySelector("#reviewCount");
const studiedCount = document.querySelector("#studiedCount");

function loadStudy() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { lessons: [], studiedTotal: 0, ...saved };
  } catch {
    return { lessons: [], studiedTotal: 0 };
  }
}

function saveStudy() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(study));
  renderStats();
  renderLibrary();
}

function tokenizeChinese(text) {
  const keys = Object.keys(lexicon).sort((a, b) => b.length - a.length);
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);
    const punctuation = rest.match(/^[，。？！、：；]/);
    if (punctuation) {
      tokens.push({ hanzi: punctuation[0], pinyin: "" });
      index += punctuation[0].length;
      continue;
    }

    const space = rest.match(/^\s+/);
    if (space) {
      index += space[0].length;
      continue;
    }

    const match = keys.find((key) => rest.startsWith(key));
    if (match) {
      tokens.push({ hanzi: match, pinyin: lexicon[match] });
      index += match.length;
      continue;
    }

    const char = rest[0];
    tokens.push({ hanzi: char, pinyin: lexicon[char] || "" });
    index += 1;
  }

  return tokens;
}

function renderTokenLine(tokens) {
  const line = document.createElement("div");
  line.className = "interlinear-line";

  tokens.forEach((token) => {
    const hanzi = token.hanzi || token.text || "";
    const pinyin = token.pinyin || "";
    if (/^[，。？！、：；]$/.test(hanzi)) {
      const span = document.createElement("span");
      span.className = "punct";
      span.textContent = hanzi;
      line.append(span);
      return;
    }

    const ruby = document.createElement("ruby");
    ruby.className = "word";
    ruby.textContent = hanzi;
    const rt = document.createElement("rt");
    rt.textContent = pinyin;
    ruby.append(rt);
    line.append(ruby);
  });

  return line;
}

function renderInterlinear(text) {
  return renderTokenLine(tokenizeChinese(text));
}

function fallbackLesson() {
  const topic = topicInput.value.trim();
  const scene = state.scene;
  const plainLines = [
    "今天我们慢慢听中文。",
    "你不用说中文。",
    scene.id === "food" ? "今天我们吃面。" : scene.id === "home" ? "这是我的家。" : scene.id === "art" ? "这张画很安静。" : "这是一个复杂的问题。",
    scene.id === "food" ? "面很热，水不热。" : scene.id === "home" ? "家里有桌子，也有椅子。" : scene.id === "art" ? "颜色不多，可是很好看。" : "有人说这样，也有人说那样。",
    topic ? "你的题目有一点难，我们说简单一点。" : "很好，很简单。",
    "可以吗？很好。我们再听一遍。",
  ];

  return {
    id: crypto.randomUUID(),
    title: scene.title,
    mode: state.level === "hsk1" ? "HSK 1 · 离线模板" : "HSK 2 · 离线模板",
    scene: scene.name,
    createdAt: new Date().toISOString(),
    source: "offline",
    plainLines,
    lines: plainLines.map((line) => ({ tokens: tokenizeChinese(line) })),
    vocab: fallbackVocab,
    checks: ["这句话容易吗？", "你可以用英文回答，也可以不回答。"],
    chat: ["很好。我们不考试。", "你只要听，看图片，看汉字。", "不懂也没关系。"],
    grammar: ["不用 = do not need to.", "也 = also."],
  };
}

async function generateLesson() {
  state.level = levelSelect.value;
  setBusy(true);

  try {
    const response = await fetch("/api/lesson", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: topicInput.value,
        scene: state.scene.topic,
        level: state.level,
      }),
    });

    if (!response.ok) throw new Error((await response.json()).error || "AI request failed.");
    const lesson = await response.json();
    showLesson(lesson);
    addTutorNotice("AI lesson made with DeepSeek. Save it when it is useful.");
  } catch (error) {
    const lesson = fallbackLesson();
    showLesson(lesson);
    addTutorNotice("AI is not connected here, so I used the offline template. Deploy with DEEPSEEK_API_KEY to turn on generation.");
  } finally {
    setBusy(false);
  }
}

function showLesson(lesson) {
  state.currentLesson = normalizeClientLesson(lesson);
  state.activeSavedId = null;
  notesInput.value = "";
  lessonTitle.textContent = state.currentLesson.title;
  lessonMode.textContent = state.currentLesson.mode;
  lessonLines.replaceChildren(...state.currentLesson.lines.map((line) => renderTokenLine(line.tokens)));
  renderVocab();
  renderChecks();
  renderChat("new");
  renderPacket();
}

function normalizeClientLesson(lesson) {
  const plainLines = lesson.plainLines?.length
    ? lesson.plainLines
    : lesson.lines.map((line) => line.tokens.map((token) => token.hanzi || "").join(""));

  return {
    ...lesson,
    id: lesson.id || crypto.randomUUID(),
    createdAt: lesson.createdAt || new Date().toISOString(),
    plainLines,
    lines: lesson.lines?.length ? lesson.lines : plainLines.map((line) => ({ tokens: tokenizeChinese(line) })),
    vocab: lesson.vocab?.length ? lesson.vocab : fallbackVocab,
    checks: lesson.checks?.length ? lesson.checks : ["容易吗？"],
    chat: lesson.chat?.length ? lesson.chat : ["很好。慢慢听。"],
    grammar: lesson.grammar?.length ? lesson.grammar : [],
    source: lesson.source || "deepseek",
  };
}

function renderVocab() {
  vocabList.replaceChildren(
    ...state.currentLesson.vocab.slice(0, 8).map((item) => {
      const row = document.createElement("div");
      row.className = "vocab-item";
      row.innerHTML = `<strong>${escapeHtml(item.hanzi)}</strong><div><span>${escapeHtml(item.pinyin || "")}</span><br>${escapeHtml(item.english || "")}</div>`;
      return row;
    }),
  );
}

function renderChecks() {
  checksList.replaceChildren(
    ...state.currentLesson.checks.map((check) => {
      const item = document.createElement("div");
      item.className = "check-card";
      item.append(renderInterlinear(check));
      return item;
    }),
  );
}

function renderChat(mode) {
  const fallback = {
    yes: ["太好了。我们再慢慢听。", "这个故事很短，也很清楚。"],
    more: ["比如：他要水。他不要茶。", "再比如：这张画很大，颜色不多。"],
    easy: ["好，我们说短一点。", "这是面。面很热。他吃面。"],
  };

  if (mode === "new") {
    chatLog.replaceChildren();
    state.currentLesson.chat.forEach(addTutorMessage);
    return;
  }

  const learner = document.createElement("div");
  learner.className = "message learner";
  learner.textContent = mode === "yes" ? "I understand" : mode === "more" ? "More examples" : "Make it easier";
  chatLog.append(learner);
  fallback[mode].forEach(addTutorMessage);
}

function addTutorMessage(text) {
  const msg = document.createElement("div");
  msg.className = "message tutor";
  msg.append(renderInterlinear(text));
  chatLog.append(msg);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addTutorNotice(text) {
  const msg = document.createElement("div");
  msg.className = "message tutor notice";
  msg.textContent = text;
  chatLog.append(msg);
}

function renderPacket() {
  const sections = [
    { title: "简单汉字版", lines: state.currentLesson.plainLines, interlinear: false },
    { title: "拼音 + 汉字版", lines: state.currentLesson.lines, interlinear: true },
    { title: "生词", lines: state.currentLesson.vocab.map((v) => `${v.hanzi}  ${v.pinyin || ""}  ${v.english || ""}`), interlinear: false },
    { title: "语法小点", lines: state.currentLesson.grammar, interlinear: false },
    { title: "小问题", lines: state.currentLesson.checks, interlinear: false },
  ];

  packetContent.replaceChildren(
    ...sections.map((section) => {
      const el = document.createElement("section");
      el.className = "packet-section";
      const h3 = document.createElement("h3");
      h3.textContent = section.title;
      el.append(h3);

      section.lines.forEach((line) => {
        if (section.interlinear) {
          el.append(renderTokenLine(line.tokens));
        } else {
          const p = document.createElement("p");
          p.className = "packet-plain";
          p.textContent = typeof line === "string" ? line : "";
          el.append(p);
        }
      });

      return el;
    }),
  );
}

function saveCurrentLesson() {
  const existingIndex = study.lessons.findIndex((lesson) => lesson.id === state.activeSavedId);
  const saved = {
    ...state.currentLesson,
    id: state.activeSavedId || state.currentLesson.id || crypto.randomUUID(),
    notes: notesInput.value.trim(),
    savedAt: new Date().toISOString(),
    studiedCount: existingIndex >= 0 ? study.lessons[existingIndex].studiedCount : 0,
    nextReviewAt: existingIndex >= 0 ? study.lessons[existingIndex].nextReviewAt : new Date().toISOString(),
  };

  if (existingIndex >= 0) study.lessons[existingIndex] = saved;
  else study.lessons.unshift(saved);

  state.activeSavedId = saved.id;
  saveStudy();
  addTutorNotice("Saved. It will stay in this browser.");
}

function markStudied() {
  saveCurrentLesson();
  const lesson = study.lessons.find((item) => item.id === state.activeSavedId);
  if (!lesson) return;

  lesson.studiedCount = (lesson.studiedCount || 0) + 1;
  lesson.lastStudiedAt = new Date().toISOString();
  lesson.nextReviewAt = nextReviewDate(lesson.studiedCount);
  study.studiedTotal = (study.studiedTotal || 0) + 1;
  saveStudy();
  addTutorNotice("Marked studied. This lesson moved forward in the review queue.");
}

function nextReviewDate(count) {
  const days = count <= 1 ? 1 : count === 2 ? 3 : count === 3 ? 7 : 14;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function renderLibrary() {
  if (!study.lessons.length) {
    libraryList.innerHTML = `<p class="empty-state">No saved lessons yet. Generate a lesson, then press Save or Done.</p>`;
    return;
  }

  libraryList.replaceChildren(
    ...study.lessons.map((lesson) => {
      const card = document.createElement("div");
      card.className = "lesson-item";
      const due = new Date(lesson.nextReviewAt || lesson.savedAt) <= new Date();
      card.innerHTML = `
        <strong>${escapeHtml(lesson.title)}</strong>
        <div class="lesson-meta">${escapeHtml(lesson.source || "lesson")} · studied ${lesson.studiedCount || 0} · ${due ? "due now" : `review ${formatDate(lesson.nextReviewAt)}`}</div>
        <div class="lesson-actions">
          <button type="button" data-action="load">Load</button>
          <button type="button" data-action="done">Done</button>
          <button type="button" data-action="delete">Delete</button>
        </div>
      `;

      card.querySelector('[data-action="load"]').addEventListener("click", () => loadSavedLesson(lesson.id));
      card.querySelector('[data-action="done"]').addEventListener("click", () => {
        loadSavedLesson(lesson.id);
        markStudied();
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteLesson(lesson.id));
      return card;
    }),
  );
}

function renderStats() {
  const now = new Date();
  savedCount.textContent = study.lessons.length;
  reviewCount.textContent = study.lessons.filter((lesson) => new Date(lesson.nextReviewAt || lesson.savedAt) <= now).length;
  studiedCount.textContent = study.studiedTotal || 0;
}

function loadSavedLesson(id) {
  const lesson = study.lessons.find((item) => item.id === id);
  if (!lesson) return;
  state.activeSavedId = id;
  state.currentLesson = normalizeClientLesson(lesson);
  notesInput.value = lesson.notes || "";
  lessonTitle.textContent = state.currentLesson.title;
  lessonMode.textContent = `${state.currentLesson.mode} · saved`;
  lessonLines.replaceChildren(...state.currentLesson.lines.map((line) => renderTokenLine(line.tokens)));
  renderVocab();
  renderChecks();
  renderChat("new");
  renderPacket();
}

function deleteLesson(id) {
  study.lessons = study.lessons.filter((lesson) => lesson.id !== id);
  if (state.activeSavedId === id) state.activeSavedId = null;
  saveStudy();
}

function exportData() {
  const blob = new Blob([JSON.stringify(study, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `crosstalk-study-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  const imported = JSON.parse(await file.text());
  study.lessons = Array.isArray(imported.lessons) ? imported.lessons : study.lessons;
  study.studiedTotal = Number(imported.studiedTotal || study.studiedTotal || 0);
  saveStudy();
}

function copyPlainLesson() {
  navigator.clipboard?.writeText(state.currentLesson.plainLines.join("\n"));
}

function setBusy(isBusy) {
  const btn = document.querySelector("#makeLessonBtn");
  btn.disabled = isBusy;
  btn.textContent = isBusy ? "Making..." : "Make Lesson";
}

function formatDate(value) {
  if (!value) return "soon";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

function initScenes() {
  sceneGrid.replaceChildren(
    ...scenes.map((scene) => {
      const button = document.createElement("button");
      button.className = `scene-button${scene.id === state.scene.id ? " active" : ""}`;
      button.type = "button";
      button.innerHTML = `<strong>${scene.name}</strong><span>${scene.hint}</span>`;
      button.addEventListener("click", () => {
        state.scene = scene;
        document.querySelectorAll(".scene-button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        generateLesson();
      });
      return button;
    }),
  );
}

document.querySelector("#makeLessonBtn").addEventListener("click", generateLesson);
document.querySelector("#clearBtn").addEventListener("click", () => {
  topicInput.value = "";
  generateLesson();
});
document.querySelector("#saveBtn").addEventListener("click", saveCurrentLesson);
document.querySelector("#studiedBtn").addEventListener("click", markStudied);
document.querySelector("#packetBtn").addEventListener("click", () => {
  packetView.classList.add("open");
  packetView.setAttribute("aria-hidden", "false");
});
document.querySelector("#closePacketBtn").addEventListener("click", () => {
  packetView.classList.remove("open");
  packetView.setAttribute("aria-hidden", "true");
});
document.querySelector("#printBtn").addEventListener("click", () => window.print());
document.querySelector("#copyBtn").addEventListener("click", copyPlainLesson);
document.querySelector("#slowBtn").addEventListener("click", () => {
  levelSelect.value = "hsk1";
  generateLesson();
});
document.querySelector("#exportBtn").addEventListener("click", exportData);
document.querySelector("#importInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (file) importData(file);
});
notesInput.addEventListener("input", () => {
  if (!state.activeSavedId) return;
  const lesson = study.lessons.find((item) => item.id === state.activeSavedId);
  if (!lesson) return;
  lesson.notes = notesInput.value;
  saveStudy();
});
document.querySelectorAll(".reply-bar button").forEach((button) => {
  button.addEventListener("click", () => renderChat(button.dataset.reply));
});

initScenes();
showLesson(fallbackLesson());
renderStats();
renderLibrary();
