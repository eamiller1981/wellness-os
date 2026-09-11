// Tests for the background render queue in tts-worker.js.
//
//   node cloudflare/tts-jobs.test.mjs
//
// The Worker is imported with R2, the Notion proxy and Edge TTS stubbed out, so
// the whole job state machine — cursor advancement, cross-tick resume, retries,
// finalisation and cancellation — runs locally with no network and no account.
// Edge TTS is swapped in through a hook that is injected into a temporary copy
// of the Worker, so production code carries no test seams.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-jobs-test-"));
fs.copyFileSync(path.join(here, "personal-auth.js"), path.join(tmpDir, "personal-auth.js"));

const SYNTH_ANCHOR = "async function synthesize(text, voice, ratePct, pitchHz) {\n  const connectionId";
const source = fs.readFileSync(path.join(here, "tts-worker.js"), "utf8");
assert.ok(source.includes(SYNTH_ANCHOR), "synthesize() signature changed — update this harness");
fs.writeFileSync(
  path.join(tmpDir, "tts-worker.js"),
  source.replace(
    SYNTH_ANCHOR,
    "async function synthesize(text, voice, ratePct, pitchHz) {\n" +
      "  if (globalThis.__TEST_SYNTH) return globalThis.__TEST_SYNTH(text, voice, ratePct, pitchHz);\n" +
      "  const connectionId"
  )
);
const { default: worker } = await import(pathToFileURL(path.join(tmpDir, "tts-worker.js")).href);
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

// Quieten the tick logging; the assertions are the output that matters.
console.log = ((real) => (...args) =>
  String(args[0]).startsWith("tts job tick") ? undefined : real(...args))(console.log);

const ORIGIN = "https://my-wellness-os.com";

// ---- fake R2 ----
function makeBucket() {
  const store = new Map();
  const writes = [];
  const toBytes = (v) =>
    typeof v === "string" ? new TextEncoder().encode(v)
    : v instanceof Uint8Array ? new Uint8Array(v)
    : v instanceof ArrayBuffer ? new Uint8Array(v)
    : new Uint8Array(v);
  let seq = 0;
  return {
    store,
    writes,
    async put(key, value, opts) {
      store.set(key, { bytes: toBytes(value), uploaded: new Date(Date.now() + seq++).toISOString(), opts });
      writes.push(key);
      return { key };
    },
    async get(key, opts) {
      const e = store.get(key);
      if (!e) return null;
      let bytes = e.bytes;
      if (opts?.range) {
        const { offset = 0, length = bytes.byteLength - offset } = opts.range;
        bytes = bytes.subarray(offset, offset + length);
      }
      return {
        size: bytes.byteLength,
        async text() { return new TextDecoder().decode(bytes); },
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      };
    },
    async head(key) { const e = store.get(key); return e ? { size: e.bytes.byteLength } : null; },
    async delete(key) { store.delete(key); },
    async list({ prefix = "", limit = 1000 } = {}) {
      const objects = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .slice(0, limit)
        .map(([key, e]) => ({ key, uploaded: e.uploaded }));
      return { objects, truncated: false };
    },
  };
}

// ---- fake Notion proxy ----
function makeNotion() {
  const pages = new Map();
  return {
    pages,
    fetch: async (url, init) => {
      const u = new URL(url);
      if (init.method === "POST" && u.pathname === "/notion/pages") {
        const id = `page-${pages.size + 1}`;
        pages.set(id, { status: "pending", body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      const m = /^\/notion\/pages\/(.+)$/.exec(u.pathname);
      if (init.method === "PATCH" && m) {
        const page = pages.get(m[1]);
        const props = JSON.parse(init.body).properties;
        page.status = props.Status.select.name;
        page.props = props;
        return new Response("{}", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    },
  };
}

function makeEnv() {
  const bucket = makeBucket();
  const notion = makeNotion();
  return {
    AUDIO_BUCKET: bucket,
    NOTION_PROXY: notion,
    AUDIO_LIBRARY_DB_ID: "db",
    AUDIO_PUBLIC_BASE_URL: "https://tts.example.workers.dev/audio",
    PERSONAL_AUTH_SECRET: "s",
    AUTH_DISABLED: "true",
    __notion: notion,
    __bucket: bucket,
  };
}

async function tick(env) {
  const tasks = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
}

async function createJob(env, body) {
  const resp = await worker.fetch(
    new Request("https://tts/api/tts/jobs", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env
  );
  return { status: resp.status, data: await resp.json() };
}

async function getJob(env, id) {
  const resp = await worker.fetch(
    new Request(`https://tts/api/tts/jobs/${id}`, { headers: { Origin: ORIGIN } }),
    env
  );
  return (await resp.json()).job;
}

const para = (n, seed) => (`${seed} the quick brown fox jumps over the lazy dog. `).repeat(n).trim();

// Deterministic fake audio: 100 bytes per 100 chars, first byte tags the text.
function fakeAudio(text) {
  const len = Math.max(64, Math.round(text.length / 4));
  const out = new Uint8Array(len);
  out.fill(text.charCodeAt(0) % 256);
  return out;
}

let failPlan = {};   // text-prefix -> remaining failures
let synthLog = [];    // audio returned, in call order
globalThis.__TEST_SYNTH = async (text) => {
  const key = text.slice(0, 12);
  if (failPlan[key] > 0) { failPlan[key] -= 1; throw new Error("simulated Edge TTS hang"); }
  const audio = fakeAudio(text);
  synthLog.push(audio);
  return audio;
};

// ============ test 1: happy path, multi-chunk chapters ============
{
  const env = makeEnv();
  const chapters = [
    { title: "Chapter 1", text: para(40, "a") },     // ~1.8k -> 1 chunk
    { title: "Chapter 2", text: [para(40,"b"),para(40,"b"),para(40,"b")].join("\n\n") }, // multi-chunk
  ];
  const { status, data } = await createJob(env, { book: "Test Book", voice: "en-US-SteffanNeural", rate: 0, chapters });
  assert.equal(status, 200, "job create ok");
  const id = data.job.id;

  let ticks = 0;
  let job = await getJob(env, id);
  while (job.status === "active" && ticks < 20) { await tick(env); ticks++; job = await getJob(env, id); }

  assert.equal(job.status, "done", "job finished");
  assert.equal(job.done, 2, "both chapters done");
  assert.equal(job.errored, 0, "no errors");
  assert.equal([...env.__notion.pages.values()].filter(p => p.status === "ready").length, 2, "two ready Notion rows");

  // final audio == concatenation of the chunk audio, and job scratch is cleaned up
  const libKeys = [...env.__bucket.store.keys()].filter(k => k.startsWith("library/"));
  assert.equal(libKeys.length, 2, "two library objects");
  const leftovers = [...env.__bucket.store.keys()].filter(k => k.startsWith("jobs/text/") || k.startsWith("jobs/audio/"));
  assert.deepEqual(leftovers, [], "scratch cleaned up");
  const active = [...env.__bucket.store.keys()].filter(k => k.startsWith("jobs/active/"));
  assert.deepEqual(active, [], "no active manifest left");

  const ch2 = await env.__bucket.get(libKeys.find(k => true));
  assert.ok((await ch2.arrayBuffer()).byteLength > 0, "audio stored");
  console.log(`test 1 happy path: OK (${ticks} ticks)`);
}

// ============ test 2: transient chunk failures recover across ticks ============
{
  const env = makeEnv();
  failPlan = {};
  const text = para(40, "c");
  failPlan[text.slice(0, 12)] = 3; // fails 3x (1 retry inside synthesizeWithRetry => 2 per attempt)
  const { data } = await createJob(env, { book: "Flaky", voice: "v", rate: 0, chapters: [{ title: "Ch", text }] });
  let job = await getJob(env, data.job.id), ticks = 0;
  while (job.status === "active" && ticks < 20) { await tick(env); ticks++; job = await getJob(env, data.job.id); }
  assert.equal(job.status, "done");
  assert.equal(job.done, 1, "recovered after transient failures");
  console.log(`test 2 transient failure recovery: OK (${ticks} ticks)`);
}

// ============ test 3: permanent failure marks the chapter error and moves on ============
{
  const env = makeEnv();
  failPlan = {};
  const bad = para(40, "d");
  failPlan[bad.slice(0, 12)] = 999;
  const good = para(40, "e");
  const { data } = await createJob(env, {
    book: "Partly broken", voice: "v", rate: 0,
    chapters: [{ title: "Bad", text: bad }, { title: "Good", text: good }],
  });
  let job = await getJob(env, data.job.id), ticks = 0;
  while (job.status === "active" && ticks < 30) { await tick(env); ticks++; job = await getJob(env, data.job.id); }
  assert.equal(job.status, "done", "job still completes");
  assert.equal(job.errored, 1, "bad chapter marked error");
  assert.equal(job.done, 1, "good chapter still rendered");
  assert.equal(job.chapters[0].status, "error");
  assert.ok(job.chapters[0].error.includes("simulated"), "error text surfaced: " + job.chapters[0].error);
  const errored = [...env.__notion.pages.values()].filter(p => p.status === "error");
  assert.equal(errored.length, 1, "Notion row marked error (not left pending)");
  console.log(`test 3 permanent failure: OK (${ticks} ticks)`);
}

// ============ test 4: cancel stops the job ============
{
  const env = makeEnv();
  failPlan = {};
  const chapters = Array.from({ length: 5 }, (_, i) => ({ title: `Ch ${i + 1}`, text: para(40, String.fromCharCode(102 + i)) }));
  const { data } = await createJob(env, { book: "Cancelled", voice: "v", rate: 0, chapters });
  const id = data.job.id;
  await tick(env);
  const resp = await worker.fetch(new Request(`https://tts/api/tts/jobs/${id}/cancel`, { method: "POST", headers: { Origin: ORIGIN } }), env);
  assert.equal(resp.status, 200, "cancel accepted");
  await tick(env);
  const job = await getJob(env, id);
  assert.equal(job.status, "cancelled", "job cancelled, got " + job.status);
  const active = [...env.__bucket.store.keys()].filter(k => k.startsWith("jobs/active/"));
  assert.deepEqual(active, [], "cancelled job removed from the active queue");
  const scratch = [...env.__bucket.store.keys()].filter(k => k.startsWith("jobs/audio/"));
  assert.deepEqual(scratch, [], "cancelled job left no audio scratch behind");
  const stranded = [...env.__notion.pages.values()].filter(p => p.status === "pending");
  assert.deepEqual(stranded, [], "no Notion row left stranded on pending");
  console.log("test 4 cancel: OK");
}

// ============ test 5: health + validation ============
{
  const env = makeEnv();
  const health = await worker.fetch(new Request("https://tts/api/tts/health"), env);
  const hd = await health.json();
  assert.ok(hd.features.includes("backgroundJobs") && hd.features.includes("libraryUpload"), "health advertises features");

  const bad = await createJob(env, { book: "", chapters: [] });
  assert.equal(bad.status, 400, "empty job rejected");
  const noText = await createJob(env, { book: "b", chapters: [{ title: "t", text: "  " }] });
  assert.equal(noText.status, 400, "empty chapter text rejected");
  console.log("test 5 health + validation: OK");
}

// ============ test 6: long chapter spans ticks; audio is ordered and complete ============
{
  const env = makeEnv();
  failPlan = {};
  synthLog = [];
  // ~60k chars in one chapter => ~20 chunks at the Worker's 3000-char target,
  // which cannot fit in a single tick's subrequest budget.
  const longText = Array.from({ length: 30 }, (_, i) => para(45, String.fromCharCode(97 + (i % 26)))).join("\n\n");
  const { data } = await createJob(env, { book: "Long", voice: "v", rate: 0, chapters: [{ title: "Monster", text: longText }] });
  const id = data.job.id;
  let job = await getJob(env, id), ticks = 0;
  while (job.status === "active" && ticks < 40) { await tick(env); ticks++; job = await getJob(env, id); }

  assert.equal(job.status, "done", "long chapter completed");
  assert.ok(ticks > 1, `took more than one tick (took ${ticks})`);
  assert.equal(job.done, 1);

  const libKey = [...env.__bucket.store.keys()].find(k => k.startsWith("library/"));
  const stored = new Uint8Array(await (await env.__bucket.get(libKey)).arrayBuffer());
  const expected = (() => {
    let total = 0;
    for (const a of synthLog) total += a.byteLength;
    const merged = new Uint8Array(total);
    let off = 0;
    for (const a of synthLog) { merged.set(a, off); off += a.byteLength; }
    return merged;
  })();
  assert.equal(stored.byteLength, expected.byteLength, "stored audio length matches every rendered chunk");
  assert.ok(Buffer.from(stored).equals(Buffer.from(expected)), "chunks stored in render order, nothing dropped or duplicated");
  console.log(`test 6 multi-tick long chapter: OK (${ticks} ticks, ${synthLog.length} chunks, ${stored.byteLength} bytes)`);
}

// ============ test 7: chapter with more chunks than one tick's budget ============
{
  const env = makeEnv();
  failPlan = {};
  synthLog = [];
  // ~120k chars => ~40 chunks, more than the 40-subrequest tick budget can
  // finalize under the naive guard. Must still complete.
  const huge = Array.from({ length: 60 }, (_, i) => para(45, String.fromCharCode(97 + (i % 26)))).join("\n\n");
  const { data } = await createJob(env, { book: "Huge", voice: "v", rate: 0, chapters: [{ title: "Whale", text: huge }] });
  const id = data.job.id;
  let job = await getJob(env, id), ticks = 0;
  while (job.status === "active" && ticks < 60) { await tick(env); ticks++; job = await getJob(env, id); }
  assert.equal(job.status, "done", `huge chapter completed (status ${job.status} after ${ticks} ticks)`);
  const libKey = [...env.__bucket.store.keys()].find(k => k.startsWith("library/"));
  const stored = new Uint8Array(await (await env.__bucket.get(libKey)).arrayBuffer());
  let total = 0;
  for (const a of synthLog) total += a.byteLength;
  assert.equal(stored.byteLength, total, "every chunk made it into the file");
  console.log(`test 7 oversized chapter: OK (${ticks} ticks, ${synthLog.length} chunks)`);
}

// ============ test 8: queueing a long book is cheap in subrequests ============
{
  const env = makeEnv();
  failPlan = {};
  const chapters = Array.from({ length: 60 }, (_, i) => ({
    title: `Chapter ${i + 1}`,
    text: para(20, String.fromCharCode(97 + (i % 26))),
  }));
  const before = env.__bucket.writes.length;
  const { status, data } = await createJob(env, { book: "Long book", voice: "v", rate: 0, chapters });
  assert.equal(status, 200, "60-chapter book queued");
  const writes = env.__bucket.writes.length - before;
  // Workers Free allows 50 subrequests per request; one write per chapter would blow it.
  assert.ok(writes <= 5, `queueing wrote ${writes} objects, expected a handful`);

  // And the byte ranges still resolve to the right chapter text.
  let job = await getJob(env, data.job.id), ticks = 0;
  while (job.status === "active" && ticks < 40) { await tick(env); ticks++; job = await getJob(env, data.job.id); }
  assert.equal(job.status, "done", `long book completed after ${ticks} ticks`);
  assert.equal(job.done, 60, "every chapter rendered");
  assert.equal(job.errored, 0, "no chapter errored");
  const libCount = [...env.__bucket.store.keys()].filter(k => k.startsWith("library/")).length;
  assert.equal(libCount, 60, "60 library objects");
  console.log(`test 8 long book queueing: OK (${writes} writes to queue, ${ticks} ticks to render)`);
}

console.log("\nALL JOB-RUNNER TESTS PASSED");
