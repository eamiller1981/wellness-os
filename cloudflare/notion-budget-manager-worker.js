import { authorizePersonalRequest } from "./personal-auth.js";

const NOTION_API = "https://api.notion.com/v1";
const DEFAULT_NOTION_VERSION = "2022-06-28";

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

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin)
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const internalAuth = request.headers.get("X-Internal-Auth") || "";
    const trustedInternalRequest = Boolean(
      internalAuth &&
      env.PERSONAL_AUTH_SECRET &&
      internalAuth === env.PERSONAL_AUTH_SECRET
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

    const url = new URL(request.url);
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
  }
};
