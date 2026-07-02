import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const reportsPath = path.join(rootDir, "config", "reports.json");

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  const env = await readEnv(path.join(rootDir, ".env"));
  const config = JSON.parse(await fs.readFile(reportsPath, "utf8"));
  const target = config.target || {};
  const aliases = new Set([target.name, ...(target.aliases || [])].filter(Boolean).map((value) => normalize(value)));
  if (!aliases.size) aliases.add("dancing mad");

  const accessToken = await getUserAccessToken(env);
  const currentUserPayload = await graphQl(accessToken, `query { userData { currentUser { id name } } }`);
  const user = currentUserPayload.userData?.currentUser;
  if (!user?.id) throw new Error("FFLogs user token did not return currentUser.");

  const startTime = getStartTime(config);
  const endTime = Date.now() + 24 * 60 * 60 * 1000;
  const reports = await fetchReportsForUser(accessToken, user.id, startTime, endTime);
  const matchingReports = reports.filter((report) => aliases.has(normalize(report.title)));

  const existingByCode = new Map((config.reports || []).map((report) => [report.code || extractCode(report.url), report]));
  let added = 0;
  for (const report of matchingReports) {
    if (!report.code || existingByCode.has(report.code)) continue;
    existingByCode.set(report.code, {
      url: `https://www.fflogs.com/reports/${report.code}`,
      code: report.code,
      activityDate: dateKey(report.startTime),
      note: `${new Date(Number(report.startTime)).toISOString()} / ${formatDuration(Number(report.endTime) - Number(report.startTime))} / ${report.visibility || ""}`.trim(),
      includeFightIds: [],
      excludeFightIds: [],
      encounterIds: [],
    });
    added += 1;
  }

  config.reports = [...existingByCode.values()]
    .filter((report) => report.code && report.code !== "REPLACE_WITH_REPORT_CODE")
    .sort((a, b) => String(b.activityDate || "").localeCompare(String(a.activityDate || "")) || String(b.code).localeCompare(String(a.code)));

  await fs.writeFile(reportsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        user: user.name,
        scannedReports: reports.length,
        matchingReports: matchingReports.length,
        addedReports: added,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
      },
      null,
      2,
    ),
  );
}

async function getUserAccessToken(env) {
  if (env.FFLOGS_USER_ACCESS_TOKEN) return env.FFLOGS_USER_ACCESS_TOKEN;

  const clientId = env.FFLOGS_CLIENT_ID;
  const clientSecret = env.FFLOGS_CLIENT_SECRET;
  const refreshToken = env.FFLOGS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing FFLOGS_CLIENT_ID, FFLOGS_CLIENT_SECRET, or FFLOGS_REFRESH_TOKEN.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", refreshToken);

  const response = await fetch("https://www.fflogs.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) throw new Error(`FFLogs refresh failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  if (!payload.access_token) throw new Error("FFLogs refresh did not return access_token.");
  return payload.access_token;
}

function getStartTime(config) {
  const configured = config.personalSync?.startDate || config.guildSync?.startDate;
  if (configured) return new Date(`${configured}T00:00:00Z`).getTime();
  const starts = (config.reports || [])
    .map((report) => report.activityDate)
    .filter(Boolean)
    .map((date) => new Date(`${date}T00:00:00Z`).getTime())
    .filter(Number.isFinite);
  return starts.length ? Math.min(...starts) - 7 * 24 * 60 * 60 * 1000 : Date.now() - 90 * 24 * 60 * 60 * 1000;
}

async function fetchReportsForUser(token, userId, startTime, endTime) {
  const all = [];
  let page = 1;
  while (true) {
    const payload = await graphQl(
      token,
      `
        query Reports($userId: Int!, $page: Int!, $startTime: Float!, $endTime: Float!) {
          reportData {
            reports(userID: $userId, page: $page, limit: 100, startTime: $startTime, endTime: $endTime) {
              data {
                code
                title
                startTime
                endTime
                visibility
                owner { id name }
              }
              has_more_pages
            }
          }
        }
      `,
      { userId: Number(userId), page, startTime, endTime },
    );
    const pageData = payload.reportData?.reports;
    all.push(...(pageData?.data || []));
    if (!pageData?.has_more_pages) break;
    page += 1;
  }
  return all;
}

async function graphQl(token, query, variables = {}) {
  const response = await fetch("https://www.fflogs.com/api/v2/user", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`FFLogs GraphQL failed: ${message}`);
  }
  return payload.data;
}

async function readEnv(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const env = { ...process.env };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function extractCode(url) {
  return String(url || "").match(/\/reports\/([^/?#]+)/)?.[1] || "";
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function dateKey(value) {
  return new Date(Number(value)).toISOString().slice(0, 10);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0 minutes";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hours ${rest} minutes` : `${hours} hours`;
}
