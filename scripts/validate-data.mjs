import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const files = [
  "config/reports.json",
  "config/phase-rules.json",
  "data/calendar-data.json",
  "data/manual-overrides.json",
];

for (const file of files) {
  JSON.parse(await fs.readFile(path.join(rootDir, file), "utf8"));
  console.log(`OK ${file}`);
}

const calendar = JSON.parse(await fs.readFile(path.join(rootDir, "data/calendar-data.json"), "utf8"));
if (!Array.isArray(calendar.days)) throw new Error("calendar-data.json: days must be an array.");
for (const day of calendar.days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date || "")) throw new Error(`Invalid day date: ${day.date}`);
  if (!Array.isArray(day.pulls)) throw new Error(`Day ${day.date}: pulls must be an array.`);
  if (day.pulls.length && !day.bestPull?.id) throw new Error(`Day ${day.date}: bestPull is required.`);
  for (const pull of day.pulls) {
    if (!pull.id) throw new Error(`Day ${day.date}: pull id is required.`);
    if (!pull.fflogsUrl) throw new Error(`Pull ${pull.id}: fflogsUrl is required.`);
    if (!pull.phase?.label) throw new Error(`Pull ${pull.id}: phase label is required.`);
  }
}

const progressPoints = calendar.analytics?.progressGraph?.points || [];
if (!Array.isArray(progressPoints)) throw new Error("analytics.progressGraph.points must be an array.");
if (progressPoints.length && progressPoints.length !== calendar.days.flatMap((day) => day.pulls).length) {
  throw new Error("analytics.progressGraph.points must match pull count.");
}

const jsText = await fs.readFile(path.join(rootDir, "data/calendar-data.js"), "utf8");
if (!jsText.includes("window.FFLOGS_CALENDAR_DATA")) {
  throw new Error("calendar-data.js must expose window.FFLOGS_CALENDAR_DATA.");
}

console.log(`OK calendar days=${calendar.days.length}`);
