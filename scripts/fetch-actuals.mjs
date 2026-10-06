// Keep data/actuals.json (Circa's posted picks + results per week) and the owner's own picks in sync automatically:
//   picks   ← Circa's weekly Selections PDF (every entry's pick; posted ~2 h after the Saturday lock)
//   results ← ESPN's public scoreboard (won / lost / pending per game; a tie is a loss)
// Runs for every leg that has no actuals yet or still has pending games. Needs `pdftotext` (poppler) on PATH.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEGS, OPP } from "../src/schedule.js";
import { parseSelections, selectionFileNames, resultsFromScoreboard, espnWeek } from "./circa.mjs";
import { fetchRetry, fetchOrNull } from "./http.mjs";

const ACTUALS = new URL("../data/actuals.json", import.meta.url);
const PICKS = new URL("../data/picks.json", import.meta.url);
const now = Date.now();
const actuals = JSON.parse(readFileSync(ACTUALS, "utf8"));
const picksFile = JSON.parse(readFileSync(PICKS, "utf8"));
actuals.legs ||= {};
const tmp = mkdtempSync(join(tmpdir(), "circa-"));
let changed = false;

// live entries going into a leg = start − everyone eliminated in earlier legs
function liveBefore(legId) {
  let live = actuals.contest.start;
  for (const l of LEGS) {
    if (l.id === legId) break;
    const a = actuals.legs[l.id]; if (!a) break;
    live -= Object.entries(a.picks).filter(([t]) => a.lost.includes(t)).reduce((s, [, n]) => s + n, 0);
  }
  return live;
}
async function findSelections(legId, known) {
  for (const url of known ? [known, ...selectionFileNames(legId)] : selectionFileNames(legId)) {
    const r = await fetchOrNull(url, { method: "HEAD" }, { tries: 2, label: url.split("/").pop() });
    if (r?.ok && /pdf/i.test(r.headers.get("content-type") || "")) return url;
  }
  return null;
}
for (const leg of LEGS) {
  if (new Date(leg.start + "T00:00:00-04:00").getTime() > now) break;                 // leg hasn't started
  const cur = actuals.legs[leg.id];
  if (cur && !cur.pending?.length && cur.source) continue;                             // complete and already sourced from the PDF
  // ---- picks from Circa's Selections PDF ----
  let picks = cur?.picks, source = cur?.source || null;
  if (!source) {
    const url = await findSelections(leg.id, null);
    if (!url) { console.log(`${leg.id}: selections PDF not posted yet`); if (!cur) continue; }
    else {
      const pdf = join(tmp, `${leg.id}.pdf`);
      writeFileSync(pdf, Buffer.from(await (await fetchRetry(url, {}, { label: "selections PDF" })).arrayBuffer()));
      const text = execFileSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
      const parsed = parseSelections(text);
      if (parsed.unknown.length) console.warn(`${leg.id}: unknown team names in PDF: ${parsed.unknown.join(", ")}`);
      const before = liveBefore(leg.id), noPick = before - parsed.total;
      picks = { ...parsed.picks };
      if (noPick > 0) picks.NOPICK = noPick;
      if (noPick < 0) console.warn(`${leg.id}: PDF lists ${parsed.total} picks but only ${before} entries were alive`);
      source = url;
      console.log(`${leg.id}: ${parsed.total} picks from ${url.split("/").pop()} · ${noPick} no-pick · ${before} alive going in`);
      // the owner's own entries, straight from Circa's file (the source of truth once the week locks)
      for (const e of picksFile.entries) { const t = parsed.entries[e.name]; if (t && e.picks[leg.id] !== t) { console.log(`  ${e.name}: ${leg.id} ${e.picks[leg.id] || "–"} → ${t} (per Circa)`); e.picks[leg.id] = t; changed = true; } }
    }
  }
  // ---- results from ESPN ----
  const sbRes = await fetchOrNull(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${espnWeek(leg.id)}&dates=2026`, {}, { label: `ESPN week ${espnWeek(leg.id)}` });
  if (!sbRes) { console.warn(`${leg.id}: no scoreboard, leaving results as they were`); continue; }
  const res = resultsFromScoreboard(leg.id, await sbRes.json());
  const won = [], lost = [], pending = [];
  for (const t of Object.keys(picks)) {
    const r = t === "NOPICK" ? "lost" : res[t] || "pending";
    (r === "won" ? won : r === "lost" ? lost : pending).push(t);
  }
  const next = { asOf: new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) + (pending.length ? ` (${pending.length} pending)` : " (final)"), picks, won, lost, pending, source };
  if (cur?.fv) { next.fv = cur.fv; next.fvAt = cur.fvAt; }                               // frozen at lock by freeze-fv, never recomputed
  if (JSON.stringify({ ...next, asOf: 0 }) !== JSON.stringify({ ...(cur || {}), asOf: 0 })) { actuals.legs[leg.id] = next; changed = true; }
  console.log(`${leg.id}: ${won.length} won, ${lost.length} lost, ${pending.length} pending`);
}
if (changed) {
  writeFileSync(ACTUALS, JSON.stringify(actuals, null, 1) + "\n");
  writeFileSync(PICKS, JSON.stringify(picksFile, null, 1) + "\n");
  console.log("actuals.json / picks.json updated");
} else console.log("no changes");
