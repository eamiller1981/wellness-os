import { authorizePersonalRequest } from "./personal-auth.js";

// Edge TTS (Microsoft Read Aloud) — unauthenticated public endpoint used by the
// Edge browser. WebSocket protocol; we send SSML and receive binary MP3 frames.
const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Cloudflare's fetch() upgrades to WebSocket using https:// — wss:// is rejected.
const WSS_BASE =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const DEFAULT_VOICE = "en-GB-ThomasNeural";
// Sec-MS-GEC handshake (added by Microsoft late 2024). See msedge-tts npm pkg.
const SEC_MS_GEC_VERSION = "1-143.0.3650.96";
const WIN_EPOCH_OFFSET_SECONDS = 11644473600; // 1601-01-01 to 1970-01-01

async function sha256HexUpper(input) {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

async function secMsGec() {
  // Stay in integer-seconds until the final multiply to avoid float precision loss.
  const ticksSec = Math.floor(Date.now() / 1000) + WIN_EPOCH_OFFSET_SECONDS;
  const roundedSec = ticksSec - (ticksSec % 300);
  // BigInt for the 10^7 multiply — windowsTicks exceeds Number.MAX_SAFE_INTEGER.
  const windowsTicks = BigInt(roundedSec) * 10000000n;
  return sha256HexUpper(`${windowsTicks}${TRUSTED_CLIENT_TOKEN}`);
}

const ALLOWED_ORIGINS = new Set([
  "https://eamiller1981.github.io",
  "https://wellness-os.vercel.app",
  "https://wellness-os-psi.vercel.app",
  "https://liz-wellness-os.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
]);

const WELLNESS_PREVIEW_ORIGIN =
  /^https:\/\/wellness-[a-z0-9-]+-eamiller1981-3240s-projects\.vercel\.app$/;

function isAllowedOrigin(origin) {
  return (
    Boolean(origin) &&
    (ALLOWED_ORIGINS.has(origin) || WELLNESS_PREVIEW_ORIGIN.test(origin))
  );
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  };
}

function preflight(request) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

function jsonResponse(origin, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin)
    }
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSsml(text, voice, ratePct, pitchHz) {
  const safeText = escapeXml(text);
  const rate = `${ratePct >= 0 ? "+" : ""}${ratePct}%`;
  const pitch = `${pitchHz >= 0 ? "+" : ""}${pitchHz}Hz`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">` +
    `<voice name="${voice}">` +
    `<prosody pitch="${pitch}" rate="${rate}" volume="+0%">${safeText}</prosody>` +
    `</voice></speak>`
  );
}

function isoTimestamp() {
  return new Date().toISOString().replace("Z", "0Z");
}

function newRequestId() {
  // 32 hex chars, no dashes.
  return crypto.randomUUID().replace(/-/g, "");
}

function newConnectionId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function buildConfigMessage() {
  const body = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: "false",
            wordBoundaryEnabled: "false"
          },
          outputFormat: OUTPUT_FORMAT
        }
      }
    }
  };
  return (
    `X-Timestamp:${isoTimestamp()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify(body)
  );
}

function buildSsmlMessage(ssml, requestId) {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${isoTimestamp()}\r\n` +
    `Path:ssml\r\n\r\n` +
    ssml
  );
}

// Edge TTS binary frame format:
//   bytes [0..2)     uint16 BE: header length
//   bytes [2..2+H)   header text (CRLF-separated key:value)
//   bytes [2+H..)    audio payload
function extractAudioFromBinaryFrame(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 2) return new Uint8Array(0);
  const headerLen = view.getUint16(0, false);
  const start = 2 + headerLen;
  if (start >= buffer.byteLength) return new Uint8Array(0);
  return new Uint8Array(buffer, start);
}

function parseTextFramePath(text) {
  // Header lines until first blank line; look for "Path:<value>".
  const headerEnd = text.indexOf("\r\n\r\n");
  const headerBlock = headerEnd === -1 ? text : text.slice(0, headerEnd);
  for (const line of headerBlock.split("\r\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).toLowerCase() === "path") {
      return line.slice(idx + 1).trim();
    }
  }
  return "";
}

async function synthesize(text, voice, ratePct, pitchHz) {
  const connectionId = newConnectionId();
  const requestId = newRequestId();
  const gec = await secMsGec();
  const url =
    `${WSS_BASE}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${gec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId}`;

  // Cloudflare Workers outbound WebSocket: fetch with Upgrade then read .webSocket.
  const upgradeResponse = await fetch(url, {
    headers: {
      "Upgrade": "websocket",
      "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
    }
  });

  const ws = upgradeResponse.webSocket;
  if (!ws) {
    let body = "";
    try {
      body = await upgradeResponse.text();
    } catch {}
    throw new Error(
      `Edge TTS upgrade failed: status=${upgradeResponse.status} body=${body.slice(0, 300)}`
    );
  }
  ws.accept();

  const audioChunks = [];
  const diag = { textFrames: [], binaryFrames: 0, totalBinaryBytes: 0 };
  const done = new Promise((resolve, reject) => {
    let receivedAnyAudio = false;
    const timeout = setTimeout(() => {
      reject(new Error(`Edge TTS synthesis timed out after 60s; diag=${JSON.stringify(diag)}`));
      try { ws.close(1000, "timeout"); } catch {}
    }, 60000);

    ws.addEventListener("message", async (event) => {
      let data = event.data;
      if (data && typeof data === "object" && typeof data.arrayBuffer === "function") {
        // Blob path
        data = await data.arrayBuffer();
      }
      if (typeof data === "string") {
        const path = parseTextFramePath(data);
        diag.textFrames.push(path);
        if (path === "turn.end") {
          clearTimeout(timeout);
          resolve();
          try { ws.close(1000, "done"); } catch {}
        }
      } else if (data instanceof ArrayBuffer) {
        diag.binaryFrames += 1;
        diag.totalBinaryBytes += data.byteLength;
        const chunk = extractAudioFromBinaryFrame(data);
        if (chunk.byteLength > 0) {
          audioChunks.push(chunk);
          receivedAnyAudio = true;
        }
      } else {
        diag.textFrames.push(`unknown:${typeof data}`);
      }
    });

    ws.addEventListener("close", (ev) => {
      clearTimeout(timeout);
      if (receivedAnyAudio) resolve();
      else reject(new Error(`Edge TTS closed (code=${ev?.code} reason=${ev?.reason || ""}) before any audio; diag=${JSON.stringify(diag)}`));
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Edge TTS WebSocket error: ${err?.message || err}; diag=${JSON.stringify(diag)}`));
    });
  });

  ws.send(buildConfigMessage());
  ws.send(buildSsmlMessage(buildSsml(text, voice, ratePct, pitchHz), requestId));

  await done;

  let total = 0;
  for (const c of audioChunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of audioChunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

async function handleSynthesize(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }

  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    // Re-wrap so the auth response carries CORS too.
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin)
      }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(origin, { ok: false, error: "Invalid JSON body" }, 400);
  }

  const text = String(payload?.text || "").trim();
  if (!text) {
    return jsonResponse(origin, { ok: false, error: "text is required" }, 400);
  }
  if (text.length > 200000) {
    return jsonResponse(
      origin,
      { ok: false, error: `text length ${text.length} exceeds 200000-char cap` },
      400
    );
  }

  const voice = String(payload?.voice || DEFAULT_VOICE);
  const ratePct = Number.isFinite(payload?.rate) ? Number(payload.rate) : 0;
  const pitchHz = Number.isFinite(payload?.pitch) ? Number(payload.pitch) : 0;

  try {
    const mp3 = await synthesizeLong(text, voice, ratePct, pitchHz);
    return new Response(mp3, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(mp3.byteLength),
        "Cache-Control": "no-store",
        ...corsHeaders(origin)
      }
    });
  } catch (err) {
    return jsonResponse(
      origin,
      { ok: false, error: String(err?.message || err) },
      502
    );
  }
}

async function handleVoices(request) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  const upstream = await fetch(
    `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0"
      }
    }
  );
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin)
    }
  });
}

// --------------------------------------------------------------------------
// Chunking: split text into ~3000-char pieces on paragraph then sentence
// boundaries. Edge TTS handles up to ~6KB per request reliably; we stay well
// under that. MP3 frames are concatenation-safe so we can byte-cat results.
// --------------------------------------------------------------------------
const CHUNK_TARGET = 3000;

function chunkText(text) {
  const normalized = String(text).replace(/\r\n/g, "\n").trim();
  if (normalized.length <= CHUNK_TARGET) return [normalized];

  const chunks = [];
  let buf = "";
  const paragraphs = normalized.split(/\n{2,}/);
  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if ((buf + "\n\n" + para).length <= CHUNK_TARGET) {
      buf = buf ? `${buf}\n\n${para}` : para;
      continue;
    }
    if (buf) {
      chunks.push(buf);
      buf = "";
    }
    if (para.length <= CHUNK_TARGET) {
      buf = para;
      continue;
    }
    // Paragraph itself too long — split on sentence boundaries.
    const sentences = para.split(/(?<=[.!?])\s+/);
    let sBuf = "";
    for (const s of sentences) {
      if ((sBuf + " " + s).length <= CHUNK_TARGET) {
        sBuf = sBuf ? `${sBuf} ${s}` : s;
      } else {
        if (sBuf) chunks.push(sBuf);
        // If a single sentence is still too long, hard-split on chars.
        if (s.length > CHUNK_TARGET) {
          for (let i = 0; i < s.length; i += CHUNK_TARGET) {
            chunks.push(s.slice(i, i + CHUNK_TARGET));
          }
          sBuf = "";
        } else {
          sBuf = s;
        }
      }
    }
    if (sBuf) buf = sBuf;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function synthesizeLong(text, voice, ratePct, pitchHz) {
  const pieces = chunkText(text);
  if (pieces.length === 1) {
    return synthesize(pieces[0], voice, ratePct, pitchHz);
  }
  // Fire all chunk synths concurrently — Microsoft accepts parallel WebSockets,
  // and Workers free wall-clock budget is too tight for sequential chunks at
  // chapter scale. Order is preserved via Promise.all index alignment.
  const buffers = await Promise.all(
    pieces.map((piece) => synthesize(piece, voice, ratePct, pitchHz))
  );
  let total = 0;
  for (const b of buffers) total += b.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    merged.set(b, offset);
    offset += b.byteLength;
  }
  return merged;
}

// Rough MP3 duration estimate. Edge TTS @ 24kHz/48kbps mono ≈ 6000 bytes/sec.
function estimateDurationSec(byteLength) {
  return Math.round((byteLength / 6000) * 10) / 10;
}

// --------------------------------------------------------------------------
// Notion writes via the NOTION_PROXY service binding. The proxy accepts an
// X-Internal-Auth header equal to PERSONAL_AUTH_SECRET to skip user-auth.
// --------------------------------------------------------------------------
async function notionProxyFetch(env, method, path, body) {
  const init = {
    method,
    headers: {
      // Service-binding fetches default to no Origin; proxy demands one in
      // ALLOWED_ORIGINS, so pretend to be the production app.
      "Origin": "https://liz-wellness-os.vercel.app",
      "X-Internal-Auth": env.PERSONAL_AUTH_SECRET || "",
      "Content-Type": "application/json"
    }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const resp = await env.NOTION_PROXY.fetch(
    `https://notion-budget-manager/notion${path}`,
    init
  );
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Notion ${method} ${path} failed ${resp.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

function richText(value) {
  if (!value) return [];
  return [{ type: "text", text: { content: String(value).slice(0, 1900) } }];
}

async function createLibraryPage(env, fields) {
  const properties = {
    "Title": { title: richText(fields.title) },
    "Book": { rich_text: richText(fields.book) },
    "Section": { rich_text: richText(fields.section) },
    "Voice": { select: { name: fields.voice } },
    "Speed": { number: fields.speed ?? 0 },
    "Char count": { number: fields.charCount },
    "Status": { select: { name: "pending" } }
  };
  const page = await notionProxyFetch(env, "POST", "/pages", {
    parent: { database_id: env.AUDIO_LIBRARY_DB_ID },
    properties
  });
  return page.id;
}

async function markLibraryReady(env, pageId, fields) {
  return notionProxyFetch(env, "PATCH", `/pages/${pageId}`, {
    properties: {
      "Status": { select: { name: "ready" } },
      "Duration sec": { number: fields.durationSec },
      "R2 Key": { rich_text: richText(fields.r2Key) },
      "File URL": { url: fields.fileUrl }
    }
  });
}

async function markLibraryError(env, pageId, errorMessage) {
  return notionProxyFetch(env, "PATCH", `/pages/${pageId}`, {
    properties: {
      "Status": { select: { name: "error" } },
      "Error": { rich_text: richText(errorMessage) }
    }
  });
}

// --------------------------------------------------------------------------
// POST /api/tts/library — synthesize + store in R2 + log to Notion.
// --------------------------------------------------------------------------
async function handleLibraryCreate(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(origin, { ok: false, error: "Invalid JSON body" }, 400);
  }

  const text = String(payload?.text || "").trim();
  const title = String(payload?.title || "").trim() || "Untitled audio";
  const book = String(payload?.book || "").trim();
  const section = String(payload?.section || "").trim();
  const voice = String(payload?.voice || DEFAULT_VOICE);
  const speedPct = Number.isFinite(payload?.rate) ? Number(payload.rate) : 0;
  const pitchHz = Number.isFinite(payload?.pitch) ? Number(payload.pitch) : 0;

  if (!text) {
    return jsonResponse(origin, { ok: false, error: "text is required" }, 400);
  }
  if (text.length > 200000) {
    return jsonResponse(
      origin,
      { ok: false, error: `text length ${text.length} exceeds 200000 cap` },
      400
    );
  }

  let pageId;
  try {
    pageId = await createLibraryPage(env, {
      title, book, section, voice,
      speed: speedPct,
      charCount: text.length
    });
  } catch (err) {
    return jsonResponse(
      origin,
      { ok: false, error: `Notion page create failed: ${err?.message || err}` },
      502
    );
  }

  try {
    const mp3 = await synthesizeLong(text, voice, speedPct, pitchHz);
    const r2Key = `library/${pageId.replace(/-/g, "")}.mp3`;
    await env.AUDIO_BUCKET.put(r2Key, mp3, {
      httpMetadata: { contentType: "audio/mpeg" },
      customMetadata: {
        title,
        book,
        section,
        voice,
        rate: String(speedPct),
        pitch: String(pitchHz),
        charCount: String(text.length)
      }
    });
    const fileUrl = `${env.AUDIO_PUBLIC_BASE_URL}/${encodeURIComponent(r2Key)}?token=${pageId.replace(/-/g, "").slice(0, 16)}`;
    const durationSec = estimateDurationSec(mp3.byteLength);
    await markLibraryReady(env, pageId, { durationSec, r2Key, fileUrl });

    return jsonResponse(origin, {
      ok: true,
      pageId,
      r2Key,
      fileUrl,
      bytes: mp3.byteLength,
      durationSec,
      chunks: chunkText(text).length
    });
  } catch (err) {
    try {
      await markLibraryError(env, pageId, String(err?.message || err));
    } catch {}
    return jsonResponse(
      origin,
      { ok: false, error: String(err?.message || err), pageId },
      502
    );
  }
}

// --------------------------------------------------------------------------
// GET /audio/<key> — serve audio from R2. The "token" query param is a weak
// guard so library URLs aren't trivially enumerable; it must match the first
// 16 hex chars of the R2 key's basename.
// --------------------------------------------------------------------------
async function handleAudioGet(request, env, url) {
  const key = decodeURIComponent(url.pathname.replace(/^\/audio\//, ""));
  const expectedToken = key.split("/").pop().replace(/\.mp3$/, "").slice(0, 16);
  const givenToken = url.searchParams.get("token") || "";
  if (!key.startsWith("library/") || givenToken !== expectedToken) {
    return new Response("Not found", { status: 404 });
  }
  const obj = await env.AUDIO_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(obj.body, { status: 200, headers });
}

// --------------------------------------------------------------------------
// GET /api/tts/library — list recent entries (newest first).
// --------------------------------------------------------------------------
async function handleLibraryList(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) {
    return new Response("Forbidden origin", { status: 403 });
  }
  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }
  try {
    const result = await notionProxyFetch(env, "POST", `/databases/${env.AUDIO_LIBRARY_DB_ID}/query`, {
      page_size: 50,
      sorts: [{ property: "Created", direction: "descending" }]
    });
    const entries = (result?.results || []).map((p) => {
      const props = p.properties || {};
      const titleArr = props.Title?.title || [];
      const bookArr = props.Book?.rich_text || [];
      const sectionArr = props.Section?.rich_text || [];
      const r2KeyArr = props["R2 Key"]?.rich_text || [];
      return {
        id: p.id,
        title: titleArr.map((t) => t.plain_text).join("") || "Untitled",
        book: bookArr.map((t) => t.plain_text).join(""),
        section: sectionArr.map((t) => t.plain_text).join(""),
        voice: props.Voice?.select?.name || "",
        speed: props.Speed?.number ?? 0,
        durationSec: props["Duration sec"]?.number ?? 0,
        status: props.Status?.select?.name || "",
        fileUrl: props["File URL"]?.url || "",
        r2Key: r2KeyArr.map((t) => t.plain_text).join(""),
        created: p.created_time
      };
    });
    return jsonResponse(origin, { ok: true, entries });
  } catch (err) {
    return jsonResponse(
      origin,
      { ok: false, error: String(err?.message || err) },
      502
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return preflight(request);

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/tts/synthesize") {
      return handleSynthesize(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/tts/library") {
      return handleLibraryCreate(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/tts/library") {
      return handleLibraryList(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/tts/voices") {
      return handleVoices(request);
    }
    if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
      return handleAudioGet(request, env, url);
    }

    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  }
};
