// Direct Notion API proxy for the Reading module.
// Uses NOTION_TOKEN env var — no dependency on the Cloudflare Worker.
// The integration must have access to the Books DB and Taste Profile page.

const NOTION_BASE = "https://api.notion.com";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    response.status(500).json({
      error:
        "NOTION_TOKEN not configured. Add it in Vercel Environment Variables."
    });
    return;
  }

  const { path, method = "GET", body } = request.body || {};

  if (typeof path !== "string" || !path.startsWith("/v1/")) {
    response.status(400).json({ error: "Invalid Notion path" });
    return;
  }

  const notionResponse = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28"
    },
    body: ["GET", "HEAD"].includes(method)
      ? undefined
      : JSON.stringify(body || {})
  });

  const text = await notionResponse.text();
  response.status(notionResponse.status);
  response.setHeader(
    "Content-Type",
    notionResponse.headers.get("Content-Type") || "application/json"
  );
  response.send(text);
}
