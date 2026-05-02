import {
  clearSessionCookie,
  passwordMatches,
  sessionCookie,
  sessionTtlSeconds,
  signPersonalToken,
  verifyPersonalToken
} from "./personal-auth.js";

const DEFAULT_ORIGIN = "https://wellness-os.vercel.app";
const ALLOWED_ORIGINS = new Set([
  "https://eamiller1981.github.io",
  "https://wellness-os.vercel.app",
  "https://wellness-os-psi.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
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
