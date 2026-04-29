const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64UrlEncode(bytes) {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeJson(value) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function constantTimeEqual(left, right) {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }

  return diff === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return new Uint8Array(signature);
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

export function sessionTtlSeconds() {
  return SESSION_TTL_SECONDS;
}

export async function signPersonalToken(env) {
  if (!env.PERSONAL_AUTH_SECRET) {
    throw new Error("PERSONAL_AUTH_SECRET is not configured.");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: "owner",
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID()
  };
  const payloadPart = base64UrlEncodeJson(payload);
  const signaturePart = base64UrlEncode(await hmac(env.PERSONAL_AUTH_SECRET, payloadPart));

  return {
    token: `${payloadPart}.${signaturePart}`,
    expiresAt: payload.exp * 1000
  };
}

export async function verifyPersonalToken(env, token) {
  if (!env.PERSONAL_AUTH_SECRET || !token || !token.includes(".")) return false;

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return false;

  const expectedSignature = await hmac(env.PERSONAL_AUTH_SECRET, payloadPart);
  let actualSignature;
  try {
    actualSignature = base64UrlDecode(signaturePart);
  } catch {
    return false;
  }

  if (!constantTimeEqual(expectedSignature, actualSignature)) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadPart)));
    return payload.sub === "owner" && Number(payload.exp || 0) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export async function authorizePersonalRequest(request, env) {
  if (env.AUTH_DISABLED === "true") return null;

  const authHeader = request.headers.get("Authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const cookieToken = getCookie(request, "wellness_session");
  const token = bearerToken || cookieToken;

  if (await verifyPersonalToken(env, token)) {
    return null;
  }

  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" }
  });
}

export async function passwordMatches(env, candidate) {
  if (!env.PERSONAL_APP_PASSWORD || !env.PERSONAL_AUTH_SECRET) {
    throw new Error("Personal auth secrets are not configured.");
  }

  const expected = await hmac(env.PERSONAL_AUTH_SECRET, env.PERSONAL_APP_PASSWORD);
  const actual = await hmac(env.PERSONAL_AUTH_SECRET, String(candidate || ""));
  return constantTimeEqual(expected, actual);
}

export function sessionCookie(token) {
  return [
    `wellness_session=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=None"
  ].join("; ");
}

export function clearSessionCookie() {
  return "wellness_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None";
}
