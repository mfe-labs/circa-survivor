// Circa Selections PDF parser + ESPN results mapping.
import { parseSelections, selectionFileNames, resultsFromScoreboard, espnWeek, NICK } from "../scripts/circa.mjs";
import { legFromCirca, rescore } from "../src/circaLive.js";
let fails = 0; const ok = (name, cond, extra = "") => { console.log(name + ":", cond ? "OK" : "FAIL", extra); if (!cond) fails++; };

const text = `Circa Survivor 2026
Week 1 Selections


ENTRY NAME               SELECTION         ENTRY NAME                SELECTION         ENTRY NAME               SELECTION

!!DNANA-1                22. CHARGERS PK   FRANK B-6                 20. LIONS PK      patriots with leis-3     12. STEELERS PK
FRANKFORTPHILLYGROUP-1 6. JAGUARS PK        Frankie & Joey's Dad-1    12. STEELERS PK   PAY ME THE CASH-1        22. CHARGERS PK
CIRCAmcised-2            20. LIONS PK      MEADOWBROOKHOOLIGANS-     6. JAGUARS PK     WHEREDREAMSCOMETODIE-    6. JAGUARS PK
CRUZEIRO-6               6. JAGUARS PK     MEADOWBROOKHOOLIGANS-10
                                                                     6. JAGUARS PK     THEMILHOUSEALWYSWINS-5   20. LIONS PK
                                                                                                                              09/12/26
CIRCAmcised-3            6. JAGUARS PK     BUCS FAN-1                18. BUCS PK       NINERS-1                 30. 49ERS PK
`;
const r = parseSelections(text);
ok("counts by team", r.picks.JAX === 6 && r.picks.LAC === 2 && r.picks.DET === 3 && r.picks.PIT === 2 && r.picks.TB === 1 && r.picks.SF === 1, JSON.stringify(r.picks));
ok("total picks", r.total === 15, String(r.total));
ok("single-space name", r.entries["FRANKFORTPHILLYGROUP-1"] === "JAX");
ok("name with spaces and apostrophe", r.entries["Frankie & Joey's Dad-1"] === "PIT" && r.entries["PAY ME THE CASH-1"] === "LAC");
ok("truncated long names still count", r.entries["MEADOWBROOKHOOLIGANS-"] === "JAX" && r.entries["WHEREDREAMSCOMETODIE-"] === "JAX");
ok("pick wrapped to next line belongs to the dangling name", r.entries["MEADOWBROOKHOOLIGANS-10"] === "JAX");
ok("date footer ignored, no unknown teams", r.unknown.length === 0 && !("09/12/26" in r.entries));
ok("owner's entries readable", r.entries["CIRCAmcised-2"] === "DET" && r.entries["CIRCAmcised-3"] === "JAX");
ok("nickname aliases", NICK.BUCS === "TB" && NICK["49ERS"] === "SF" && NICK.COMMANDERS === "WAS" && NICK.JAGUARS === "JAX");

const names = selectionFileNames("W3");
ok("file name candidates: month folders + _1 variant", names[0].endsWith("/2026/09/Circa-Survivor-2026-Week-3-Selections.pdf") && names.some((u) => u.includes("/2026/10/")) && names.some((u) => u.endsWith("Selections_1.pdf")));
ok("holiday legs use a/b suffixes", selectionFileNames("TG")[0].includes("Week-12a-") && selectionFileNames("W12")[0].includes("Week-12b-") && selectionFileNames("XM")[0].includes("Week-16a-") && selectionFileNames("W16")[0].includes("Week-16b-"));
ok("ESPN week for holiday legs", espnWeek("TG") === 12 && espnWeek("XM") === 16 && espnWeek("W7") === 7);

// ESPN scoreboard → results, including a tie (both lose) and a game still in progress
const ev = (away, home, as, hs, done) => ({ competitions: [{ status: { type: { completed: done } }, competitors: [{ homeAway: "home", team: { abbreviation: home }, score: String(hs) }, { homeAway: "away", team: { abbreviation: away }, score: String(as) }] }] });
const sb = { events: [ev("NE", "SEA", 10, 13, true), ev("SF", "LAR", 27, 7, true), ev("TB", "CIN", 20, 20, true), ev("DEN", "KC", 0, 0, false), ev("WSH", "PHI", 22, 24, true), ev("DAL", "MIA", 1, 0, true)] };
const res = resultsFromScoreboard("W1", sb);
ok("winners and losers", res.SEA === "won" && res.NE === "lost" && res.SF === "won" && res.LAR === "lost");
ok("tie = both lose", res.TB === "lost" && res.CIN === "lost");
ok("unfinished game pending", res.DEN === "pending" && res.KC === "pending");
ok("ESPN WSH alias", res.PHI === "won" && res.WAS === "lost");
ok("game not in this leg ignored", res.DAL === undefined && res.MIA === undefined);
// the page builds the same week record the job does
(() => {
  const parsed = { picks: { DAL: 2554, HOU: 1228 }, entries: {}, unknown: [], total: 3782 };
  const e = legFromCirca(parsed, { DAL: "lost", HOU: "pending" }, 3800, "https://x/w5.pdf", new Date("2026-10-10T19:00:00-07:00").getTime());
  ok("no-picks are counted from the entries alive going in", e.picks.NOPICK === 18 && e.lost.includes("NOPICK"));
  ok("results sort into won/lost/pending", e.lost.includes("DAL") && e.pending.includes("HOU") && e.won.length === 0);
  ok("record looks like the job's", /^Oct 10 \(1 pending\)$/.test(e.asOf) && e.source === "https://x/w5.pdf");
  const r2 = rescore(e, { DAL: "lost", HOU: "won" });
  ok("a new result re-scores the week", r2 && r2.won.includes("HOU") && r2.pending.length === 0 && / \(final\)$/.test(r2.asOf));
  ok("no change means no update", rescore(e, { DAL: "lost", HOU: "pending" }) === null);
})();
if (fails) { console.log(`${fails} FAILED`); process.exit(1); }
