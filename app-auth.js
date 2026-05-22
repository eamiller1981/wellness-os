(function () {
  const AUTH_URL = window.WELLNESS_AUTH_URL || "https://wellness-auth.eamiller1981.workers.dev";
  const SESSION_DAYS = 30;
  const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
  const TOKEN_KEY = "wellnessAuthToken";
  const EXPIRES_KEY = "wellnessAuthExpiresAt";
  const LOCAL_PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
  const FORCE_LOCAL_AUTH = new URLSearchParams(window.location.search).has("auth");
  const IS_LOCAL_PREVIEW = LOCAL_PREVIEW_HOSTS.has(window.location.hostname) && !FORCE_LOCAL_AUTH;
  const originalFetch = window.fetch.bind(window);
  let stylesInjected = false;
  let authReadyResolved = false;
  let resolveAuthReady;
  const authReady = new Promise((resolve) => {
    resolveAuthReady = resolve;
  });

  function markAuthReady() {
    if (authReadyResolved) return;
    authReadyResolved = true;
    resolveAuthReady();
    window.dispatchEvent(new CustomEvent("wellness-auth-ready"));
  }

  function decodeBase64Url(value) {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return atob(padded);
  }

  function tokenExpiresAt(token) {
    try {
      const payload = JSON.parse(decodeBase64Url(String(token).split(".")[0] || ""));
      return Number(payload.exp || 0) * 1000;
    } catch {
      return 0;
    }
  }

  function getToken() {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    const expiresAt = Number(localStorage.getItem(EXPIRES_KEY) || tokenExpiresAt(token));
    if (!token || !expiresAt || expiresAt <= Date.now()) {
      clearToken();
      return "";
    }
    return token;
  }

  function saveToken(token, expiresAt) {
    const fallback = Date.now() + SESSION_MS;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EXPIRES_KEY, String(expiresAt || tokenExpiresAt(token) || fallback));
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
  }

  function shouldAttachAuth(url) {
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) return true;
    if (url.origin === AUTH_URL) return true;
    return [
      "skincare.eamiller1981.workers.dev",
      "notion-budget-manager.eamiller1981.workers.dev",
      "wellness-auth.eamiller1981.workers.dev",
      "tts.eamiller1981.workers.dev"
    ].includes(url.hostname);
  }

  window.fetch = function wellnessFetch(input, init) {
    const requestUrl = typeof input === "string" ? input : input && input.url;
    const url = new URL(requestUrl || window.location.href, window.location.href);
    const protectedRequest = shouldAttachAuth(url);
    const token = getToken();

    if (!protectedRequest) {
      return originalFetch(input, init);
    }

    const nextInit = { ...(init || {}) };
    nextInit.credentials = nextInit.credentials || "include";

    if (token) {
      const headers = new Headers(nextInit.headers || (typeof input !== "string" && input ? input.headers : undefined));
      headers.set("Authorization", `Bearer ${token}`);
      nextInit.headers = headers;
    }

    return originalFetch(input, nextInit).then((response) => {
      const isLoginRequest = url.origin === AUTH_URL && url.pathname.endsWith("/api/auth/login");
      if (response.status === 401 && !isLoginRequest && !IS_LOCAL_PREVIEW) {
        clearToken();
        showLock("Session expired.");
      }
      return response;
    }).catch((error) => {
      throw error;
    });
  };

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;

    const style = document.createElement("style");
    style.textContent = `
      .wellness-auth-lock {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 18px;
        background: rgba(245, 234, 227, 0.96);
        color: #403534;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .wellness-auth-panel {
        width: min(420px, 100%);
        border: 1px solid rgba(128, 111, 100, 0.2);
        border-radius: 18px;
        background: rgba(255, 250, 246, 0.92);
        box-shadow: 0 18px 48px rgba(80, 60, 50, 0.12);
        padding: 22px;
      }
      .wellness-auth-title {
        margin: 0 0 6px;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 2rem;
        font-weight: 400;
      }
      .wellness-auth-copy {
        margin: 0 0 18px;
        color: #806f64;
        line-height: 1.5;
      }
      .wellness-auth-form {
        display: grid;
        gap: 10px;
      }
      .wellness-auth-form input {
        width: 100%;
        min-height: 46px;
        border: 1px solid rgba(128, 111, 100, 0.22);
        border-radius: 10px;
        background: #fffaf6;
        color: #403534;
        font: inherit;
        padding: 0 12px;
      }
      .wellness-auth-form button {
        min-height: 46px;
        border: 1px solid #806f64;
        border-radius: 999px;
        background: #806f64;
        color: #fffaf6;
        font: inherit;
        font-weight: 700;
      }
      .wellness-auth-error {
        min-height: 20px;
        color: #8d3030;
        font-size: 0.9rem;
      }
      .wellness-refresh-button {
        position: fixed;
        right: 14px;
        bottom: calc(14px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483000;
        min-height: 38px;
        padding: 0 13px;
        border: 1px solid rgba(128, 111, 100, 0.24);
        border-radius: 999px;
        background: rgba(255, 250, 246, 0.86);
        color: #806f64;
        box-shadow: 0 10px 26px rgba(80, 60, 50, 0.1);
        font: 700 0.82rem ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(12px);
      }
      .wellness-refresh-button:disabled {
        opacity: 0.72;
      }
      .wellness-notify-button {
        position: fixed;
        left: 14px;
        bottom: calc(14px + env(safe-area-inset-bottom, 0px));
        z-index: 2147483000;
        min-height: 38px;
        padding: 0 13px;
        border: 1px solid rgba(128, 111, 100, 0.24);
        border-radius: 999px;
        background: rgba(255, 250, 246, 0.86);
        color: #806f64;
        box-shadow: 0 10px 26px rgba(80, 60, 50, 0.1);
        font: 700 0.82rem ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(12px);
      }
      .wellness-notify-button:disabled {
        opacity: 0.72;
      }
    `;
    document.head.appendChild(style);
  }

  function showLock(message) {
    if (document.querySelector(".wellness-auth-lock")) return;
    injectStyles();

    const lock = document.createElement("div");
    lock.className = "wellness-auth-lock";
    lock.innerHTML = `
      <section class="wellness-auth-panel" aria-labelledby="wellness-auth-title">
        <h1 class="wellness-auth-title" id="wellness-auth-title">Wellness OS</h1>
        <p class="wellness-auth-copy">Enter your personal app password. This device will stay signed in for ${SESSION_DAYS} days.</p>
        <form class="wellness-auth-form">
          <input type="password" name="password" autocomplete="current-password" placeholder="Password" aria-label="Password" required>
          <button type="submit">Unlock</button>
          <div class="wellness-auth-error" role="status">${message || ""}</div>
        </form>
      </section>
    `;
    document.body.appendChild(lock);

    const form = lock.querySelector("form");
    const input = lock.querySelector("input");
    const error = lock.querySelector(".wellness-auth-error");
    input.focus();

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "Checking...";
      try {
        const response = await originalFetch(`${AUTH_URL}/api/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: input.value })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.token) {
          throw new Error(payload.error || "Unlock failed.");
        }
        saveToken(payload.token, payload.expiresAt);
        lock.remove();
        markAuthReady();
        window.dispatchEvent(new CustomEvent("wellness-auth-changed"));
      } catch (errorValue) {
        error.textContent = errorValue.message || "Unlock failed.";
      }
    });
  }

  async function verifyOrLock() {
    if (IS_LOCAL_PREVIEW) {
      markAuthReady();
      return authReady;
    }

    const token = getToken();
    if (!token) {
      showLock();
      return authReady;
    }

    markAuthReady();

    fetch(`${AUTH_URL}/api/auth/status`, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Session expired.");
        }
      })
      .catch((error) => {
        clearToken();
        showLock(error && error.message ? error.message : "Unable to verify session.");
      });

    return authReady;
  }

  async function refreshApp(button) {
    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing";
    }

    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        registrations.map(async (registration) => {
          await registration.update().catch(() => {});
          const worker = registration.waiting || registration.installing || registration.active;
          if (worker) worker.postMessage({ type: "WELLNESS_REFRESH" });
        })
      );
    }

    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("wellness-os-")).map((key) => caches.delete(key)));
    }

    window.location.reload();
  }

  function installRefreshButton() {
    if (document.querySelector(".wellness-refresh-button")) return;
    injectStyles();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wellness-refresh-button";
    button.textContent = "Refresh";
    button.setAttribute("aria-label", "Refresh Wellness OS");
    button.addEventListener("click", () => {
      refreshApp(button).catch(() => window.location.reload());
    });
    document.body.appendChild(button);
  }

  function pushSupported() {
    return Boolean(
      window.isSecureContext &&
      "Notification" in window &&
      "PushManager" in window &&
      "serviceWorker" in navigator
    );
  }

  function base64UrlToUint8Array(base64Url) {
    const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
    const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function enableNotifications(button) {
    if (!pushSupported()) {
      button.textContent = "Unsupported";
      return;
    }

    button.disabled = true;
    button.textContent = "Checking";
    await authReady;

    if (Notification.permission === "denied") {
      button.textContent = "Blocked";
      return;
    }

    const permission = Notification.permission === "granted"
      ? "granted"
      : await Notification.requestPermission();

    if (permission !== "granted") {
      button.disabled = false;
      button.textContent = "Notify";
      return;
    }

    button.textContent = "Subscribing";
    const configResponse = await fetch(`${AUTH_URL}/api/push/config`, { credentials: "include" });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok || !config.publicKey) {
      throw new Error(config.error || "Push config unavailable.");
    }

    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(config.publicKey)
      });
    }

    const subscribeResponse = await fetch(`${AUTH_URL}/api/push/subscribe`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription })
    });
    if (!subscribeResponse.ok) {
      const payload = await subscribeResponse.json().catch(() => ({}));
      throw new Error(payload.error || "Push subscribe failed.");
    }

    button.textContent = "Sending test";
    await fetch(`${AUTH_URL}/api/push/test`, {
      method: "POST",
      credentials: "include"
    }).catch(() => {});

    button.textContent = "Notifications on";
  }

  async function syncNotificationButton(button) {
    if (!pushSupported()) {
      button.hidden = true;
      return;
    }

    if (Notification.permission === "denied") {
      button.textContent = "Blocked";
      button.disabled = true;
      return;
    }

    const registration = await navigator.serviceWorker.ready.catch(() => null);
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    button.textContent = subscription && Notification.permission === "granted" ? "Notifications on" : "Notify";
  }

  function installNotificationButton() {
    if (document.querySelector(".wellness-notify-button")) return;
    injectStyles();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "wellness-notify-button";
    button.textContent = "Notify";
    button.setAttribute("aria-label", "Enable Wellness OS notifications");
    button.addEventListener("click", () => {
      enableNotifications(button)
        .catch((error) => {
          button.disabled = false;
          button.textContent = error && error.message ? "Try again" : "Notify";
        });
    });
    document.body.appendChild(button);
    syncNotificationButton(button).catch(() => {});
  }

  window.WellnessAuth = {
    ready: authReady,
    enableNotifications: async function enableWellnessNotifications() {
      const button = document.querySelector(".wellness-notify-button");
      return enableNotifications(button || { disabled: false, textContent: "" });
    },
    logout: async function logout() {
      clearToken();
      await originalFetch(`${AUTH_URL}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
      window.location.reload();
    },
    token: getToken
  };

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register(new URL("sw.js", window.location.href)).catch(() => {});
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      installRefreshButton();
      installNotificationButton();
      verifyOrLock();
    });
  } else {
    installRefreshButton();
    installNotificationButton();
    verifyOrLock();
  }
})();
