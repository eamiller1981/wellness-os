const WORKER_URL = "https://notion-budget-manager.eamiller1981.workers.dev";
const WORKER_ORIGIN = "https://wellness-os.vercel.app";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { path, method = "GET", body } = request.body || {};

  if (typeof path !== "string" || !path.startsWith("/")) {
    response.status(400).json({ error: "Invalid Notion path" });
    return;
  }

  const notionResponse = await fetch(`${WORKER_URL}/notion${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: WORKER_ORIGIN
    },
    body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(body || {})
  });

  const text = await notionResponse.text();
  response.status(notionResponse.status);
  response.setHeader(
    "Content-Type",
    notionResponse.headers.get("Content-Type") || "application/json"
  );
  response.send(text);
}
