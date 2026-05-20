import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.DEEPSEEK_API_KEY),
    model,
  });
});

app.post("/api/lesson", async (req, res) => {
  try {
    if (!process.env.DEEPSEEK_API_KEY) {
      return res.status(503).json({
        error: "DeepSeek API key is not configured on the server.",
      });
    }

    const topic = cleanText(req.body.topic || "");
    const scene = cleanText(req.body.scene || "daily life");
    const level = req.body.level === "hsk2" ? "HSK 2" : "HSK 1";

    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 1800,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You create Mandarin comprehensible-input lessons for English-speaking beginners.",
              "Use Simplified Chinese and Mainland Mandarin vocabulary.",
              "Do not require the learner to produce Chinese.",
              "Keep Chinese around HSK 1-2: short lines, concrete context, repetition, natural phrasing.",
              "For politics, Marxism, art, literature, Mao Zedong, and modern Chinese history, use a neutral casual textbook style.",
              "Respect copyright: summarize or simplify difficult text instead of reproducing long passages.",
              "Return only valid JSON.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create one crosstalk-style beginner Mandarin study lesson.",
              level,
              scene,
              learnerTopicOrText: topic || scene,
              schema: {
                title: "Chinese title, short",
                mode: "short Chinese label",
                lines: [
                  {
                    tokens: [
                      { hanzi: "今天", pinyin: "jin1 tian1" },
                      { hanzi: "。", pinyin: "" }
                    ]
                  }
                ],
                plainLines: ["Chinese lines without pinyin"],
                vocab: [
                  { hanzi: "今天", pinyin: "jin1 tian1", english: "today" }
                ],
                checks: ["simple Chinese comprehension questions"],
                chat: ["2-3 encouraging Chinese tutor messages"],
                grammar: ["1-2 short English grammar notes"]
              },
              constraints: [
                "Use numbered pinyin like ni3 hao3, not tone marks, so the app can display it reliably.",
                "Group multi-character words together.",
                "Use 7-9 short lesson lines.",
                "Include pinyin for every Chinese word or phrase token whenever possible.",
                "Keep punctuation as separate tokens with empty pinyin.",
              ],
            }),
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({
        error: payload?.error?.message || "DeepSeek request failed.",
      });
    }

    const content = payload?.choices?.[0]?.message?.content;
    const lesson = JSON.parse(content);
    res.json(normalizeLesson(lesson, { scene, level }));
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
});

function cleanText(value) {
  return String(value).replace(/\s+/g, " ").trim().slice(0, 5000);
}

function normalizeLesson(lesson, context) {
  return {
    id: randomUUID(),
    title: String(lesson.title || "今天我们慢慢听。"),
    mode: String(lesson.mode || context.level),
    scene: context.scene,
    createdAt: new Date().toISOString(),
    lines: Array.isArray(lesson.lines) ? lesson.lines : [],
    plainLines: Array.isArray(lesson.plainLines) ? lesson.plainLines : [],
    vocab: Array.isArray(lesson.vocab) ? lesson.vocab.slice(0, 10) : [],
    checks: Array.isArray(lesson.checks) ? lesson.checks.slice(0, 5) : [],
    chat: Array.isArray(lesson.chat) ? lesson.chat.slice(0, 5) : [],
    grammar: Array.isArray(lesson.grammar) ? lesson.grammar.slice(0, 4) : [],
    source: "deepseek",
  };
}

app.listen(port, () => {
  console.log(`Crosstalk tutor running on http://localhost:${port}`);
});
