export default async function handler(request, response) {
  response.setHeader("Allow", "POST");
  response.status(410).json({
    error: "Reading chat API is disabled.",
    message:
      "Reading AI now uses the zero-fee Claude routine workflow through Cloudflare and Notion queue records."
  });
}
