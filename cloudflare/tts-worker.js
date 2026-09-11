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

// Bumped on every deploy so the client can detect which build is live and
// whether it supports the chunked upload pipeline.
const WORKER_VERSION = "2026-09-11-jobs-1";
const WORKER_FEATURES = [
  "synthesize", "library", "libraryUpload", "audioRange", "health", "backgroundJobs"
];

// Every stage of an Edge TTS call gets its own deadline. Without these a
// silently-hung upstream socket pins the Worker request open until Cloudflare
// tears it down, which returns no response at all -- that is what left Notion
// rows stranded on "pending" with an empty Error field.
const UPGRADE_TIMEOUT_MS = 15000;   // WebSocket handshake must complete
const FIRST_AUDIO_TIMEOUT_MS = 25000; // first audio frame must arrive
const SYNTH_TIMEOUT_MS = 45000;     // whole utterance must finish
const INTER_CHUNK_DELAY_MS = 250;   // spacing between sequential chunk sockets
const CHUNK_RETRIES = 1;            // retries per chunk inside one request
// Anything longer belongs on the chunked client pipeline: one HTTP request per
// chunk, assembled in the browser, uploaded once. A single request that has to
// open many upstream sockets is exactly the shape that stalls.
const MAX_CHUNKS_PER_REQUEST = 6;
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  "https://my-wellness-os.com",
  "https://www.my-wellness-os.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://localhost:5175"
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
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-Audio-Meta",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length"
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
  // The handshake itself is aborted on a deadline -- a hung upgrade used to hang
  // the whole request forever.
  const upgradeAbort = new AbortController();
  const upgradeTimer = setTimeout(() => upgradeAbort.abort(), UPGRADE_TIMEOUT_MS);
  let upgradeResponse;
  try {
    upgradeResponse = await fetch(url, {
      headers: {
        "Upgrade": "websocket",
        "Origin": "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0"
      },
      signal: upgradeAbort.signal
    });
  } catch (err) {
    throw new Error(
      `Edge TTS upgrade did not complete within ${UPGRADE_TIMEOUT_MS}ms: ${err?.message || err}`
    );
  } finally {
    clearTimeout(upgradeTimer);
  }

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
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(firstAudioTimeout);
      fn(arg);
    };
    const fail = (message) => {
      finish(reject, new Error(`${message}; diag=${JSON.stringify(diag)}`));
      try { ws.close(1000, "timeout"); } catch {}
    };
    const timeout = setTimeout(
      () => fail(`Edge TTS synthesis timed out after ${SYNTH_TIMEOUT_MS}ms`),
      SYNTH_TIMEOUT_MS
    );
    // A socket that opens but never speaks is the common throttle signature.
    // Fail it early so the caller can retry instead of holding the request open.
    const firstAudioTimeout = setTimeout(() => {
      if (!receivedAnyAudio) {
        fail(`Edge TTS sent no audio within ${FIRST_AUDIO_TIMEOUT_MS}ms (upstream throttle?)`);
      }
    }, FIRST_AUDIO_TIMEOUT_MS);

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
          finish(resolve);
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
      if (receivedAnyAudio) finish(resolve);
      else finish(reject, new Error(`Edge TTS closed (code=${ev?.code} reason=${ev?.reason || ""}) before any audio; diag=${JSON.stringify(diag)}`));
    });

    ws.addEventListener("error", (err) => {
      finish(reject, new Error(`Edge TTS WebSocket error: ${err?.message || err}; diag=${JSON.stringify(diag)}`));
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

async function synthesizeWithRetry(text, voice, ratePct, pitchHz) {
  let lastErr;
  for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      return await synthesize(text, voice, ratePct, pitchHz);
    } catch (err) {
      lastErr = err;
      if (attempt < CHUNK_RETRIES) await sleep(1500);
    }
  }
  throw lastErr;
}

async function synthesizeLong(text, voice, ratePct, pitchHz) {
  const pieces = chunkText(text);
  if (pieces.length === 1) {
    return synthesizeWithRetry(pieces[0], voice, ratePct, pitchHz);
  }
  if (pieces.length > MAX_CHUNKS_PER_REQUEST) {
    throw new Error(
      `Text splits into ${pieces.length} chunks; this endpoint renders at most ` +
      `${MAX_CHUNKS_PER_REQUEST} per request. Render it chunk-by-chunk via ` +
      `POST /api/tts/synthesize and upload the assembled MP3 to POST /api/tts/library/upload.`
    );
  }
  // Sequential, not concurrent. Parallel sockets to Edge TTS from a shared
  // Cloudflare egress IP are what started hanging: the second socket opens and
  // then never sends audio, so the request never returns.
  const buffers = new Array(pieces.length);
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) await sleep(INTER_CHUNK_DELAY_MS);
    buffers[i] = await synthesizeWithRetry(pieces[i], voice, ratePct, pitchHz);
  }
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
// Background render jobs
//
// A job is a whole book (or a selection of its chapters) queued for rendering
// server-side. A Cron Trigger fires every minute and works the queue, so the
// render continues with the browser closed and the phone asleep. Job state
// lives in R2 next to the audio -- no extra binding to provision.
//
//   jobs/active/<jobId>.json        manifest + cursor (small)
//   jobs/done/<jobId>.json          finished manifest
//   jobs/cancel/<jobId>             tombstone requesting cancellation
//   jobs/text/<jobId>/<n>.txt       chapter source text
//   jobs/audio/<jobId>/<n>/<k>.mp3  rendered chunk, concatenated on completion
// --------------------------------------------------------------------------
const JOB_ACTIVE_PREFIX = "jobs/active/";
const JOB_DONE_PREFIX = "jobs/done/";
const JOB_CANCEL_PREFIX = "jobs/cancel/";
const jobActiveKey = (id) => `${JOB_ACTIVE_PREFIX}${id}.json`;
const jobDoneKey = (id) => `${JOB_DONE_PREFIX}${id}.json`;
const jobCancelKey = (id) => `${JOB_CANCEL_PREFIX}${id}`;
// Every chapter's text lives in one blob, addressed by byte range, so queueing
// a 60-chapter book costs two subrequests rather than sixty.
const jobTextKey = (id) => `jobs/text/${id}.bin`;
const jobPartKey = (id, chapterIdx, chunkIdx) =>
  `jobs/audio/${id}/${chapterIdx}/${String(chunkIdx).padStart(4, "0")}.mp3`;

// A cron invocation may run for 15 minutes, but a short tick keeps progress
// durable and stays well inside the Workers Free subrequest cap (50 per
// invocation; every binding call counts). Whatever is left resumes next minute.
const TICK_BUDGET_MS = 50000;
const TICK_SUBREQUEST_BUDGET = 40;
const JOB_LEASE_MS = 3 * 60 * 1000;
const MAX_CHAPTER_ATTEMPTS = 3;
const MAX_JOB_CHAPTERS = 400;
const MAX_JOB_TEXT_CHARS = 4000000;

function makeBudget() {
  const deadline = Date.now() + TICK_BUDGET_MS;
  let spent = 0;
  return {
    spend(n = 1) { spent += n; },
    remaining() { return TICK_SUBREQUEST_BUDGET - spent; },
    ok() { return Date.now() < deadline && spent < TICK_SUBREQUEST_BUDGET; }
  };
}

function jobSummary(job, { includeChapters = true } = {}) {
  const chapters = job.chapters || [];
  const done = chapters.filter((c) => c.status === "done").length;
  const errored = chapters.filter((c) => c.status === "error").length;
  const current = chapters[job.cursor?.chapter ?? -1] || null;
  return {
    id: job.id,
    book: job.book,
    voice: job.voice,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    total: chapters.length,
    done,
    errored,
    lastError: job.lastError || null,
    current: current && current.status === "running"
      ? {
          title: current.title,
          index: job.cursor.chapter,
          chunk: job.cursor.chunk,
          chunkCount: current.chunkCount ?? null
        }
      : null,
    chapters: includeChapters
      ? chapters.map((c) => ({
          title: c.title,
          charCount: c.charCount,
          status: c.status,
          fileUrl: c.fileUrl || null,
          error: c.error || null
        }))
      : undefined
  };
}

async function loadJob(env, key) {
  const obj = await env.AUDIO_BUCKET.get(key);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

async function saveJob(env, job) {
  job.updatedAt = new Date().toISOString();
  await env.AUDIO_BUCKET.put(jobActiveKey(job.id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function finishJob(env, job, status) {
  // A chapter caught mid-render has a Notion row sitting on "pending" and audio
  // parts in R2. Close both out rather than leaving orphans behind.
  if (status !== "done") {
    for (const [idx, chapter] of (job.chapters || []).entries()) {
      if (chapter.status !== "running") continue;
      chapter.status = "error";
      chapter.error = `Render ${status} before this chapter finished`;
      if (chapter.pageId) {
        try { await markLibraryError(env, chapter.pageId, chapter.error); } catch {}
      }
      await deleteChapterParts(env, job.id, idx);
    }
  }
  job.status = status;
  job.updatedAt = new Date().toISOString();
  job.leaseUntil = 0;
  await env.AUDIO_BUCKET.put(jobDoneKey(job.id), JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" }
  });
  await env.AUDIO_BUCKET.delete(jobActiveKey(job.id));
  await env.AUDIO_BUCKET.delete(jobCancelKey(job.id));
  // Source text is only needed while rendering.
  try {
    await env.AUDIO_BUCKET.delete(jobTextKey(job.id));
  } catch {}
}

async function deleteChapterParts(env, jobId, chapterIdx) {
  try {
    const listed = await env.AUDIO_BUCKET.list({ prefix: `jobs/audio/${jobId}/${chapterIdx}/` });
    for (const o of listed.objects) await env.AUDIO_BUCKET.delete(o.key);
  } catch {}
}

// Claim the least-recently-touched active job whose lease has expired. R2 has
// no compare-and-set, but ticks are short and the lease is long, so two
// invocations never work the same job in practice.
async function claimJob(env) {
  const listed = await env.AUDIO_BUCKET.list({ prefix: JOB_ACTIVE_PREFIX, limit: 10 });
  const now = Date.now();
  const candidates = [];
  for (const obj of listed.objects) {
    const job = await loadJob(env, obj.key);
    if (!job || job.status !== "active") continue;
    if ((job.leaseUntil || 0) > now) continue;
    candidates.push(job);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  const job = candidates[0];
  job.leaseUntil = now + JOB_LEASE_MS;
  await saveJob(env, job);
  return job;
}

async function isCancelled(env, jobId) {
  try {
    return Boolean(await env.AUDIO_BUCKET.head(jobCancelKey(jobId)));
  } catch {
    return false;
  }
}

// Renders as much of the cursor's chapter as the tick budget allows. Returns
// when the budget is spent or the chapter is finished; the cursor is persisted
// after every chunk so the next tick resumes exactly where this one stopped.
async function advanceChapter(env, job, budget) {
  const idx = job.cursor.chapter;
  const chapter = job.chapters[idx];

  if (chapter.status === "done" || chapter.status === "error") {
    job.cursor = { chapter: idx + 1, chunk: 0 };
    await saveJob(env, job);
    budget.spend(1);
    return;
  }

  const textObj = await env.AUDIO_BUCKET.get(jobTextKey(job.id), {
    range: { offset: chapter.textOffset, length: chapter.textLength }
  });
  budget.spend(1);
  if (!textObj) {
    chapter.status = "error";
    chapter.error = "Chapter text is missing from R2";
    job.cursor = { chapter: idx + 1, chunk: 0 };
    await saveJob(env, job);
    budget.spend(1);
    return;
  }
  const pieces = chunkText(await textObj.text());
  chapter.chunkCount = pieces.length;

  if (chapter.status === "pending") {
    try {
      chapter.pageId = await createLibraryPage(env, {
        title: chapter.title,
        book: job.book,
        section: chapter.title,
        voice: job.voice,
        speed: job.rate,
        charCount: chapter.charCount
      });
      budget.spend(1);
    } catch (err) {
      chapter.attempts = (chapter.attempts || 0) + 1;
      chapter.error = `Notion page create failed: ${err?.message || err}`;
      if (chapter.attempts >= MAX_CHAPTER_ATTEMPTS) {
        chapter.status = "error";
        job.cursor = { chapter: idx + 1, chunk: 0 };
      }
      await saveJob(env, job);
      budget.spend(1);
      return;
    }
    chapter.status = "running";
    chapter.partSizes = [];
    job.cursor = { chapter: idx, chunk: 0 };
    await saveJob(env, job);
    budget.spend(1);
  }

  // Synthesize chunks one at a time, persisting each to R2 as its own object.
  while (job.cursor.chunk < pieces.length && budget.ok()) {
    const chunkIdx = job.cursor.chunk;
    try {
      const mp3 = await synthesizeWithRetry(pieces[chunkIdx], job.voice, job.rate, 0);
      budget.spend(1);
      await env.AUDIO_BUCKET.put(jobPartKey(job.id, idx, chunkIdx), mp3, {
        httpMetadata: { contentType: "audio/mpeg" }
      });
      budget.spend(1);
      chapter.partSizes = chapter.partSizes || [];
      chapter.partSizes[chunkIdx] = mp3.byteLength;
      chapter.error = null;
      chapter.attempts = 0;
      job.cursor = { chapter: idx, chunk: chunkIdx + 1 };
      await saveJob(env, job);
      budget.spend(1);
    } catch (err) {
      chapter.attempts = (chapter.attempts || 0) + 1;
      chapter.error = `chunk ${chunkIdx + 1}/${pieces.length}: ${err?.message || err}`;
      if (chapter.attempts >= MAX_CHAPTER_ATTEMPTS) {
        chapter.status = "error";
        try {
          if (chapter.pageId) await markLibraryError(env, chapter.pageId, chapter.error);
        } catch {}
        await deleteChapterParts(env, job.id, idx);
        job.cursor = { chapter: idx + 1, chunk: 0 };
      }
      await saveJob(env, job);
      budget.spend(1);
      return; // let the next tick retry this chapter from its cursor
    }
  }

  if (job.cursor.chunk < pieces.length) return; // out of budget mid-chapter

  // Finalising reads every part back, so only start it with room to spare.
  const finalizeCost = pieces.length + 4;
  if (finalizeCost <= TICK_SUBREQUEST_BUDGET) {
    if (budget.remaining() < finalizeCost) return; // finish it on a fresh tick
  } else if (budget.remaining() < TICK_SUBREQUEST_BUDGET - 2) {
    // A chapter with more chunks than the conservative per-tick budget can never
    // satisfy the check above. Run it at the start of a tick instead, so it
    // always makes progress rather than deferring forever.
    return;
  }

  let total = 0;
  for (const size of chapter.partSizes || []) total += size || 0;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < pieces.length; i++) {
    const part = await env.AUDIO_BUCKET.get(jobPartKey(job.id, idx, i));
    budget.spend(1);
    if (!part) throw new Error(`Rendered part ${i + 1}/${pieces.length} vanished from R2`);
    const bytes = new Uint8Array(await part.arrayBuffer());
    merged.set(bytes, offset);
    offset += bytes.byteLength;
  }

  const r2Key = `library/${chapter.pageId.replace(/-/g, "")}.mp3`;
  await env.AUDIO_BUCKET.put(r2Key, merged, {
    httpMetadata: { contentType: "audio/mpeg" },
    customMetadata: {
      title: chapter.title,
      book: job.book,
      section: chapter.title,
      voice: job.voice,
      rate: String(job.rate),
      pitch: "0",
      charCount: String(chapter.charCount)
    }
  });
  budget.spend(1);

  const fileUrl = `${env.AUDIO_PUBLIC_BASE_URL}/${encodeURIComponent(r2Key)}?token=${chapter.pageId.replace(/-/g, "").slice(0, 16)}`;
  await markLibraryReady(env, chapter.pageId, {
    durationSec: estimateDurationSec(merged.byteLength),
    r2Key,
    fileUrl
  });
  budget.spend(1);

  chapter.status = "done";
  chapter.fileUrl = fileUrl;
  chapter.bytes = merged.byteLength;
  chapter.error = null;
  delete chapter.partSizes;
  job.cursor = { chapter: idx + 1, chunk: 0 };
  await saveJob(env, job);
  budget.spend(1);
  await deleteChapterParts(env, job.id, idx);
}

async function runJobTick(env) {
  const job = await claimJob(env);
  if (!job) return { claimed: false };
  const budget = makeBudget();
  try {
    while (job.cursor.chapter < job.chapters.length && budget.ok()) {
      if (await isCancelled(env, job.id)) {
        await finishJob(env, job, "cancelled");
        return { claimed: true, id: job.id, cancelled: true };
      }
      budget.spend(1);
      await advanceChapter(env, job, budget);
    }
    if (job.cursor.chapter >= job.chapters.length) {
      await finishJob(env, job, "done");
      return { claimed: true, id: job.id, finished: true };
    }
    job.leaseUntil = 0;
    await saveJob(env, job);
    return { claimed: true, id: job.id, cursor: job.cursor };
  } catch (err) {
    // Release the lease so the next tick retries rather than waiting it out.
    job.lastError = String(err?.message || err);
    job.leaseUntil = 0;
    try { await saveJob(env, job); } catch {}
    return { claimed: true, id: job.id, error: job.lastError };
  }
}

// POST /api/tts/jobs — queue a book for background rendering.
async function handleJobCreate(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return new Response("Forbidden origin", { status: 403 });
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

  const book = String(payload?.book || "").trim();
  const voice = String(payload?.voice || DEFAULT_VOICE);
  const rate = Number.isFinite(payload?.rate) ? Number(payload.rate) : 0;
  const chapters = Array.isArray(payload?.chapters) ? payload.chapters : [];
  if (!book) return jsonResponse(origin, { ok: false, error: "book is required" }, 400);
  if (!chapters.length) return jsonResponse(origin, { ok: false, error: "chapters are required" }, 400);
  if (chapters.length > MAX_JOB_CHAPTERS) {
    return jsonResponse(origin, { ok: false, error: `${chapters.length} chapters exceeds the ${MAX_JOB_CHAPTERS} cap` }, 400);
  }

  const texts = [];
  let totalChars = 0;
  for (const [i, ch] of chapters.entries()) {
    const text = String(ch?.text || "").trim();
    if (!text) return jsonResponse(origin, { ok: false, error: `chapter ${i + 1} has no text` }, 400);
    totalChars += text.length;
    texts.push(text);
  }
  if (totalChars > MAX_JOB_TEXT_CHARS) {
    return jsonResponse(origin, { ok: false, error: `${totalChars} chars exceeds the ${MAX_JOB_TEXT_CHARS} per-job cap` }, 400);
  }

  // Concatenate the chapter texts and record each one's byte range.
  const encoder = new TextEncoder();
  const encoded = texts.map((t) => encoder.encode(t));
  let blobLength = 0;
  for (const e of encoded) blobLength += e.byteLength;
  const textBlob = new Uint8Array(blobLength);
  const ranges = [];
  let blobOffset = 0;
  for (const e of encoded) {
    textBlob.set(e, blobOffset);
    ranges.push({ offset: blobOffset, length: e.byteLength });
    blobOffset += e.byteLength;
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  const job = {
    id,
    book,
    voice,
    rate,
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    leaseUntil: 0,
    cursor: { chapter: 0, chunk: 0 },
    lastError: null,
    chapters: chapters.map((ch, i) => ({
      title: String(ch?.title || `Section ${i + 1}`).slice(0, 200),
      charCount: texts[i].length,
      textOffset: ranges[i].offset,
      textLength: ranges[i].length,
      chunkCount: null,
      status: "pending",
      attempts: 0,
      pageId: null,
      fileUrl: null,
      error: null
    }))
  };

  try {
    await env.AUDIO_BUCKET.put(jobTextKey(id), textBlob, {
      httpMetadata: { contentType: "text/plain; charset=utf-8" }
    });
    await saveJob(env, job);
  } catch (err) {
    return jsonResponse(origin, { ok: false, error: `Could not queue job: ${err?.message || err}` }, 502);
  }

  return jsonResponse(origin, { ok: true, job: jobSummary(job) });
}

// GET /api/tts/jobs — active jobs first, then recently finished ones.
async function handleJobList(request, env) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return new Response("Forbidden origin", { status: 403 });
  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }
  try {
    const jobs = [];
    const active = await env.AUDIO_BUCKET.list({ prefix: JOB_ACTIVE_PREFIX, limit: 25 });
    for (const obj of active.objects) {
      const job = await loadJob(env, obj.key);
      if (job) jobs.push(jobSummary(job, { includeChapters: false }));
    }
    const done = await env.AUDIO_BUCKET.list({ prefix: JOB_DONE_PREFIX, limit: 10 });
    const recent = done.objects
      .sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)))
      .slice(0, 5);
    for (const obj of recent) {
      const job = await loadJob(env, obj.key);
      if (job) jobs.push(jobSummary(job, { includeChapters: false }));
    }
    return jsonResponse(origin, { ok: true, jobs });
  } catch (err) {
    return jsonResponse(origin, { ok: false, error: String(err?.message || err) }, 502);
  }
}

// GET /api/tts/jobs/<id> — one job's progress.
async function handleJobGet(request, env, jobId) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return new Response("Forbidden origin", { status: 403 });
  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }
  const job =
    (await loadJob(env, jobActiveKey(jobId))) || (await loadJob(env, jobDoneKey(jobId)));
  if (!job) return jsonResponse(origin, { ok: false, error: "Job not found" }, 404);
  return jsonResponse(origin, { ok: true, job: jobSummary(job) });
}

// POST /api/tts/jobs/<id>/cancel — the runner stops at the next chapter boundary.
async function handleJobCancel(request, env, jobId) {
  const origin = request.headers.get("Origin") || "";
  if (!isAllowedOrigin(origin)) return new Response("Forbidden origin", { status: 403 });
  const auth = await authorizePersonalRequest(request, env);
  if (auth) {
    const body = await auth.text();
    return new Response(body, {
      status: auth.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
    });
  }
  const job = await loadJob(env, jobActiveKey(jobId));
  if (!job) return jsonResponse(origin, { ok: false, error: "No active job with that id" }, 404);
  await env.AUDIO_BUCKET.put(jobCancelKey(jobId), "1");
  // If nothing holds the lease, retire it immediately.
  if ((job.leaseUntil || 0) <= Date.now()) {
    await finishJob(env, job, "cancelled");
    return jsonResponse(origin, { ok: true, cancelled: true, immediate: true });
  }
  return jsonResponse(origin, { ok: true, cancelled: true, immediate: false });
}

// --------------------------------------------------------------------------
// POST /api/tts/library/upload — store an MP3 the browser already assembled.
//
// The client renders a chapter chunk-by-chunk through /api/tts/synthesize (one
// short request per chunk, one upstream socket each), concatenates the MP3
// frames locally, then posts the finished file here. This request opens no
// upstream socket at all, so it cannot stall.
//
// Body: raw audio/mpeg bytes.
// X-Audio-Meta: base64url-encoded JSON { title, book, section, voice, rate,
//               pitch, charCount, chunks }.
// --------------------------------------------------------------------------
function decodeMetaHeader(value) {
  const padded = String(value)
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(value).length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function handleLibraryUpload(request, env) {
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

  let meta;
  try {
    meta = decodeMetaHeader(request.headers.get("X-Audio-Meta") || "");
  } catch (err) {
    return jsonResponse(
      origin,
      { ok: false, error: `X-Audio-Meta is missing or not base64url JSON: ${err?.message || err}` },
      400
    );
  }

  const title = String(meta?.title || "").trim() || "Untitled audio";
  const book = String(meta?.book || "").trim();
  const section = String(meta?.section || "").trim();
  const voice = String(meta?.voice || DEFAULT_VOICE);
  const speedPct = Number.isFinite(meta?.rate) ? Number(meta.rate) : 0;
  const pitchHz = Number.isFinite(meta?.pitch) ? Number(meta.pitch) : 0;
  const charCount = Number.isFinite(meta?.charCount) ? Number(meta.charCount) : 0;

  const mp3 = await request.arrayBuffer();
  if (mp3.byteLength < 1000) {
    return jsonResponse(
      origin,
      { ok: false, error: `Uploaded audio is only ${mp3.byteLength} bytes — refusing to store it.` },
      400
    );
  }
  if (mp3.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse(
      origin,
      { ok: false, error: `Uploaded audio is ${mp3.byteLength} bytes, over the ${MAX_UPLOAD_BYTES}-byte cap.` },
      413
    );
  }

  let pageId;
  try {
    pageId = await createLibraryPage(env, {
      title, book, section, voice,
      speed: speedPct,
      charCount
    });
  } catch (err) {
    return jsonResponse(
      origin,
      { ok: false, error: `Notion page create failed: ${err?.message || err}` },
      502
    );
  }

  try {
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
        charCount: String(charCount)
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
      durationSec
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

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      const head = await env.AUDIO_BUCKET.head(key);
      if (!head) return new Response("Not found", { status: 404 });
      const total = head.size;
      let start = match[1] === "" ? NaN : parseInt(match[1], 10);
      let end = match[2] === "" ? NaN : parseInt(match[2], 10);
      // "bytes=-N" means last N bytes
      if (Number.isNaN(start) && !Number.isNaN(end)) {
        start = Math.max(0, total - end);
        end = total - 1;
      } else {
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end)) end = total - 1;
      }
      if (start >= total || start < 0 || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${total}`,
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": "bytes"
          }
        });
      }
      end = Math.min(end, total - 1);
      const length = end - start + 1;
      const obj = await env.AUDIO_BUCKET.get(key, {
        range: { offset: start, length }
      });
      if (!obj) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
      headers.set("Content-Length", String(length));
      return new Response(obj.body, { status: 206, headers });
    }
  }

  const obj = await env.AUDIO_BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Length", String(obj.size));
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
    if (request.method === "POST" && url.pathname === "/api/tts/library/upload") {
      return handleLibraryUpload(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/tts/jobs") {
      return handleJobCreate(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/tts/jobs") {
      return handleJobList(request, env);
    }
    const jobCancel = /^\/api\/tts\/jobs\/([A-Za-z0-9]+)\/cancel$/.exec(url.pathname);
    if (request.method === "POST" && jobCancel) {
      return handleJobCancel(request, env, jobCancel[1]);
    }
    const jobGet = /^\/api\/tts\/jobs\/([A-Za-z0-9]+)$/.exec(url.pathname);
    if (request.method === "GET" && jobGet) {
      return handleJobGet(request, env, jobGet[1]);
    }
    if (request.method === "GET" && url.pathname === "/api/tts/library") {
      return handleLibraryList(request, env);
    }
    if (request.method === "GET" && url.pathname === "/api/tts/voices") {
      return handleVoices(request);
    }
    // Unauthenticated build probe: the render page uses it to confirm the
    // deployed Worker understands the chunked upload pipeline.
    if (request.method === "GET" && url.pathname === "/api/tts/health") {
      return new Response(
        JSON.stringify({ ok: true, version: WORKER_VERSION, features: WORKER_FEATURES }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }
    if (request.method === "GET" && url.pathname.startsWith("/audio/")) {
      return handleAudioGet(request, env, url);
    }

    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  },

  // Cron Trigger (every minute): work the background render queue. This is what
  // lets a render continue with the browser closed.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runJobTick(env).then(
        (result) => console.log("tts job tick", JSON.stringify(result)),
        (err) => console.error("tts job tick failed", String(err?.message || err))
      )
    );
  }
};
