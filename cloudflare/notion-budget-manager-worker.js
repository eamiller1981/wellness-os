import { authorizePersonalRequest } from "./personal-auth.js";

const NOTION_API = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2022-06-28";

const BOOKS_DB_ID = "f75e04e67a7047408a6448f8879f0c29";
const AI_QUEUE_DB_ID = "42510040d9284f8387307edf056fae72";

const ALLOWED_ORIGINS = new Set([
  "https://eamiller1981.github.io",
  "https://wellness-os-eamiller1981-eamiller1981-3240s-projects.vercel.app",
  "https://wellness-os-eamiller1981-3240-eamiller1981-3240s-projects.vercel.app",
  "https://wellness-os.vercel.app",
  "https://wellness-os-psi.vercel.app",
  "https://liz-wellness-os.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
]);

const WELLNESS_PREVIEW_ORIGIN =
  /^https:\/\/wellness-[a-z0-9-]+-eamiller1981-3240s-projects\.vercel\.app$/;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}

function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin) || WELLNESS_PREVIEW_ORIGIN.test(origin);
}

function jsonResponse(body, status, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? corsHeaders(origin) : {})
    }
  });
}

function richTextChunks(text) {
  const value = String(text || "");
  if (!value) return [];
  const chunks = [];
  for (let i = 0; i < value.length; i += 1900) {
    chunks.push({ type: "text", text: { content: value.slice(i, i + 1900) } });
  }
  return chunks;
}

function plain(richTextArr) {
  if (!Array.isArray(richTextArr)) return "";
  return richTextArr.map(t => t.plain_text || "").join("");
}

async function notionFetch(env, path, method = "GET", body = null) {
  const response = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${env.NOTION_TOKEN}`,
      "Content-Type": "application/json",
      "Notion-Version": DEFAULT_NOTION_VERSION
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body || {})
  });

  const text = await response.text();
  const data = parseJsonSafe(text);
  if (!response.ok) {
    throw new Error(`Notion ${method} ${path} ${response.status}: ${text.slice(0, 220)}`);
  }
  return data;
}

function mapQueuePage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    task: plain(p.Task?.title) || "(untitled)",
    taskType: p["Task Type"]?.select?.name || "",
    status: p.Status?.select?.name || "",
    source: p.Source?.select?.name || "",
    created: p.Created?.date?.start || "",
    contextSnapshot: plain(p["Context Snapshot"]?.rich_text),
    outputSummary: plain(p["Output Summary"]?.rich_text),
    trace: plain(p.Trace?.rich_text),
    triggerBookIds: (p["Trigger Book"]?.relation || []).map(r => r.id)
  };
}

function mapBookPage(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    url: page.url,
    title: plain(p.Title?.title) || "(untitled)",
    author: plain(p.Author?.rich_text),
    status: p.Status?.select?.name || "",
    rating: typeof p.Rating?.number === "number" ? p.Rating.number : null,
    aiStatus: p["AI Status"]?.select?.name || "",
    readyForAi: Boolean(p["Ready for AI"]?.checkbox),
    dateFinished: p["Date Finished"]?.date?.start || "",
    tbrRank: typeof p["TBR Rank"]?.number === "number" ? p["TBR Rank"].number : null,
    liked: plain(p.Liked?.rich_text),
    disliked: plain(p.Disliked?.rich_text),
    reflection: plain(p.Reflection?.rich_text),
    whatChanged: plain(p["What Changed"]?.rich_text),
    currentAppetiteSignal: plain(p["Current Appetite Signal"]?.rich_text),
    wildcard: Boolean(p.Wildcard?.checkbox),
    whyItFits: plain(p["Why It Fits"]?.rich_text),
    whyItStretches: plain(p["Why It Stretches"]?.rich_text)
  };
}

async function queryPendingQueue(env) {
  const data = await notionFetch(env, `/databases/${AI_QUEUE_DB_ID}/query`, "POST", {
    page_size: 10,
    filter: { property: "Status", select: { equals: "Pending" } },
    sorts: [{ property: "Created", direction: "ascending" }]
  });
  return (data.results || []).map(mapQueuePage);
}

async function queryReadyBooks(env) {
  const data = await notionFetch(env, `/databases/${BOOKS_DB_ID}/query`, "POST", {
    page_size: 10,
    filter: {
      or: [
        { property: "Ready for AI", checkbox: { equals: true } },
        { property: "AI Status", select: { equals: "Ready for AI" } }
      ]
    },
    sorts: [
      { property: "Date Finished", direction: "descending" },
      { property: "TBR Rank", direction: "ascending" }
    ]
  });
  return (data.results || []).map(mapBookPage);
}

function buildClaudePayload({ reason, source = "cloudflare-worker", event = null }, pendingQueue, readyBooks) {
  return {
    module: "Reading",
    reason,
    source,
    createdAt: new Date().toISOString(),
    instruction:
      "Process the provided Reading AI Queue worklist and Ready for AI books. The Worker may mark rows Processing after this trigger, so treat pendingQueue as the current worklist. Use Claude reasoning and Notion connector/writeback. Keep wildcards separate from ranked TBR.",
    pendingQueue,
    readyBooks,
    applyPacketContract: {
      triggerBookUpdate:
        "title, whatChanged, currentAppetiteSignal, sentiment, vibe, dealbreakers, aiStatus, pivot",
      tbrUpdates:
        "title, rank, predictedRating, wildcard, whyItFits, whyItStretches, movementReason, movementBadge, wildcardReason"
    },
    event
  };
}

async function triggerClaudeRoutine(env, payload) {
  if (!env.CLAUDE_READING_ROUTINE_URL) {
    return { configured: false, triggered: false };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (env.CLAUDE_READING_ROUTINE_TOKEN) {
    headers.set("Authorization", `Bearer ${env.CLAUDE_READING_ROUTINE_TOKEN}`);
  }

  const response = await fetch(env.CLAUDE_READING_ROUTINE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Claude routine ${response.status}: ${text.slice(0, 220)}`);
  }

  return { configured: true, triggered: true, status: response.status };
}

async function markTriggered(env, pendingQueue, readyBooks) {
  const today = new Date().toISOString().slice(0, 10);
  const queueUpdates = pendingQueue.map(item =>
    notionFetch(env, `/pages/${item.id}`, "PATCH", {
      properties: {
        "Status": { select: { name: "Processing" } },
        "Source": { select: { name: "Claude" } },
        "Output Summary": { rich_text: richTextChunks(`Claude routine triggered ${today}.`) }
      }
    })
  );
  const bookUpdates = readyBooks.map(book =>
    notionFetch(env, `/pages/${book.id}`, "PATCH", {
      properties: {
        "AI Status": { select: { name: "Processing" } }
      }
    })
  );
  await Promise.allSettled([...queueUpdates, ...bookUpdates]);
}

async function runReadingSynthesis(env, input = {}) {
  const [pendingQueue, readyBooks] = await Promise.all([
    queryPendingQueue(env),
    queryReadyBooks(env)
  ]);
  const pendingCount = pendingQueue.length + readyBooks.length;
  const payload = buildClaudePayload(input, pendingQueue, readyBooks);

  if (!pendingCount) {
    return {
      configured: Boolean(env.CLAUDE_READING_ROUTINE_URL),
      triggered: false,
      pendingCount,
      message: "No pending Reading synthesis items."
    };
  }

  const result = await triggerClaudeRoutine(env, payload);
  if (result.configured) {
    await markTriggered(env, pendingQueue, readyBooks);
  }

  return {
    ...result,
    pendingCount,
    queueCount: pendingQueue.length,
    readyBookCount: readyBooks.length
  };
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function hmacSha256Hex(secret, text) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyNotionSignature(rawBody, signatureHeader, verificationToken) {
  if (!signatureHeader || !verificationToken) return false;
  const expected = `sha256=${await hmacSha256Hex(verificationToken, rawBody)}`;
  return timingSafeEqual(expected, signatureHeader);
}

async function handleNotionWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const rawBody = await request.text();
  const payload = parseJsonSafe(rawBody);
  const verificationToken =
    payload.verification_token ||
    rawBody.match(/["']?verification_token["']?\s*:\s*["']?([^"',}\s]+)/)?.[1];

  if (verificationToken) {
    return jsonResponse({ verification_token: verificationToken }, 200);
  }

  const signature = request.headers.get("X-Notion-Signature") || "";
  const verified = await verifyNotionSignature(
    rawBody,
    signature,
    env.NOTION_WEBHOOK_VERIFICATION_TOKEN
  );
  if (!verified) {
    return jsonResponse({ error: "Invalid Notion webhook signature" }, 401);
  }

  ctx.waitUntil(runReadingSynthesis(env, {
    reason: "notion-webhook",
    source: "notion-webhook",
    event: payload
  }).catch(error => console.error("Reading webhook synthesis failed", error)));

  return jsonResponse({ ok: true, accepted: true }, 202);
}

async function handleSynthesisTrigger(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await runReadingSynthesis(env, {
      reason: body.reason || "manual-trigger",
      source: body.source || "reading-app",
      event: {
        queuePageId: body.queuePageId || "",
        bookId: body.bookId || ""
      }
    });
    return jsonResponse(result, 202, origin);
  } catch (error) {
    return jsonResponse({ error: error.message || "Synthesis trigger failed" }, 502, origin);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/reading/notion-webhook") {
      return handleNotionWebhook(request, env, ctx);
    }

    const origin = request.headers.get("Origin") || "";
    const internalAuth = request.headers.get("X-Internal-Auth") || "";
    const trustedInternalRequest = Boolean(
      internalAuth &&
      env.PERSONAL_AUTH_SECRET &&
      timingSafeEqual(internalAuth, env.PERSONAL_AUTH_SECRET)
    );

    if (!isAllowedOrigin(origin)) {
      return jsonResponse({ error: "Forbidden origin", received: origin }, 403, origin || "*");
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!trustedInternalRequest) {
      const authResponse = await authorizePersonalRequest(request, env);
      if (authResponse) {
        return new Response(authResponse.body, {
          status: authResponse.status,
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders(origin)
          }
        });
      }
    }

    if (url.pathname === "/reading/synthesis-trigger") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405, origin);
      }
      return handleSynthesisTrigger(request, env, origin);
    }

    if (!url.pathname.startsWith("/notion/")) {
      return jsonResponse({ error: "Not found" }, 404, origin);
    }

    const notionPath = url.pathname.replace(/^\/notion/, "");
    const notionUrl = `${NOTION_API}${notionPath}${url.search}`;
    const notionVersion = request.headers.get("Notion-Version") || DEFAULT_NOTION_VERSION;
    const contentType = request.headers.get("Content-Type");

    const response = await fetch(notionUrl, {
      method: request.method,
      headers: {
        "Authorization": `Bearer ${env.NOTION_TOKEN}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
        "Notion-Version": notionVersion
      },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body
    });

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        "Content-Type": response.headers.get("Content-Type") || "application/json",
        ...corsHeaders(origin)
      }
    });
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runReadingSynthesis(env, {
      reason: "cron-fallback",
      source: "cloudflare-cron"
    }).catch(error => console.error("Reading cron synthesis failed", error)));
  }
};
