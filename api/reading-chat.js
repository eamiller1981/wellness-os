// Reading AI chat endpoint.
// Tries Google Gemini 2.0 Flash first (free tier).
// Falls back to OpenAI if configured.
// Falls back to Anthropic Claude Sonnet if Gemini fails or is missing.
// Both keys are env vars — never sent to the browser.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const OPENAI_URL = "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-nano";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
const MAX_OUTPUT_TOKENS = 2048;
const PROVIDER_TIMEOUT_MS = 25000;

const SYSTEM_BASE = `You are the Reading AI for the Wellness OS Reading module. You help the user log, rate, and refine recommendations for psychological/paranormal horror books.

CRITICAL RULES — never break these:
1. SPOILER-FREE. Never include plot specifics, twists, character fates, endings, or specific events. The user loves going into books cold and being surprised. Only describe: tone, atmosphere, setting type (house, cabin, isolated, etc.), cast size, POV structure (single/dual/ensemble), thematic territory (grief, identity, isolation, etc.), and comparisons to her anchors.
2. Use her rating language: LOVED (5), VERY GOOD (4–4.5), OKAY (3–3.5), NOT GOOD (2–2.5), SO BAD I DNF (1–1.5).
3. When she shares a new rating with notes, propose specific updates to her taste profile and explain what the rating signals.
4. When she asks for recommendations, surface her existing TBR FIRST (ranked by likelihood of LOVED). Only suggest new books if she explicitly asks for new ones.
5. When she pastes a list of books, classify each as ADD / MAYBE / SKIP with a one-sentence spoiler-free reason rooted in her taste profile.
6. Keep "why it fits" blurbs to one sentence. No spoilers.
7. Format concisely. Use her direct, no-fluff tone.

Her current taste profile and book log are below. Treat them as the source of truth.`;

function buildSystemPrompt(context) {
  if (!context) return SYSTEM_BASE;
  return `${SYSTEM_BASE}\n\n--- CURRENT CONTEXT ---\n${context}`;
}

async function fetchWithTimeout(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(PROVIDER_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(systemPrompt, messages, apiKey) {
  const url = `${GEMINI_URL}?key=${encodeURIComponent(apiKey)}`;
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content || "") }]
  }));
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: MAX_OUTPUT_TOKENS
    }
  };
  const r = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }, "Gemini");
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Gemini ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

async function callClaude(systemPrompt, messages, apiKey) {
  const r = await fetchWithTimeout(CLAUDE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "")
      }))
    })
  }, "Claude");
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Claude ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  const text = j?.content?.[0]?.text;
  if (!text) throw new Error("Claude returned no text");
  return text;
}

async function callOpenAI(systemPrompt, messages, apiKey) {
  const input = [
    { role: "system", content: systemPrompt },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "")
    }))
  ];

  const r = await fetchWithTimeout(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.7
    })
  }, "OpenAI");

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`OpenAI ${r.status}: ${text.slice(0, 200)}`);
  }

  const j = await r.json();
  const text =
    j.output_text ||
    j?.output?.flatMap((item) => item.content || [])
      .map((part) => part.text || "")
      .join("")
      .trim();
  if (!text) throw new Error("OpenAI returned no text");
  return text;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { messages, context } = request.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    response.status(400).json({ error: "messages required" });
    return;
  }

  const systemPrompt = buildSystemPrompt(context);
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const claudeKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !openaiKey && !claudeKey) {
    response.status(500).json({
      error:
        "No AI provider configured. Set GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY in Vercel env vars."
    });
    return;
  }

  const errors = [];

  if (geminiKey) {
    try {
      const reply = await callGemini(systemPrompt, messages, geminiKey);
      response.status(200).json({ response: reply, model: GEMINI_MODEL });
      return;
    } catch (err) {
      errors.push(`gemini: ${err.message}`);
    }
  }

  if (openaiKey) {
    try {
      const reply = await callOpenAI(systemPrompt, messages, openaiKey);
      response.status(200).json({ response: reply, model: OPENAI_MODEL });
      return;
    } catch (err) {
      errors.push(`openai: ${err.message}`);
    }
  }

  if (claudeKey) {
    try {
      const reply = await callClaude(systemPrompt, messages, claudeKey);
      response.status(200).json({ response: reply, model: CLAUDE_MODEL });
      return;
    } catch (err) {
      errors.push(`claude: ${err.message}`);
    }
  }

  response.status(502).json({
    error: "All AI providers failed",
    details: errors
  });
}
