import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configDir = path.join(rootDir, "config");
const dataDir = path.join(rootDir, "data");
const cacheDir = path.join(dataDir, "cache", "reports");

const paths = {
  env: path.join(rootDir, ".env"),
  reports: path.join(configDir, "reports.json"),
  phases: path.join(configDir, "phase-rules.json"),
  overrides: path.join(dataDir, "manual-overrides.json"),
  outJson: path.join(dataDir, "calendar-data.json"),
  outJs: path.join(dataDir, "calendar-data.js"),
};

const command = process.argv[2] || "fetch";
const cliOptions = parseCliOptions(process.argv.slice(3));
const damageDownAbilityIds = [1002911];

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function main() {
  if (command === "fetch") {
    await fetchReports();
    return;
  }

  if (command === "sync-guild") {
    await syncGuildReports();
    return;
  }

  console.log("Usage:");
  console.log("  node scripts/fetch-fflogs.mjs fetch");
  console.log("  node scripts/fetch-fflogs.mjs sync-guild");
}

async function fetchReports() {
  const [env, reportsConfig, phaseRules, manualOverrides] = await Promise.all([
    readEnv(paths.env),
    readJson(paths.reports),
    readJson(paths.phases),
    readJson(paths.overrides).catch(() => ({ overrides: {} })),
  ]);

  const token = await getAccessToken(env);
  const reportInputs = normalizeReportInputs(reportsConfig);
  const pulls = [];
  const warnings = [];

  for (const input of reportInputs) {
    if (!input.code || input.code === "REPLACE_WITH_REPORT_CODE") {
      warnings.push("reports.json contains a sample report entry; skipped it.");
      continue;
    }

    const bundle = await loadOrFetchReportBundle({ token, input, reportsConfig, warnings });
    const report = bundle.report;
    const fights = bundle.fights || [];
    const deathsByFight = objectToEventMap(bundle.deathsByFight || {});
    const damageDownsByFight = objectToEventMap(bundle.damageDownsByFight || {});

    for (const fight of fights) {
      pulls.push(
        buildPull({
          report,
          fight,
          deaths: deathsByFight.get(Number(fight.id)) || [],
          damageDowns: damageDownsByFight.get(Number(fight.id)) || [],
          input,
          phaseRules,
          manualOverrides: manualOverrides.overrides || {},
          timezone: reportsConfig.timezone || phaseRules.timezone || "Asia/Tokyo",
        }),
      );
    }
  }

  const output = buildCalendarData({
    pulls,
    reportsConfig,
    phaseRules,
    warnings,
  });

  await writeCalendarData(output);
  console.log(`Wrote ${path.relative(process.cwd(), paths.outJson)}`);
  console.log(`Wrote ${path.relative(process.cwd(), paths.outJs)}`);
}

async function syncGuildReports() {
  const [env, reportsConfig] = await Promise.all([readEnv(paths.env), readJson(paths.reports)]);
  const guildSync = reportsConfig.guildSync || {};

  if (!guildSync.enabled || !guildSync.guildId) {
    throw new Error("Set guildSync.enabled=true and guildSync.guildId in config/reports.json.");
  }

  const token = await getAccessToken(env);
  const startTime = guildSync.startDate ? new Date(`${guildSync.startDate}T00:00:00Z`).getTime() : null;
  const endTime = guildSync.endDate ? new Date(`${guildSync.endDate}T23:59:59Z`).getTime() : null;
  const reports = await fetchGuildReports(token, {
    guildId: Number(guildSync.guildId),
    startTime,
    endTime,
  });

  const existingCodes = new Set(normalizeReportInputs(reportsConfig).map((report) => report.code));
  const additions = reports
    .filter((report) => report.code && !existingCodes.has(report.code))
    .map((report) => ({
      url: `https://www.fflogs.com/reports/${report.code}`,
      code: report.code,
      activityDate: "",
      note: report.title || "",
      includeFightIds: [],
      excludeFightIds: [],
      encounterIds: [],
    }));

  reportsConfig.reports = [...(reportsConfig.reports || []), ...additions];
  await fs.writeFile(paths.reports, `${JSON.stringify(reportsConfig, null, 2)}\n`, "utf8");
  console.log(`Added ${additions.length} report(s) to config/reports.json.`);
}

function parseCliOptions(args) {
  const options = {
    force: false,
    reportCodes: new Set(),
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--report" && args[index + 1]) {
      options.reportCodes.add(String(args[index + 1]).trim());
      index += 1;
      continue;
    }
    if (arg.startsWith("--report=")) {
      options.reportCodes.add(arg.slice("--report=".length).trim());
    }
  }

  return options;
}

function normalizeReportInputs(config) {
  return (config.reports || []).map((report) => ({
    ...report,
    code: report.code || extractReportCode(report.url || ""),
    includeFightIds: new Set((report.includeFightIds || []).map(Number)),
    excludeFightIds: new Set((report.excludeFightIds || []).map(Number)),
    encounterIds: new Set((report.encounterIds || []).map(Number)),
  }));
}

function extractReportCode(urlOrCode) {
  const match = String(urlOrCode).match(/\/reports\/([^/?#]+)/);
  return match ? match[1] : String(urlOrCode).trim();
}

async function loadOrFetchReportBundle({ token, input, reportsConfig, warnings }) {
  const cachePath = path.join(cacheDir, `${input.code}.json`);
  const shouldForce = cliOptions.force || cliOptions.reportCodes.has(input.code);

  if (!shouldForce) {
    const cached = await readJson(cachePath).catch(() => null);
    if (cached?.report?.code) {
      console.log(`Using cached report ${input.code}...`);
      return cached;
    }
  }

  console.log(`Fetching report ${input.code}...`);
  try {
    const report = await fetchReport(token, input.code);
    const fights = selectTargetFights(report.fights || [], input, reportsConfig.target || {});
    const deathsByFight = await fetchEventsByFight(token, input.code, fights, "Deaths").catch((error) => {
      warnings.push(`Death events failed for ${input.code}: ${error.message}`);
      return new Map();
    });
    const damageDownMaps = await Promise.all(
      damageDownAbilityIds.map((abilityId) =>
        fetchEventsByFight(token, input.code, fights, "Debuffs", { abilityId }).catch((error) => {
          warnings.push(`Damage Down events failed for ${input.code} ability ${abilityId}: ${error.message}`);
          return new Map();
        }),
      ),
    );
    const damageDownsByFight = mergeEventMaps(damageDownMaps);
    const bundle = {
      version: 1,
      cachedAt: new Date().toISOString(),
      report,
      fights,
      deathsByFight: eventMapToObject(deathsByFight),
      damageDownsByFight: eventMapToObject(damageDownsByFight),
    };
    await writeJsonAtomic(cachePath, bundle);
    return bundle;
  } catch (error) {
    const cached = await readJson(cachePath).catch(() => null);
    if (cached?.report?.code) {
      warnings.push(`Fetch failed for ${input.code}; used cached report: ${error.message}`);
      return cached;
    }
    throw error;
  }
}

async function getAccessToken(env) {
  const clientId = env.FFLOGS_CLIENT_ID;
  const clientSecret = env.FFLOGS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing FFLOGS_CLIENT_ID or FFLOGS_CLIENT_SECRET in .env.");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");

  const response = await fetch("https://www.fflogs.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`FFLogs OAuth failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function graphQl(token, query, variables = {}) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch("https://www.fflogs.com/api/v2/client", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    const payload = await response.json().catch(() => ({}));
    const message = payload.errors?.map((error) => error.message).join("; ") || response.statusText;
    const rateLimited = response.status === 429 || /too many requests/i.test(message);

    if (response.ok && !payload.errors?.length) {
      return payload.data;
    }

    if (rateLimited && attempt < maxAttempts) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : attempt * 60_000;
      console.warn(`FFLogs rate limit reached. Retrying in ${Math.round(waitMs / 1000)}s (${attempt}/${maxAttempts - 1})...`);
      await sleep(waitMs);
      continue;
    }

    throw new Error(message);
  }

  throw new Error("FFLogs GraphQL request failed.");
}

async function fetchReport(token, code) {
  const queries = [
    `
      query Report($code: String!) {
        reportData {
          report(code: $code) {
            code
            title
            startTime
            endTime
            fights {
              id
              encounterID
              name
              startTime
              endTime
              kill
              bossPercentage
              fightPercentage
              lastPhase
            }
            masterData {
              actors {
                id
                name
                type
                subType
                petOwner
              }
            }
          }
        }
      }
    `,
    `
      query Report($code: String!) {
        reportData {
          report(code: $code) {
            code
            title
            startTime
            endTime
            fights {
              id
              encounterID
              name
              startTime
              endTime
              kill
              bossPercentage
              fightPercentage
              lastPhase
            }
            masterData {
              actors {
                id
                name
                type
                subType
                petOwner
              }
            }
          }
        }
      }
    `,
    `
      query Report($code: String!) {
        reportData {
          report(code: $code) {
            code
            title
            startTime
            endTime
            fights {
              id
              encounterID
              name
              startTime
              endTime
              kill
            }
          }
        }
      }
    `,
  ];

  let lastError;
  for (const query of queries) {
    try {
      const data = await graphQl(token, query, { code });
      return data.reportData.report;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchEventsByFight(token, code, fights, dataType, options = {}) {
  if (!fights.length) return new Map();
  const fightIds = fights.map((fight) => Number(fight.id));
  const startTime = Math.min(...fights.map((fight) => Number(fight.startTime)));
  const endTime = Math.max(...fights.map((fight) => Number(fight.endTime)));
  const events = [];
  let pageStart = startTime;

  while (pageStart < endTime) {
    const page = await fetchEventPage(token, code, fightIds, dataType, pageStart, endTime, options);
    events.push(...page.events);
    if (!page.nextPageTimestamp || page.nextPageTimestamp <= pageStart || page.nextPageTimestamp >= endTime) break;
    pageStart = page.nextPageTimestamp;
  }

  return groupEventsByFight(events, fights);
}

async function fetchEventPage(token, code, fightIds, dataType, startTime, endTime, options = {}) {
  const query = `
    query Events($code: String!, $fightIds: [Int], $startTime: Float!, $endTime: Float!, $abilityId: Int) {
      reportData {
        report(code: $code) {
          events(dataType: ${dataType}, fightIDs: $fightIds, startTime: $startTime, endTime: $endTime, abilityID: $abilityId) {
            data
            nextPageTimestamp
          }
        }
      }
    }
  `;

  const data = await graphQl(token, query, {
    code,
    fightIds,
    startTime,
    endTime,
    abilityId: options.abilityId || null,
  });

  return {
    events: normalizeEvents(data.reportData.report.events?.data || []),
    nextPageTimestamp: data.reportData.report.events?.nextPageTimestamp || null,
  };
}

function mergeEventMaps(maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [fightId, events] of map.entries()) {
      merged.set(fightId, [...(merged.get(fightId) || []), ...events]);
    }
  }
  return merged;
}

function groupEventsByFight(events, fights) {
  const byFight = new Map(fights.map((fight) => [Number(fight.id), []]));
  for (const event of events) {
    const explicitFightId = Number(event.fight || event.fightID || event.fightId);
    if (byFight.has(explicitFightId)) {
      byFight.get(explicitFightId).push(event);
      continue;
    }

    const timestamp = Number(event.timestamp ?? event.time ?? event.startTime);
    const fight = fights.find((item) => timestamp >= Number(item.startTime) && timestamp <= Number(item.endTime));
    if (fight) byFight.get(Number(fight.id)).push(event);
  }
  return byFight;
}

async function fetchGuildReports(token, { guildId, startTime, endTime }) {
  const queries = [
    `
      query Reports($guildId: Int!, $startTime: Float, $endTime: Float) {
        reportData {
          reports(guildID: $guildId, startTime: $startTime, endTime: $endTime) {
            data {
              code
              title
              startTime
              endTime
            }
          }
        }
      }
    `,
    `
      query Reports($guildId: Int!) {
        reportData {
          reports(guildID: $guildId) {
            data {
              code
              title
              startTime
              endTime
            }
          }
        }
      }
    `,
  ];

  let lastError;
  for (const query of queries) {
    try {
      const data = await graphQl(token, query, { guildId, startTime, endTime });
      const rows = data.reportData.reports?.data || [];
      return rows.filter((row) => {
        if (startTime && row.startTime < startTime) return false;
        if (endTime && row.startTime > endTime) return false;
        return true;
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function selectTargetFights(fights, input, target) {
  const targetEncounterIds = new Set([...(target.encounterIds || []), ...input.encounterIds].map(Number).filter(Boolean));
  const aliases = (target.aliases || []).map((name) => name.toLowerCase());

  return fights.filter((fight) => {
    if (input.includeFightIds.size > 0 && !input.includeFightIds.has(Number(fight.id))) return false;
    if (input.excludeFightIds.has(Number(fight.id))) return false;
    if (targetEncounterIds.size > 0) return targetEncounterIds.has(Number(fight.encounterID));
    if (aliases.length === 0) return true;
    const fightName = String(fight.name || "").toLowerCase();
    return aliases.some((alias) => fightName.includes(alias.toLowerCase()));
  });
}

function buildPull({ report, fight, deaths, damageDowns, input, phaseRules, manualOverrides, timezone }) {
  const startedAtMs = Number(report.startTime) + Number(fight.startTime);
  const endedAtMs = Number(report.startTime) + Number(fight.endTime);
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  const progressPercent = deriveProgressPercent(fight);
  const bossHpRemainingPercent = deriveBossHpRemainingPercent(fight, progressPercent);
  const phase = derivePhase({ fight, durationMs, progressPercent, phaseRules });
  const actorMap = new Map((report.masterData?.actors || []).map((actor) => [Number(actor.id), actor]));
  const abilityMap = new Map((report.masterData?.abilities || []).map((ability) => [Number(ability.gameID), ability]));
  const deathChain = deaths
    .map((event) => normalizeDeathEvent(event, startedAtMs, report.startTime, timezone, actorMap))
    .filter(Boolean)
    .sort((a, b) => a.relativeMs - b.relativeMs);
  const damageDownEvents = damageDowns
    .map((event) => normalizeDamageDownEvent(event, startedAtMs, report.startTime, timezone, actorMap, abilityMap))
    .filter(Boolean)
    .sort((a, b) => a.relativeMs - b.relativeMs);
  const firstDeath = deathChain[0] || null;
  const id = `${report.code}-${fight.id}`;
  const wipeCause = inferWipeCause({ deathChain, damageDownEvents, durationMs, phase });
  const manualLabel = manualOverrides[id]?.manualLabel || "";

  return {
    id,
    reportCode: report.code,
    reportTitle: report.title || "",
    fightId: Number(fight.id),
    encounterId: fight.encounterID || null,
    name: fight.name || "",
    activityDate: input.activityDate || dateKey(startedAtMs, timezone),
    startedAt: zonedIso(startedAtMs, timezone),
    endedAt: zonedIso(endedAtMs, timezone),
    startedAtMs,
    endedAtMs,
    durationMs,
    kill: Boolean(fight.kill),
    progressPercent,
    bossHpRemainingPercent,
    phase,
    phaseSource: phase.source,
    phaseConfidence: phase.confidence,
    firstDeath,
    deathChain,
    damageDownEvents,
    damageDownSummary: summarizeDamageDowns(damageDownEvents),
    wipeCause: {
      ...wipeCause,
      manualLabel,
    },
    fflogsUrl: `https://www.fflogs.com/reports/${report.code}#fight=${fight.id}`,
  };
}

function normalizeDeathEvent(event, startedAtMs, reportStartTime, timezone, actorMap) {
  const rawTimestamp = Number(event.timestamp ?? event.time ?? event.startTime);
  if (!Number.isFinite(rawTimestamp)) return null;
  const absoluteMs = rawTimestamp > 10_000_000_000 ? rawTimestamp : Number(reportStartTime) + rawTimestamp;
  const actor =
    actorMap.get(Number(event.targetID)) ||
    actorMap.get(Number(event.target?.id)) ||
    actorMap.get(Number(event.sourceID)) ||
    actorMap.get(Number(event.source?.id));
  const name =
    event.target?.name ||
    event.source?.name ||
    event.targetName ||
    event.sourceName ||
    actor?.name ||
    event.name ||
    event.targetID ||
    event.sourceID ||
    "Unknown";

  return {
    name: String(name),
    timestamp: zonedIso(absoluteMs, timezone),
    relativeMs: Math.max(0, absoluteMs - startedAtMs),
    ability: event.ability?.name || event.abilityGameID || "",
  };
}

function normalizeDamageDownEvent(event, startedAtMs, reportStartTime, timezone, actorMap, abilityMap) {
  const rawTimestamp = Number(event.timestamp ?? event.time ?? event.startTime);
  if (!Number.isFinite(rawTimestamp)) return null;
  const abilityGameId = Number(event.abilityGameID || event.ability?.gameID || event.ability?.guid);
  const ability = event.ability?.name || abilityMap.get(abilityGameId)?.name || (damageDownAbilityIds.includes(abilityGameId) ? "Damage Down" : "");
  if (String(ability).trim().toLowerCase() !== "damage down" && !damageDownAbilityIds.includes(abilityGameId)) return null;

  const absoluteMs = rawTimestamp > 10_000_000_000 ? rawTimestamp : Number(reportStartTime) + rawTimestamp;
  const actor =
    actorMap.get(Number(event.targetID)) ||
    actorMap.get(Number(event.target?.id)) ||
    actorMap.get(Number(event.sourceID)) ||
    actorMap.get(Number(event.source?.id));

  return {
    name: String(actor?.name || event.target?.name || event.targetName || event.targetID || "Unknown"),
    timestamp: zonedIso(absoluteMs, timezone),
    relativeMs: Math.max(0, absoluteMs - startedAtMs),
    ability,
    abilityGameID: Number.isFinite(abilityGameId) ? abilityGameId : null,
    type: event.type || "",
  };
}

function summarizeDamageDowns(events) {
  return ranking(countBy(events, (event) => event.name), "name");
}

function inferWipeCause({ deathChain, damageDownEvents, durationMs, phase }) {
  if (damageDownEvents.length > 0) {
    const names = [...new Set(damageDownEvents.map((event) => event.name))];
    return {
      category: "damage_down",
      label: "与ダメージ低下あり",
      confidence: 0.66,
      reason: `Damage Down付与: ${names.slice(0, 4).join(", ")}${names.length > 4 ? " ほか" : ""}`,
    };
  }

  if (!deathChain.length) {
    return {
      category: "enrage_or_timeout",
      label: "時間切れ/ログ終端",
      confidence: 0.4,
      reason: "死亡イベントが見つからないため、ログ終端や時間切れの可能性があります。",
    };
  }

  const first = deathChain[0];
  const nearFirst = deathChain.filter((death) => death.relativeMs - first.relativeMs <= 10000);

  if (nearFirst.length >= 3) {
    return {
      category: "mass_deaths",
      label: "同時多発死亡",
      confidence: 0.72,
      reason: "10秒以内に3名以上が死亡しています。",
    };
  }

  if (first.relativeMs > durationMs * 0.8 || phase?.rank >= 4) {
    return {
      category: "late_wipe",
      label: "終盤崩れ",
      confidence: 0.55,
      reason: "戦闘の終盤または後半フェーズで最初の死亡が発生しています。",
    };
  }

  return {
    category: "first_death",
    label: "初回死亡起点",
    confidence: 0.58,
    reason: "最初の死亡から崩れた可能性があります。",
  };
}

function deriveProgressPercent(fight) {
  if (fight.kill) return 100;
  const remaining = firstFinite(fight.bossPercentage, fight.percentage);
  if (remaining !== null) return clamp(100 - remaining, 0, 100);
  const direct = firstFinite(fight.fightPercentage);
  if (direct !== null) return clamp(direct, 0, 100);
  return 0;
}

function deriveBossHpRemainingPercent(fight, progressPercent) {
  if (fight.kill) return 0;
  const remaining = firstFinite(fight.bossPercentage, fight.percentage);
  if (remaining !== null) return clamp(remaining, 0, 100);
  if (Number.isFinite(progressPercent)) return clamp(100 - progressPercent, 0, 100);
  return null;
}

function derivePhase({ fight, durationMs, progressPercent, phaseRules }) {
  if (fight.kill) {
    return pickPhaseShape(
      phaseRules.phases.find((phase) => phase.id === "clear") || {
        id: "clear",
        label: "クリア",
        rank: 999,
      },
      "kill",
      1,
    );
  }

  const phaseByLastPhase = phaseRules.phases.find((phase) => Number(phase.rank) === Number(fight.lastPhase));
  if (phaseByLastPhase) return pickPhaseShape(phaseByLastPhase, "fflogs-lastPhase", 0.86);

  const fightName = String(fight.name || "").toLowerCase();
  const matchedByKeyword = [...phaseRules.phases]
    .sort((a, b) => b.rank - a.rank)
    .find((phase) => (phase.keywords || []).some((keyword) => fightName.includes(String(keyword).toLowerCase())));

  if (matchedByKeyword) return pickPhaseShape(matchedByKeyword, "fight-name", 0.72);

  const matchedByThreshold = [...phaseRules.phases]
    .filter((phase) => phase.id !== "clear")
    .sort((a, b) => b.rank - a.rank)
    .find((phase) => {
      const elapsedOk = durationMs >= Number(phase.minElapsedMs || 0);
      return elapsedOk;
    });

  return pickPhaseShape(matchedByThreshold || phaseRules.phases[0], matchedByThreshold ? "elapsed-threshold" : "fallback", matchedByThreshold ? 0.58 : 0.3);
}

function pickPhaseShape(phase, source = "unknown", confidence = 0.5) {
  return {
    id: phase?.id || "unknown",
    label: phase?.label || "未判定",
    rank: phase?.rank || 0,
    source,
    confidence,
  };
}

function buildCalendarData({ pulls, reportsConfig, phaseRules, warnings }) {
  const timezone = reportsConfig.timezone || phaseRules.timezone || "Asia/Tokyo";
  const grouped = groupBy(pulls, (pull) => pull.activityDate);
  const days = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, datePulls]) => buildDay(date, datePulls));

  const analytics = buildAnalytics(days);

  return {
    version: 1,
    generatedAt: zonedIso(Date.now(), timezone),
    source: {
      mode: "fflogs-api",
      timezone,
      reportCount: normalizeReportInputs(reportsConfig).filter((report) => report.code && report.code !== "REPLACE_WITH_REPORT_CODE").length,
      fightCount: pulls.length,
      warnings,
    },
    target: {
      name: reportsConfig.target?.name || "FFLogs",
      aliases: reportsConfig.target?.aliases || [],
    },
    days,
    analytics,
  };
}

function buildDay(date, pulls) {
  const sortedPulls = [...pulls].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const sessions = splitSessions(sortedPulls);
  const bestPull = sortedPulls.reduce((best, pull) => (isPullDeeper(pull, best) ? pull : best), null);
  const deepestPhase = bestPull?.phase || null;
  const firstPullAt = sortedPulls[0]?.startedAt || "";
  const lastPullEndedAt = sortedPulls[sortedPulls.length - 1]?.endedAt || "";
  const activeFightDurationMs = sum(sortedPulls.map((pull) => pull.durationMs));
  const activityDurationMs = sum(
    sessions.map((session) => {
      const spanMs = session[session.length - 1].endedAtMs - session[0].startedAtMs;
      const activeMs = sum(session.map((pull) => pull.durationMs));
      return Math.max(spanMs, activeMs);
    }),
  );

  return {
    date,
    sessionCount: sessions.length,
    pullCount: sortedPulls.length,
    deepestPhase,
    bestProgressPercent: bestPull?.progressPercent || 0,
    bestBossHpRemainingPercent: bestPull?.bossHpRemainingPercent ?? null,
    bestPull: bestPull ? stripRuntimeFields(bestPull) : null,
    firstPullAt,
    lastPullEndedAt,
    activityDurationMs,
    activeFightDurationMs,
    downtimeMs: Math.max(0, activityDurationMs - activeFightDurationMs),
    wipeCauseSummary: countBy(sortedPulls, (pull) => pull.wipeCause.category),
    firstDeathSummary: countBy(
      sortedPulls.filter((pull) => pull.firstDeath?.name),
      (pull) => pull.firstDeath.name,
    ),
    pulls: sortedPulls.map(stripRuntimeFields),
  };
}

function splitSessions(pulls) {
  const maxSessionGapMs = 2 * 60 * 60 * 1000;
  const sessions = [];
  for (const pull of pulls) {
    const current = sessions[sessions.length - 1];
    const previous = current?.[current.length - 1];
    if (!current || (previous && pull.startedAtMs - previous.endedAtMs > maxSessionGapMs)) {
      sessions.push([pull]);
    } else {
      current.push(pull);
    }
  }
  return sessions;
}

function isPullDeeper(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  const candidateRank = Number(candidate.phase?.rank || 0);
  const currentRank = Number(current.phase?.rank || 0);
  if (candidateRank !== currentRank) return candidateRank > currentRank;

  const candidateHp = Number.isFinite(candidate.bossHpRemainingPercent) ? candidate.bossHpRemainingPercent : 100;
  const currentHp = Number.isFinite(current.bossHpRemainingPercent) ? current.bossHpRemainingPercent : 100;
  if (candidateHp !== currentHp) return candidateHp < currentHp;

  return Number(candidate.durationMs || 0) > Number(current.durationMs || 0);
}

function buildAnalytics(days) {
  const pulls = days.flatMap((day) => day.pulls);
  const progressGraph = buildProgressGraph(days);
  return {
    totalDays: days.length,
    totalPulls: pulls.length,
    totalActiveFightDurationMs: sum(days.map((day) => day.activeFightDurationMs)),
    firstDeathRanking: ranking(
      countBy(
        pulls.filter((pull) => pull.firstDeath?.name),
        (pull) => pull.firstDeath.name,
      ),
      "name",
    ),
    wipeCauseRanking: ranking(countBy(pulls, (pull) => pull.wipeCause.category), "category").map((row) => ({
      ...row,
      label: pullCauseLabel(row.category),
    })),
    phaseTrend: days.map((day) => ({
      date: day.date,
      phase: day.deepestPhase?.label || "-",
      rank: day.deepestPhase?.rank || 0,
      bestProgressPercent: day.bestProgressPercent || 0,
      bestBossHpRemainingPercent: day.bestBossHpRemainingPercent ?? null,
    })),
    progressGraph,
  };
}

function buildProgressGraph(days) {
  const points = [];
  let bestSoFar = null;
  let pullNumber = 0;

  for (const day of days) {
    for (const pull of day.pulls) {
      pullNumber += 1;
      bestSoFar = isPullDeeper(pull, bestSoFar) ? pull : bestSoFar;
      points.push({
        pullNumber,
        date: day.date,
        reportCode: pull.reportCode,
        fightId: pull.fightId,
        startedAt: pull.startedAt,
        durationMs: pull.durationMs,
        phase: pull.phase,
        phaseRank: pull.phase?.rank || 0,
        bossHpRemainingPercent: pull.bossHpRemainingPercent,
        progressPercent: pull.progressPercent,
        kill: pull.kill,
        fflogsUrl: pull.fflogsUrl,
        bestPhaseRank: bestSoFar?.phase?.rank || 0,
        bestBossHpRemainingPercent: bestSoFar?.bossHpRemainingPercent ?? null,
        bestPullId: bestSoFar?.id || "",
      });
    }
  }

  return {
    mode: "phase-bands",
    xAxis: "pullNumber",
    yAxis: "phaseRankWithBossHpRemaining",
    points,
  };
}

function stripRuntimeFields(pull) {
  const { startedAtMs, endedAtMs, ...rest } = pull;
  return rest;
}

function normalizeEvents(events) {
  if (Array.isArray(events)) return events;
  if (typeof events === "string") {
    try {
      const parsed = JSON.parse(events);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function eventMapToObject(map) {
  return Object.fromEntries([...map.entries()].map(([fightId, events]) => [String(fightId), events]));
}

function objectToEventMap(object) {
  return new Map(Object.entries(object || {}).map(([fightId, events]) => [Number(fightId), Array.isArray(events) ? events : []]));
}

async function writeCalendarData(data) {
  await fs.mkdir(dataDir, { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(paths.outJson, json, "utf8");
  await fs.writeFile(paths.outJs, `window.FFLOGS_CALENDAR_DATA = ${JSON.stringify(data, null, 2)};\n`, "utf8");
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readEnv(file) {
  const raw = await fs.readFile(file, "utf8").catch(() => "");
  const env = { ...process.env };
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function groupBy(values, keyFn) {
  return values.reduce((groups, value) => {
    const key = keyFn(value);
    groups[key] ||= [];
    groups[key].push(value);
    return groups;
  }, {});
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function ranking(counts, keyName) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ [keyName]: key, count }));
}

function pullCauseLabel(category) {
  return (
    {
      damage_down: "与ダメージ低下あり",
      first_death: "初回死亡起点",
      mass_deaths: "同時多発死亡",
      late_wipe: "終盤崩れ",
      enrage_or_timeout: "時間切れ/ログ終端",
      manual: "手動分類",
      unknown: "未分類",
    }[category] || category
  );
}

function dateKey(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function zonedIso(ms, timezone) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = timezone === "Asia/Tokyo" ? "+09:00" : "Z";
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}.000${offset}`;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function max(values) {
  return values.reduce((best, value) => Math.max(best, Number(value || 0)), 0);
}

function firstFinite(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function clamp(value, min, maxValue) {
  return Math.max(min, Math.min(maxValue, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
