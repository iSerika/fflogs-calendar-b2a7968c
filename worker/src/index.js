const sessionCookieName = "fflogs_calendar_admin";
const stateCookieName = "fflogs_calendar_oauth_state";
const sessionMaxAgeSeconds = 12 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), request, env);

    try {
      if (request.method === "GET" && url.pathname === "/session") return withCors(await handleSession(request, env), request, env);
      if (request.method === "GET" && url.pathname === "/auth/github/start") return await handleGithubStart(request, env);
      if (request.method === "GET" && url.pathname === "/auth/github/callback") return await handleGithubCallback(request, env);
      if (request.method === "POST" && url.pathname === "/update") return withCors(await handleUpdate(request, env), request, env);
      if (request.method === "GET" && url.pathname === "/update/status") return withCors(await handleUpdateStatus(request, env), request, env);
      if (request.method === "POST" && url.pathname === "/logout") return withCors(await handleLogout(), request, env);
      return withCors(json({ error: "not_found" }, 404), request, env);
    } catch (error) {
      return withCors(json({ error: error.status === 403 ? "forbidden" : "server_error", message: error.message }, error.status || 500), request, env);
    }
  },
};

async function handleSession(request, env) {
  const session = await readSession(request, env);
  return json({
    authenticated: Boolean(session),
    login: session?.login || "",
    admin: isAdmin(session?.login, env),
  });
}

async function handleGithubStart(request, env) {
  assertConfigured(env, ["GITHUB_CLIENT_ID"]);
  const state = randomString();
  const callbackUrl = new URL("/auth/github/callback", request.url).toString();
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("scope", "read:user");
  authUrl.searchParams.set("state", state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `${stateCookieName}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function handleGithubCallback(request, env) {
  assertConfigured(env, ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SESSION_SECRET"]);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = getCookie(request, stateCookieName);
  if (!code || !state || state !== expectedState) return redirectWithError(env, "github_state");

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "fflogs-calendar-admin-worker",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL("/auth/github/callback", request.url).toString(),
    }),
  });
  const tokenPayload = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenPayload.access_token) return redirectWithError(env, "github_token");

  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenPayload.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fflogs-calendar-admin-worker",
    },
  });
  const user = await userResponse.json();
  if (!userResponse.ok || !user.login) return redirectWithError(env, "github_user");
  if (!isAdmin(user.login, env)) return redirectWithError(env, "not_admin");

  const session = await signSession(
    {
      login: user.login,
      exp: Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds,
    },
    env,
  );

  const headers = new Headers({ Location: env.PAGES_URL });
  headers.append("Set-Cookie", `${sessionCookieName}=${session}; Path=/; Max-Age=${sessionMaxAgeSeconds}; HttpOnly; Secure; SameSite=None`);
  headers.append("Set-Cookie", `${stateCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

async function handleUpdate(request, env) {
  assertConfigured(env, ["GITHUB_DISPATCH_TOKEN"]);
  const session = await requireAdmin(request, env);
  const dispatchResponse = await githubFetch(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_ID}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "master" }),
  });
  if (!dispatchResponse.ok) {
    throw new Error(`workflow_dispatch failed: ${dispatchResponse.status} ${await dispatchResponse.text()}`);
  }
  return json({ ok: true, login: session.login });
}

async function handleUpdateStatus(request, env) {
  assertConfigured(env, ["GITHUB_DISPATCH_TOKEN"]);
  await requireAdmin(request, env);
  const response = await githubFetch(
    env,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_ID}/runs?branch=master&per_page=1`,
  );
  if (!response.ok) throw new Error(`workflow status failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const run = payload.workflow_runs?.[0] || null;
  return json({
    run: run
      ? {
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          htmlUrl: run.html_url,
          createdAt: run.created_at,
          updatedAt: run.updated_at,
        }
      : null,
  });
}

async function handleLogout() {
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None`,
    },
  );
}

async function requireAdmin(request, env) {
  const session = await readSession(request, env);
  if (!session || !isAdmin(session.login, env)) throw Object.assign(new Error("forbidden"), { status: 403 });
  return session;
}

async function readSession(request, env) {
  const cookie = getCookie(request, sessionCookieName);
  if (!cookie) return null;
  const [payloadBase64, signature] = cookie.split(".");
  if (!payloadBase64 || !signature) return null;
  const expected = await hmac(payloadBase64, env.SESSION_SECRET);
  if (signature !== expected) return null;
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadBase64)));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function signSession(payload, env) {
  const payloadBase64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${payloadBase64}.${await hmac(payloadBase64, env.SESSION_SECRET)}`;
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function githubFetch(env, path, init = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fflogs-calendar-admin-worker",
      ...(init.headers || {}),
    },
  });
}

function withCors(response, request, env) {
  const origin = request.headers.get("Origin");
  if (origin === env.ALLOWED_ORIGIN) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function redirectWithError(env, error) {
  const url = new URL(env.PAGES_URL);
  url.searchParams.set("admin_error", error);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `${stateCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

function isAdmin(login, env) {
  return normalize(login) === normalize(env.ADMIN_GITHUB_LOGIN);
}

function assertConfigured(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing Worker configuration: ${missing.join(", ")}`);
}

function getCookie(request, name) {
  const cookies = request.headers.get("Cookie") || "";
  return cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function randomString() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}
