// Read Circa's Selections PDF in the browser, so the page shows the real picks the moment Circa posts them
// instead of waiting for a scheduled job (which GitHub has dropped on Saturday evenings). Circa's server and
// ESPN's both allow cross-origin reads. The PDF is parsed with pdf.js, loaded only when needed, and the text is
// rebuilt into the same layout the job's parser expects.
import { parseSelections, selectionFileNames, resultsFromScoreboard, espnWeek } from "../scripts/circa.mjs";

let pdfjsP = null;
async function pdfjs() {
  if (!pdfjsP) pdfjsP = import("pdfjs-dist").then(async (m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    return m;
  });
  return pdfjsP;
}
// pdftotext -layout style lines from pdf.js text items: group by baseline, order by x, widen big gaps so names
// and selections stay separated by two or more spaces
export async function pdfText(data, lib) {
  const m = lib || await pdfjs();
  const doc = await m.getDocument({ data, isEvalSupported: false }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p), tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) { if (!it.str) continue; const y = Math.round(it.transform[5] / 3) * 3; const x = it.transform[4]; (rows.get(y) || rows.set(y, []).get(y)).push({ x, w: it.width, s: it.str }); }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const its = rows.get(y).sort((a, b) => a.x - b.x); let line = "", end = null;
      for (const it of its) { if (end != null) { const gap = it.x - end; line += gap > 6 ? "     " : gap > 1 ? " " : ""; } line += it.s; end = it.x + it.w; }
      lines.push(line);
    }
  }
  return lines.join("\n");
}
// Try Circa's candidate file names for a leg. Returns { url, parsed } or null when nothing is posted yet.
export async function fetchSelections(legId) {
  for (const url of selectionFileNames(legId)) {
    let r; try { r = await fetch(url, { cache: "no-store" }); } catch { continue; }
    if (!r.ok || !/pdf/i.test(r.headers.get("content-type") || "")) continue;
    const text = await pdfText(new Uint8Array(await r.arrayBuffer()));
    return { url, parsed: parseSelections(text) };
  }
  return null;
}
export async function fetchResults(legId) {
  try {
    const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=${espnWeek(legId)}&dates=2026`, { cache: "no-store" });
    if (!r.ok) return null;
    return resultsFromScoreboard(legId, await r.json());
  } catch { return null; }
}
// The same leg record the results job writes: picks (plus NOPICK for entries that were alive but absent),
// won/lost/pending from the scoreboard, and the source. The caller adds the frozen future values.
export function legFromCirca(parsed, results, before, url, now = Date.now()) {
  const picks = { ...parsed.picks };
  const noPick = before - parsed.total;
  if (noPick > 0) picks.NOPICK = noPick;
  const won = [], lost = [], pending = [];
  for (const t of Object.keys(picks)) {
    const r = t === "NOPICK" ? "lost" : results?.[t] || "pending";
    (r === "won" ? won : r === "lost" ? lost : pending).push(t);
  }
  return { asOf: asOfLabel(pending.length, now), picks, won, lost, pending, source: url };
}
export const asOfLabel = (pendingCount, now = Date.now()) => new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) + (pendingCount ? ` (${pendingCount} pending)` : " (final)");
// Re-score a week's picks from the scoreboard. Returns the updated record, or null if nothing changed.
export function rescore(leg, results) {
  if (!leg || !results) return null;
  const won = [], lost = [], pending = [];
  for (const t of Object.keys(leg.picks)) { const r = t === "NOPICK" ? "lost" : results[t] || "pending"; (r === "won" ? won : r === "lost" ? lost : pending).push(t); }
  if (won.length === leg.won.length && lost.length === leg.lost.length && pending.length === leg.pending.length) return null;
  return { ...leg, won, lost, pending, asOf: asOfLabel(pending.length) };
}
