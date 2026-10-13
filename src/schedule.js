// 2026 NFL schedule grouped into the 20 Circa Survivor legs. Shared by the app and the data scripts.
// ---------- 2026 schedule, grouped into the 20 Circa legs ----------
// "AWAY@HOME"  (* = neutral site). Thanksgiving Eve/Day/Black Friday and
// Christmas Eve/Day games are pulled out into their own legs, per Circa rules.
export const LEGS = [
  { id: "W1", start: "2026-09-09", label: "1", g: "NE@SEA SF@LAR* CHI@CAR TB@CIN BAL@IND BUF@HOU NO@DET NYJ@TEN ATL@PIT CLE@JAX ARI@LAC GB@MIN MIA@LV WAS@PHI DAL@NYG DEN@KC" },
  { id: "W2", start: "2026-09-17", label: "2", g: "DET@BUF MIN@CHI PHI@TEN GB@NYJ CAR@ATL NO@BAL CIN@HOU CLE@TB PIT@NE LV@LAC JAX@DEN WAS@DAL SEA@ARI MIA@SF IND@KC NYG@LAR" },
  { id: "W3", start: "2026-09-24", label: "3", g: "ATL@GB KC@MIA HOU@IND TEN@NYG NE@JAX CIN@PIT CAR@CLE NYJ@DET SEA@WAS LAC@BUF MIN@TB ARI@SF BAL@DAL* LV@NO LAR@DEN PHI@CHI" },
  { id: "W4", start: "2026-10-01", label: "4", g: "PIT@CLE IND@WAS* TEN@BAL ARI@NYG JAX@CIN NE@BUF DAL@HOU LAR@PHI GB@TB NYJ@CHI MIA@MIN DEN@SF LAC@SEA KC@LV DET@CAR ATL@NO" },
  { id: "W5", start: "2026-10-08", label: "5", g: "TB@DAL PHI@JAX* LV@NE HOU@TEN CLE@NYJ IND@PIT CIN@MIA MIN@NO NYG@WAS DEN@LAC CHI@GB DET@ARI SF@SEA BAL@ATL BUF@LAR" },
  { id: "W6", start: "2026-10-15", label: "6", g: "SEA@DEN HOU@JAX* NYJ@NE PIT@TB CAR@PHI CHI@ATL TEN@IND NO@NYG BAL@CLE ARI@LAR LAC@KC BUF@LV DAL@GB WAS@SF" },
  { id: "W7", start: "2026-10-22", label: "7", g: "NE@CHI PIT@NO* CLE@TEN MIA@NYJ IND@MIN CIN@BAL NYG@HOU TB@CAR SF@ATL DEN@ARI LAR@LV GB@DET KC@SEA DAL@PHI" },
  { id: "W8", start: "2026-10-29", label: "8", g: "CAR@GB TEN@CIN IND@JAX CLE@PIT BAL@BUF ATL@TB MIN@DET ARI@DAL LV@NYJ LAC@LAR KC@DEN NE@MIA PHI@WAS CHI@SEA" },
  { id: "W9", start: "2026-11-05", label: "9", g: "JAX@BAL CIN@ATL* NYJ@KC CLE@NO DEN@CAR DAL@IND DET@MIA NYG@PHI LAR@WAS LV@SF HOU@LAC ARI@SEA GB@NE TB@CHI BUF@MIN" },
  { id: "W10", start: "2026-11-12", label: "10", g: "WAS@NYG NE@DET* BUF@NYJ MIA@IND KC@ATL MIN@GB JAX@TEN HOU@CLE CAR@NO LAR@ARI SEA@LV SF@DAL PIT@CIN LAC@BAL" },
  { id: "W11", start: "2026-11-19", label: "11", g: "IND@HOU ARI@KC TB@DET JAX@NYG MIA@BUF TEN@DAL BAL@CAR NO@CHI NYJ@LAC PIT@PHI LV@DEN MIN@SF* CIN@WAS" },
  { id: "TG", start: "2026-11-25", label: "TG", holiday: true, sub: "Nov 25–27", g: "GB@LAR CHI@DET PHI@DAL KC@BUF DEN@PIT" },
  { id: "W12", start: "2026-11-29", label: "12", sub: "Nov 29–30", g: "BAL@HOU NO@CIN NYJ@MIA ATL@MIN NYG@IND LV@CLE TEN@JAX WAS@ARI SEA@SF NE@LAC CAR@TB" },
  { id: "W13", start: "2026-12-03", label: "13", g: "KC@LAR DET@ATL LAC@TB WAS@TEN CIN@CLE SF@NYG GB@NO JAX@CHI PHI@ARI MIA@DEN CAR@MIN BUF@NE HOU@PIT DAL@SEA" },
  { id: "W14", start: "2026-12-10", label: "14", g: "MIN@NE DEN@NYJ ATL@CLE CHI@MIA HOU@WAS NO@CAR IND@PHI TB@BAL TEN@DET LAC@LV KC@CIN LAR@SF NYG@SEA BUF@GB PIT@JAX" },
  { id: "W15", start: "2026-12-17", label: "15", g: "SF@LAC SEA@PHI CHI@BUF JAX@HOU BAL@PIT CLE@NYG IND@TEN MIA@GB NO@TB CIN@CAR ATL@WAS NYJ@ARI DAL@LAR DEN@LV DET@MIN NE@KC" },
  { id: "XM", start: "2026-12-24", label: "XM", holiday: true, sub: "Dec 24–25", g: "HOU@PHI GB@CHI BUF@DEN LAR@SEA" },
  { id: "W16", start: "2026-12-26", label: "16", sub: "Dec 26–28", g: "TB@ATL WAS@MIN CAR@PIT CIN@IND NE@NYJ CLE@BAL LAC@MIA ARI@NO SF@KC JAX@DAL NYG@DET TEN@LV" },
  { id: "W17", start: "2026-12-31", label: "17", g: "BAL@CIN LAR@TB DEN@NE KC@LAC WAS@JAX BUF@MIA PIT@TEN MIN@NYJ NO@ATL SEA@CAR IND@CLE NYG@DAL LV@ARI DET@CHI PHI@SF HOU@GB" },
  { id: "W18", start: "2027-01-09", label: "18", g: "NYJ@BUF JAX@IND LV@KC TEN@HOU LAC@DEN MIA@NE CLE@CIN PIT@BAL CHI@MIN DET@GB DAL@WAS TB@NO PHI@NYG SEA@LAR ATL@CAR SF@ARI" },
];

export const DIVISIONS = [
  ["AFC East", ["BUF", "MIA", "NE", "NYJ"]],
  ["AFC North", ["BAL", "CIN", "CLE", "PIT"]],
  ["AFC South", ["HOU", "IND", "JAX", "TEN"]],
  ["AFC West", ["DEN", "KC", "LAC", "LV"]],
  ["NFC East", ["DAL", "NYG", "PHI", "WAS"]],
  ["NFC North", ["CHI", "DET", "GB", "MIN"]],
  ["NFC South", ["ATL", "CAR", "NO", "TB"]],
  ["NFC West", ["ARI", "LAR", "SF", "SEA"]],
];
export const ALL_TEAMS = DIVISIONS.flatMap(([, t]) => t).sort();
export const FULL = { ARI:"Arizona Cardinals", ATL:"Atlanta Falcons", BAL:"Baltimore Ravens", BUF:"Buffalo Bills", CAR:"Carolina Panthers", CHI:"Chicago Bears", CIN:"Cincinnati Bengals", CLE:"Cleveland Browns", DAL:"Dallas Cowboys", DEN:"Denver Broncos", DET:"Detroit Lions", GB:"Green Bay Packers", HOU:"Houston Texans", IND:"Indianapolis Colts", JAX:"Jacksonville Jaguars", KC:"Kansas City Chiefs", LAC:"Los Angeles Chargers", LV:"Las Vegas Raiders", LAR:"Los Angeles Rams", MIA:"Miami Dolphins", MIN:"Minnesota Vikings", NE:"New England Patriots", NO:"New Orleans Saints", NYG:"New York Giants", NYJ:"New York Jets", PHI:"Philadelphia Eagles", PIT:"Pittsburgh Steelers", SF:"San Francisco 49ers", SEA:"Seattle Seahawks", TB:"Tampa Bay Buccaneers", TEN:"Tennessee Titans", WAS:"Washington Commanders" };

// opp[legId][team] = { opp, home, neutral }
export const OPP = {};
for (const leg of LEGS) {
  OPP[leg.id] = {};
  for (const tok of leg.g.split(" ")) {
    const neutral = tok.endsWith("*");
    const [away, home] = tok.replace("*", "").split("@");
    OPP[leg.id][away] = { opp: home, home: false, neutral };
    OPP[leg.id][home] = { opp: away, home: true, neutral };
  }
}
// NFL week of each leg (the holiday legs are carved out of Weeks 12 and 16), and who plays in each week
export const nflWeek = (leg) => (leg.id === "TG" ? 12 : leg.id === "XM" ? 16 : +leg.label);
const TEAMS_IN_WEEK = {};
for (const leg of LEGS) { const wk = (TEAMS_IN_WEEK[nflWeek(leg)] ||= new Set()); for (const t of Object.keys(OPP[leg.id])) wk.add(t); }
// A team off a bye is worth about a point more to the market (2025 closing lines: +1.1 pts over 26 games). +1 when
// the team had last week off and its opponent did not, −1 the other way, 0 otherwise.
export const REST_PTS = 1;
export function restEdge(legId, team) {
  const leg = LEGS.find((l) => l.id === legId), g = OPP[legId]?.[team]; if (!leg || !g) return 0;
  const n = nflWeek(leg); if (n <= 1) return 0;
  const off = (t) => (TEAMS_IN_WEEK[n - 1]?.has(t) ? 0 : 1);
  return off(team) - off(g.opp);
}
export const TG_TEAMS = new Set(Object.keys(OPP.TG));
export const XM_TEAMS = new Set(Object.keys(OPP.XM));

// full name -> abbreviation (The Odds API and nflverse use full names / their own codes)
export const ABBR = Object.fromEntries(Object.entries(FULL).map(([k, v]) => [v, k]));
export const ALIAS = { WSH: "WAS", JAC: "JAX", LA: "LAR", LOS: "LAR", STL: "LAR", GNB: "GB", KAN: "KC", NWE: "NE", NOR: "NO", SFO: "SF", TAM: "TB", LVR: "LV", OAK: "LV", SDG: "LAC", SD: "LAC", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" };
export const norm = (t) => { t = String(t).toUpperCase().trim(); return FULL[t] ? t : ALIAS[t] || null; };
// which leg a game belongs to, by its "AWAY@HOME" token (holiday games live in their own legs)
export function legForGame(away, home) {
  for (const leg of LEGS) if (OPP[leg.id][away] && OPP[leg.id][away].opp === home && !OPP[leg.id][away].home) return leg.id;
  return null;
}
export const legLabel = (l) => (l.id === "TG" ? "Thanksgiving" : l.id === "XM" ? "Christmas" : `Week ${l.label}`);
