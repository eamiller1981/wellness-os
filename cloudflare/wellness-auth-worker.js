import {
  clearSessionCookie,
  passwordMatches,
  sessionCookie,
  sessionTtlSeconds,
  signPersonalToken,
  verifyPersonalToken
} from "./personal-auth.js";
import webpush from "web-push";

const DEFAULT_ORIGIN = "https://wellness-os.vercel.app";
const PUSH_PREFIX = "push:";
const PUSH_TTL_SECONDS = 60 * 60 * 24 * 45;
const encoder = new TextEncoder();
const ALLOWED_ORIGINS = new Set([
  "https://my-wellness-os.com",
  "https://www.my-wellness-os.com",
  "https://eamiller1981.github.io",
  "https://wellness-os.vercel.app",
  "https://wellness-os-psi.vercel.app",
  "https://liz-wellness-os.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
  "http://127.0.0.1:4177",
  "http://localhost:4177",
  "null"
]);

const WELLNESS_PREVIEW_ORIGIN =
  /^https:\/\/wellness-[a-z0-9-]+-eamiller1981-3240s-projects\.vercel\.app$/;

function isAllowedOrigin(origin) {
  return Boolean(origin) && (ALLOWED_ORIGINS.has(origin) || WELLNESS_PREVIEW_ORIGIN.test(origin));
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    Vary: "Origin"
  };
}

function jsonResponse(body, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin),
      ...extraHeaders
    }
  });
}

async function readJson(request) {
  if (!request.headers.get("Content-Type")?.includes("application/json")) return {};
  return request.json();
}

function bearerToken(request) {
  const authHeader = request.headers.get("Authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
}

async function ownerAuthorized(request, env) {
  return verifyPersonalToken(env, bearerToken(request));
}

function unauthorized(origin) {
  return jsonResponse({ ok: false, error: "Unauthorized" }, 401, origin);
}

function requirePushConfig(env) {
  if (!env.WELLNESS_PUSH_SUBSCRIPTIONS) {
    throw new Error("WELLNESS_PUSH_SUBSCRIPTIONS is not configured.");
  }

  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("VAPID keys are not configured.");
  }

  webpush.setVapidDetails(
    env.VAPID_SUBJECT || "mailto:eamiller1981@gmail.com",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
}

function base64Url(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function subscriptionKey(subscription) {
  const endpoint = subscription?.endpoint;
  if (!endpoint || typeof endpoint !== "string") return "";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(endpoint));
  return `${PUSH_PREFIX}${base64Url(new Uint8Array(digest))}`;
}

function validSubscription(subscription) {
  return Boolean(
    subscription &&
    typeof subscription.endpoint === "string" &&
    subscription.keys &&
    typeof subscription.keys.p256dh === "string" &&
    typeof subscription.keys.auth === "string"
  );
}

async function saveSubscription(env, subscription) {
  if (!validSubscription(subscription)) {
    throw new Error("Invalid push subscription.");
  }

  const key = await subscriptionKey(subscription);
  await env.WELLNESS_PUSH_SUBSCRIPTIONS.put(
    key,
    JSON.stringify({
      subscription,
      updatedAt: new Date().toISOString()
    }),
    { expirationTtl: PUSH_TTL_SECONDS }
  );

  return key;
}

async function deleteSubscription(env, subscription) {
  const key = await subscriptionKey(subscription);
  if (key) await env.WELLNESS_PUSH_SUBSCRIPTIONS.delete(key);
}

async function listSubscriptions(env) {
  const subscriptions = [];
  let cursor;

  do {
    const page = await env.WELLNESS_PUSH_SUBSCRIPTIONS.list({ prefix: PUSH_PREFIX, cursor });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      const item = await env.WELLNESS_PUSH_SUBSCRIPTIONS.get(key.name, "json");
      if (item?.subscription) {
        subscriptions.push({ key: key.name, subscription: item.subscription });
      }
    }
  } while (cursor);

  return subscriptions;
}

async function sendPush(env, subscription, payload) {
  requirePushConfig(env);
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: 60 * 60
  });
}

async function sendTestPush(env) {
  const subscriptions = await listSubscriptions(env);
  const payload = {
    title: "Wellness OS",
    body: "Notifications are ready.",
    url: "/",
    tag: "wellness-test"
  };
  const results = [];

  for (const item of subscriptions) {
    try {
      await sendPush(env, item.subscription, payload);
      results.push({ key: item.key, ok: true });
    } catch (error) {
      const statusCode = error?.statusCode || error?.status || 0;
      if (statusCode === 404 || statusCode === 410) {
        await env.WELLNESS_PUSH_SUBSCRIPTIONS.delete(item.key);
      }
      results.push({ key: item.key, ok: false, statusCode, message: error?.message || "Push failed" });
    }
  }

  return results;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || DEFAULT_ORIGIN;

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return jsonResponse({ ok: false, error: "Forbidden origin" }, 403, DEFAULT_ORIGIN);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        if (!(await passwordMatches(env, body.password))) {
          return jsonResponse({ ok: false, error: "Invalid password" }, 401, origin);
        }

        const session = await signPersonalToken(env);
        return jsonResponse(
          {
            ok: true,
            token: session.token,
            expiresAt: session.expiresAt,
            expiresIn: sessionTtlSeconds()
          },
          200,
          origin,
          { "Set-Cookie": sessionCookie(session.token) }
        );
      }

      if (request.method === "GET" && url.pathname === "/api/auth/status") {
        const ok = await verifyPersonalToken(env, bearerToken(request));
        return jsonResponse({ ok, expiresIn: ok ? sessionTtlSeconds() : 0 }, ok ? 200 : 401, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        return jsonResponse({ ok: true }, 200, origin, { "Set-Cookie": clearSessionCookie() });
      }

      if (url.pathname.startsWith("/api/push/") && !(await ownerAuthorized(request, env))) {
        return unauthorized(origin);
      }

      if (request.method === "GET" && url.pathname === "/api/push/config") {
        requirePushConfig(env);
        return jsonResponse({ ok: true, publicKey: env.VAPID_PUBLIC_KEY }, 200, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/push/subscribe") {
        requirePushConfig(env);
        const body = await readJson(request);
        await saveSubscription(env, body.subscription);
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/push/unsubscribe") {
        requirePushConfig(env);
        const body = await readJson(request);
        await deleteSubscription(env, body.subscription);
        return jsonResponse({ ok: true }, 200, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/push/test") {
        requirePushConfig(env);
        const results = await sendTestPush(env);
        return jsonResponse(
          {
            ok: results.some((result) => result.ok),
            sent: results.filter((result) => result.ok).length,
            total: results.length,
            results
          },
          200,
          origin
        );
      }

      return jsonResponse({ ok: false, error: "Not found" }, 404, origin);
    } catch (error) {
      return jsonResponse(
        {
          ok: false,
          error: error.message || "Unexpected auth error"
        },
        500,
        origin
      );
    }
  }
};
