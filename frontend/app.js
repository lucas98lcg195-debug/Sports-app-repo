// All fetch calls hit our own backend, never ESPN directly, so there is
// no CORS to deal with and ESPN's calls stay server-side.

const SPORTS = ["football", "baseball"];
const SCOREBOARD_POLL_MS = 30000;

// ESPN's public gamecast pages follow this stable pattern on espn.com
// itself (not the hidden JSON API), so a link built from just the sport
// and game id reliably lands on the right game's page, where ESPN's own
// "Watch" button and sign-in live. We never touch a password ourselves.
const ESPN_SPORT_SLUGS = {
  football: "college-football",
  baseball: "college-baseball",
};

function buildEspnGameUrl(sport, gameId) {
  const slug = ESPN_SPORT_SLUGS[sport] || sport;
  return `https://www.espn.com/${slug}/game/_/gameId/${gameId}`;
}

// ---------------------------------------------------------------------------
// League selection
//
// The Scores, Rankings, and Standings pages each show one league at a
// time (College Football, NFL, or College Baseball) rather than every
// sport at once. The choice is a personal display preference, not
// favorites or settings, so it's kept in localStorage rather than
// anything server-side, and it carries across those three pages so
// picking NFL on one and tapping over to another keeps NFL selected.
// News isn't part of this: there's no per-league content split for it
// yet, its feed stays one merged list regardless of league.
// ---------------------------------------------------------------------------

const LEAGUES = [
  { key: "football", label: "College Football" },
  { key: "nfl", label: "NFL" },
  { key: "baseball", label: "College Baseball" },
];
const LEAGUE_KEYS = LEAGUES.map((l) => l.key);
const LEAGUE_STORAGE_KEY = "selectedLeague";

function getSelectedLeague() {
  try {
    const stored = localStorage.getItem(LEAGUE_STORAGE_KEY);
    if (LEAGUE_KEYS.includes(stored)) return stored;
  } catch (err) {
    // Falls through to the default below.
  }
  return LEAGUE_KEYS[0];
}

function setSelectedLeague(key) {
  try {
    localStorage.setItem(LEAGUE_STORAGE_KEY, key);
  } catch (err) {
    // Not fatal, the choice just won't carry over to the next page load.
  }
}

// Builds the League tab strip for the Scores page, which (unlike
// Rankings and Standings) had no existing single-sport-at-a-time tab
// control to extend, it used to show both college sports stacked on
// one page at once. Reuses the .sub-tab styling those other two pages
// already use for their own sport tabs, for a consistent look.
function buildLeagueTabs(onSelect) {
  const container = el("div", "sub-tabs league-tabs");
  for (const league of LEAGUES) {
    const btn = el("button", "sub-tab", league.label);
    btn.type = "button";
    btn.classList.toggle("active", league.key === getSelectedLeague());
    btn.addEventListener("click", () => {
      if (getSelectedLeague() === league.key) return;
      setSelectedLeague(league.key);
      for (const child of container.children) child.classList.remove("active");
      btn.classList.add("active");
      onSelect(league.key);
    });
    container.appendChild(btn);
  }
  return container;
}

// ---------------------------------------------------------------------------
// Device identity and favorites
//
// No accounts here, just an anonymous id this device generates once and
// keeps in both localStorage and a cookie (redundant, so losing one
// doesn't lose the id). Favorites are stored server-side keyed by that
// id, and a short recovery code (see the settings page) lets the same
// id be restored on this device later, or adopted by another one.
// ---------------------------------------------------------------------------

function generateId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getCookie(name) {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name, value, days) {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem("device_id") || getCookie("device_id");
    if (!id) id = generateId();
    localStorage.setItem("device_id", id);
    setCookie("device_id", id, 365);
    return id;
  } catch (err) {
    console.warn("Could not persist a device id, favorites won't be saved", err);
    return generateId();
  }
}

function setDeviceId(id) {
  DEVICE_ID = id;
  try {
    localStorage.setItem("device_id", id);
    setCookie("device_id", id, 365);
  } catch (err) {
    console.warn("Could not persist the recovered device id", err);
  }
}

// The code, not the device id, is what favorites and settings are
// actually keyed by server-side, this device id is just a pointer to
// it. Stored the same redundant way (localStorage plus a cookie) so
// that if one gets cleared, the other still has it.
function getStoredCode() {
  try {
    return localStorage.getItem("device_code") || getCookie("device_code");
  } catch (err) {
    return null;
  }
}

function setStoredCode(code) {
  try {
    localStorage.setItem("device_code", code);
    setCookie("device_code", code, 365);
  } catch (err) {
    console.warn("Could not persist the device code locally", err);
  }
}

// Called once per page load, before anything that touches favorites.
// Sends whatever code this browser has cached, if any, alongside its
// device id: if the device id already belongs to a code, that's just
// confirmed and returned. If the device id is unrecognized but the
// cached code is real, this device silently gets reattached to it,
// the actual fix for a browser that lost its device id (Safari
// clearing storage, a fresh install) without losing the code stored
// alongside it. Only losing both leaves no way to self-heal, same
// limit "Link a device" already existed to cover by hand.
async function ensureDeviceRegistered() {
  try {
    const cachedCode = getStoredCode();
    const params = new URLSearchParams({ device_id: DEVICE_ID });
    if (cachedCode) params.set("code", cachedCode);
    const res = await fetch(`/api/device/code?${params}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    if (data.code) setStoredCode(data.code);
  } catch (err) {
    console.warn("Could not register this device", err);
  }
}

let DEVICE_ID = getOrCreateDeviceId();
let favoritesSet = new Set();

async function loadFavorites() {
  try {
    const res = await fetch(`/api/favorites?device_id=${encodeURIComponent(DEVICE_ID)}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    favoritesSet = new Set((data.favorites || []).map((f) => `${f.sport}:${f.team_id}`));
  } catch (err) {
    console.warn("Could not load favorites", err);
  }
}

function isFavorite(sport, teamId) {
  return favoritesSet.has(`${sport}:${teamId}`);
}

async function toggleFavorite(sport, team) {
  const key = `${sport}:${team.id}`;
  const nowFavorite = !favoritesSet.has(key);
  if (nowFavorite) favoritesSet.add(key);
  else favoritesSet.delete(key);

  try {
    if (nowFavorite) {
      await fetch("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: DEVICE_ID,
          sport,
          team_id: team.id,
          team_name: team.name,
          logo: team.logo || null,
        }),
      });
    } else {
      await fetch(`/api/favorites/${sport}/${team.id}?device_id=${encodeURIComponent(DEVICE_ID)}`, {
        method: "DELETE",
      });
    }
  } catch (err) {
    console.warn("Could not update favorite", err);
  }
  return nowFavorite;
}

function buildFavoriteStar(sport, team, onChange) {
  const btn = el("button", "fav-star");
  btn.type = "button";
  btn.setAttribute("aria-label", "Toggle favorite team");
  const active = isFavorite(sport, team.id);
  btn.textContent = active ? "★" : "☆";
  btn.classList.toggle("active", active);

  btn.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const nowFavorite = await toggleFavorite(sport, team);
    btn.textContent = nowFavorite ? "★" : "☆";
    btn.classList.toggle("active", nowFavorite);
    if (onChange) onChange();
  });

  return btn;
}

document.addEventListener("DOMContentLoaded", async () => {
  registerServiceWorker();
  await ensureDeviceRegistered();

  const page = document.body.dataset.page;
  if (page === "scoreboard") initScoreboardPage();
  else if (page === "game") initGamePage();
  else if (page === "team") initTeamPage();
  else if (page === "news") initNewsPage();
  else if (page === "rankings") initRankingsPage();
  else if (page === "standings") initStandingsPage();
  else if (page === "search") initSearchPage();
  else if (page === "settings") initSettingsPage();
  else if (page === "player") initPlayerPage();
});

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------------------
// Scoreboard page
// ---------------------------------------------------------------------------

const scoreboardState = {
  date: new Date(),
  conference: { football: "", nfl: "", baseball: "" },
  gamesBySport: { football: [], nfl: [], baseball: [] },
};

async function initScoreboardPage() {
  document.getElementById("prev-week").addEventListener("click", () => shiftDate(-7));
  document.getElementById("prev-day").addEventListener("click", () => shiftDate(-1));
  document.getElementById("next-day").addEventListener("click", () => shiftDate(1));
  document.getElementById("next-week").addEventListener("click", () => shiftDate(7));
  document.getElementById("today-btn").addEventListener("click", () => setDate(new Date()));

  initCompactViewToggle();

  // Fire-and-forget: silently re-registers an existing push
  // subscription with the backend on every visit to the scores page,
  // the page actually opened regularly, so alerts recover on their
  // own after a redeploy resets the backend's subscription storage,
  // without requiring a special trip back to settings.html.
  getAndResyncPushSubscription();

  document.getElementById("league-tabs-slot").appendChild(
    buildLeagueTabs((league) => {
      applyLeagueVisibility(league);
      renderMyTeams();
    })
  );
  applyLeagueVisibility(getSelectedLeague());

  for (const sport of LEAGUE_KEYS) {
    const select = document.getElementById(`${sport}-conference`);
    select.addEventListener("change", () => {
      scoreboardState.conference[sport] = select.value;
      loadSportScoreboard(sport);
    });
  }

  loadConferenceOptions();
  await loadFavorites();
  loadScoreboards();
  setInterval(loadScoreboards, SCOREBOARD_POLL_MS);
}

// Only one league's section is shown at a time, the game data for all
// three is still fetched together in the background (see
// loadScoreboards), so switching leagues is instant, no new fetch.
function applyLeagueVisibility(selectedLeague) {
  for (const key of LEAGUE_KEYS) {
    document.getElementById(`${key}-section`).hidden = key !== selectedLeague;
  }
}

// The compact view is a pure CSS restyle driven by a class on <body>,
// the same game-row markup renders either way. The choice is just a
// per-device display preference, so it lives in localStorage rather
// than anything synced through favorites or the backend.
const COMPACT_VIEW_STORAGE_KEY = "compactView";

function initCompactViewToggle() {
  const btn = document.getElementById("compact-toggle-btn");
  if (!btn) return;

  let isCompact = false;
  try {
    isCompact = localStorage.getItem(COMPACT_VIEW_STORAGE_KEY) === "1";
  } catch (err) {
    // localStorage can be unavailable (private browsing, disabled
    // storage), default view is a fine fallback.
  }
  applyCompactView(isCompact, btn);

  btn.addEventListener("click", () => {
    const next = !document.body.classList.contains("compact-view");
    applyCompactView(next, btn);
    try {
      localStorage.setItem(COMPACT_VIEW_STORAGE_KEY, next ? "1" : "0");
    } catch (err) {
      // Not fatal, the toggle still works for the rest of this visit.
    }
  });
}

function applyCompactView(isCompact, btn) {
  document.body.classList.toggle("compact-view", isCompact);
  btn.classList.toggle("active", isCompact);
  btn.setAttribute("aria-pressed", isCompact ? "true" : "false");
}

async function loadConferenceOptions() {
  for (const sport of LEAGUE_KEYS) {
    const select = document.getElementById(`${sport}-conference`);
    try {
      const res = await fetch(`/api/conferences/${sport}`);
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const data = await res.json();
      for (const conf of data.conferences || []) {
        const option = document.createElement("option");
        option.value = conf.id;
        option.textContent = conf.name;
        select.appendChild(option);
      }
    } catch (err) {
      // Not fatal, the "All Conferences" option still works fine.
      console.warn(`Could not load ${sport} conferences`, err);
    }
  }
}

function shiftDate(deltaDays) {
  const next = new Date(scoreboardState.date);
  next.setDate(next.getDate() + deltaDays);
  setDate(next);
}

function setDate(newDate) {
  scoreboardState.date = newDate;
  loadScoreboards();
}

function formatDateParam(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDateLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// ESPN's own pre-formatted status text ("Sat 7:00 PM EDT") bakes in
// Eastern time as a plain string, there's nothing reliable to convert
// there. Instead, for a game that hasn't started yet, this ignores
// that string entirely and reformats the game's raw UTC timestamp
// (every game object already carries one) into Central ourselves,
// using the IANA zone name rather than a fixed UTC offset so daylight
// saving is handled automatically instead of drifting an hour off for
// half the year.
const DISPLAY_TIME_ZONE = "America/Chicago";
const DISPLAY_TIME_ZONE_LABEL = "CT";

function formatCentralTime(isoDate) {
  if (!isoDate) return "";
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = date.toLocaleString("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatted} ${DISPLAY_TIME_ZONE_LABEL}`;
}

// Live status ("2nd - 7:32") and final status ("Final") carry no
// timezone information at all, ESPN's text is fine as-is there. Only
// a still-scheduled game's start time needs converting.
function displayGameStatus(game) {
  if (game.status_state === "pre") {
    const converted = formatCentralTime(game.date);
    if (converted) return converted;
  }
  return game.status_detail || "";
}

async function loadScoreboards() {
  document.getElementById("date-label").textContent = formatDateLabel(scoreboardState.date);
  await Promise.all(LEAGUE_KEYS.map((sport) => loadSportScoreboard(sport)));
}

// "Top 25" isn't a real ESPN conference id, it's a stand-in we filter
// for ourselves: fetch the day's games unfiltered, then keep only
// games with a team currently in that sport's AP Top 25, using the
// same rankings endpoint the Rankings tab already uses. Not offered
// for the NFL at all (see index.html, its dropdown has no Top 25
// option), there's no AP-style poll to filter against there.
//
// Keyed by team_id -> rank number rather than a plain Set, so the
// same cached fetch also backs the gamecast page's rank badge (see
// buildGameTeamBlock): the scoreboard and game-summary endpoints each
// try to read a rank straight off ESPN's own payload for that game,
// but ESPN doesn't reliably include it on every shape, this is the
// same confirmed-accurate rankings data as the Rankings tab, used as
// a fallback whenever a game's own data came back unranked.
const TOP25_FILTER_VALUE = "__top25__";
const rankedTeamsBySport = { football: null, nfl: null, baseball: null };

async function ensureRankedTeams(sport) {
  if (rankedTeamsBySport[sport]) return rankedTeamsBySport[sport];
  try {
    const res = await fetch(`/api/rankings/${sport}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    rankedTeamsBySport[sport] = new Map((data.ranks || []).map((r) => [r.team_id, r.rank]));
  } catch (err) {
    console.warn(`Could not load ${sport} rankings`, err);
    rankedTeamsBySport[sport] = new Map();
  }
  return rankedTeamsBySport[sport];
}

// Only football and baseball have an AP-style Top 25 to fall back to,
// same scope as the Top 25 scoreboard filter above; NFL "rank" data
// is playoff seeding, not a poll rank, and was never shown as this
// badge on the scoreboard either.
function rankFallbackSupported(sport) {
  return sport === "football" || sport === "baseball";
}

async function loadSportScoreboard(sport) {
  const container = document.getElementById(`${sport}-games`);
  const dateParam = formatDateParam(scoreboardState.date);
  const conference = scoreboardState.conference[sport];
  const isTop25Filter = conference === TOP25_FILTER_VALUE;

  let url = `/api/scoreboard/${sport}?date=${dateParam}`;
  if (conference && !isTop25Filter) url += `&conference=${encodeURIComponent(conference)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    let games = data.games || [];

    if (isTop25Filter) {
      const ranked = await ensureRankedTeams(sport);
      games = games.filter((game) => game.teams.some((t) => ranked.has(t.id)));
    }

    scoreboardState.gamesBySport[sport] = games;
    const emptyMessage = isTop25Filter ? "No ranked teams playing today." : undefined;
    renderGames(container, games, sport, emptyMessage);
    renderMyTeams();
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("p", "error", `Could not load ${sport} scores.`));
    console.error(err);
  }
}

function renderGames(container, games, sport, emptyMessage) {
  container.innerHTML = "";
  if (!games || games.length === 0) {
    container.appendChild(el("p", "empty", emptyMessage || "No games scheduled."));
    return;
  }
  for (const game of games) {
    container.appendChild(buildGameRow(game, sport));
  }
}

// Scoped to whichever league is currently selected, not every
// favorited team across all three at once, matching the rest of this
// page now showing one league at a time.
function renderMyTeams() {
  const section = document.getElementById("my-teams-section");
  const container = document.getElementById("my-teams-games");
  if (!section || !container) return;

  const sport = getSelectedLeague();
  const matches = (scoreboardState.gamesBySport[sport] || []).filter((game) =>
    game.teams.some((t) => isFavorite(sport, t.id))
  );

  if (matches.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  container.innerHTML = "";
  for (const game of matches) {
    container.appendChild(buildGameRow(game, sport));
  }
}

function buildGameRow(game, sport) {
  const row = el("div", "game-row");
  const away = game.teams.find((t) => t.home_away === "away") || game.teams[0];
  const home = game.teams.find((t) => t.home_away === "home") || game.teams[1];

  row.appendChild(buildTeamBlock(away, sport, `game.html?sport=${sport}&gameId=${game.id}`, game.situation));
  row.appendChild(buildStatusBlock(game));
  row.appendChild(buildTeamBlock(home, sport, `game.html?sport=${sport}&gameId=${game.id}`, game.situation));

  return row;
}

function buildTeamBlock(team, sport, logoHref, situation) {
  const block = el("div", "team-block");

  // The logo and name stay together as one group, closest to the
  // card's outer edge, with the favorite star and possession marker
  // in their own narrow stack between that group and the score, using
  // the horizontal room freed up by no longer centering the whole
  // team-block within its (much wider) grid column.
  const iconGroup = el("div", "team-icon-group");

  const link = el("a", "team-logo-link");
  link.href = logoHref;

  const logo = el("img", "team-logo");
  logo.src = (team && team.logo) || "icons/team-placeholder.png";
  logo.alt = team ? team.name : "TBD";
  logo.loading = "lazy";
  link.appendChild(logo);

  // AP Top 25 only, nothing shown at all for an unranked team.
  if (team && team.rank) {
    link.appendChild(el("span", "team-rank-badge", String(team.rank)));
  }

  iconGroup.appendChild(link);
  iconGroup.appendChild(el("div", "team-name", team ? team.abbreviation || team.name : "TBD"));
  block.appendChild(iconGroup);

  const iconsStack = el("div", "team-icons-stack");
  if (team) {
    iconsStack.appendChild(buildFavoriteStar(sport, team, renderMyTeams));
  }
  // Football only in practice, since situation.possession_team_id is
  // always null for baseball, shown in both the default and compact
  // views since it lives on the team-block rather than the
  // regular-view-only status-block.
  if (team && situation && situation.possession_team_id === team.id) {
    iconsStack.appendChild(el("span", "possession-marker", "🏈"));
  }
  block.appendChild(iconsStack);

  const score = team && team.score !== null && team.score !== undefined ? team.score : "";
  block.appendChild(el("div", "team-score", score));

  return block;
}

function buildStatusBlock(game) {
  const block = el("div", "status-block");
  if (game.status_state === "in") block.classList.add("live");
  block.appendChild(el("div", "status-detail", displayGameStatus(game)));
  // Down-and-distance (football) or count/outs/runners (baseball),
  // regular view only, hidden in compact view by CSS.
  if (game.situation && game.situation.text) {
    block.appendChild(el("div", "situation-text", game.situation.text));
  }
  if (game.broadcast) {
    block.appendChild(el("div", "broadcast", game.broadcast));
  }
  block.appendChild(buildWatchLink(game.sport, game.id));
  return block;
}

function buildWatchLink(sport, gameId) {
  const link = el("a", "watch-link", "Watch on ESPN");
  link.href = buildEspnGameUrl(sport, gameId);
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

// ---------------------------------------------------------------------------
// Game (box score) page
// ---------------------------------------------------------------------------

async function initGamePage() {
  const params = new URLSearchParams(window.location.search);
  const sport = params.get("sport");
  const gameId = params.get("gameId");
  const content = document.getElementById("game-content");

  if (!sport || !gameId) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Missing game reference."));
    return;
  }
  await loadFavorites();
  await loadGame(sport, gameId);

  // Keep polling while the game could still change. Stops itself once
  // the game goes final, same 30-second floor as the rest of the app.
  const pollTimer = setInterval(async () => {
    const stillLive = await loadGame(sport, gameId);
    if (!stillLive) clearInterval(pollTimer);
  }, SCOREBOARD_POLL_MS);
}

async function loadGame(sport, gameId) {
  const content = document.getElementById("game-content");
  try {
    const res = await fetch(`/api/game/${sport}/${gameId}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    await renderGame(content, data, sport);
    return data.status_state !== "post";
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Could not load this game."));
    console.error(err);
    return true; // a transient fetch error shouldn't permanently stop polling
  }
}

async function renderGame(content, data, sport) {
  content.innerHTML = "";

  // ESPN's own game-summary payload doesn't reliably carry a team's
  // current rank the way its scoreboard payload does, so a team.rank
  // that came back empty here falls back to the same Top 25 rankings
  // data the scoreboard's badge and filter already rely on, rather
  // than the header silently showing no rank at all for a ranked team.
  const rankedTeams = rankFallbackSupported(sport) ? await ensureRankedTeams(sport) : null;

  // Everything about "the game right now" — the score, who has the
  // ball, status/broadcast/venue — reads as one card, the same way a
  // scoreboard row is one visual unit rather than several loose lines.
  const matchupCard = el("div", "info-card matchup-card");

  const header = el("div", "game-header");
  for (const team of data.teams) {
    header.appendChild(buildGameTeamBlock(team, sport, rankedTeams));
  }
  matchupCard.appendChild(header);

  if (data.situation && data.situation.text) {
    const strip = el("p", "situation-strip", data.situation.text);
    if (data.situation.is_red_zone) strip.classList.add("red-zone");
    matchupCard.appendChild(strip);
  }

  matchupCard.appendChild(el("p", "status-detail", displayGameStatus(data)));
  if (data.broadcast) {
    matchupCard.appendChild(el("p", "broadcast", data.broadcast));
  }
  if (data.venue && data.venue.name) {
    matchupCard.appendChild(el("p", "venue-line", formatVenue(data.venue)));
  }
  matchupCard.appendChild(buildWatchLink(sport, data.id));
  content.appendChild(matchupCard);

  const home = data.teams.find((t) => t.home_away === "home");
  const away = data.teams.find((t) => t.home_away === "away");
  if (data.win_probability && data.win_probability.length > 1 && home && away) {
    content.appendChild(buildWinProbabilityChart(data.win_probability, home, away));
  }

  if (data.teams.some((t) => t.linescores && t.linescores.length > 0)) {
    content.appendChild(buildLineScoreTable(data.teams));
  }

  if (data.team_stats && data.team_stats.length > 0) {
    content.appendChild(buildTeamStatsTable(data.team_stats));
  }

  if (data.player_stats && data.player_stats.length > 0) {
    content.appendChild(buildPlayerBoxScores(data.player_stats, sport, data.teams));
  }

  if (data.scoring_plays && data.scoring_plays.length > 0) {
    content.appendChild(buildScoringPlaysList(data.scoring_plays));
  }
}

function formatVenue(venue) {
  const parts = [venue.name];
  if (venue.city) parts.push(venue.state ? `${venue.city}, ${venue.state}` : venue.city);
  if (venue.attendance) parts.push(`${venue.attendance.toLocaleString()} attending`);
  return parts.filter(Boolean).join(" · ");
}

function buildGameTeamBlock(team, sport, rankedTeams) {
  const block = el("div", "team-block");

  const link = el("a", "team-logo-link");
  link.href = `team.html?sport=${sport}&teamId=${team.id}`;
  const logo = el("img", "team-logo large");
  logo.src = team.logo || "icons/team-placeholder.png";
  logo.alt = team.name;
  link.appendChild(logo);

  // Same badge, overlaid on the logo the same way, as the scoreboard's
  // team-block (see buildTeamBlock) — this game's own rank if it has
  // one, else whatever the Top 25 rankings fallback knows, else
  // nothing at all for an unranked team.
  const rank = team.rank || (rankedTeams ? rankedTeams.get(team.id) : undefined);
  if (rank) {
    link.appendChild(el("span", "team-rank-badge", String(rank)));
  }

  block.appendChild(link);

  block.appendChild(el("div", "team-name", team.name));
  if (team.record) block.appendChild(el("div", "team-record", team.record));
  block.appendChild(buildFavoriteStar(sport, team));
  block.appendChild(el("div", "team-score large", team.score ?? ""));

  return block;
}

function buildWinProbabilityChart(points, homeTeam, awayTeam) {
  const wrapper = el("div", "win-prob info-card");
  wrapper.appendChild(el("h2", null, "Win Probability"));

  const width = 300;
  const height = 70;
  const stepX = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * stepX).toFixed(1)},${(height - (p / 100) * height).toFixed(1)}`);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "win-prob-chart");
  svg.setAttribute("preserveAspectRatio", "none");

  const midline = document.createElementNS(svgNS, "line");
  midline.setAttribute("x1", "0");
  midline.setAttribute("x2", String(width));
  midline.setAttribute("y1", String(height / 2));
  midline.setAttribute("y2", String(height / 2));
  midline.setAttribute("class", "win-prob-midline");
  svg.appendChild(midline);

  // A soft fill under the line, purely decorative, closes the same
  // points back along the bottom edge so it reads as an area rather
  // than an odd unclosed shape.
  const area = document.createElementNS(svgNS, "polygon");
  area.setAttribute("points", `0,${height} ${coords.join(" ")} ${width},${height}`);
  area.setAttribute("class", "win-prob-area");
  svg.appendChild(area);

  const polyline = document.createElementNS(svgNS, "polyline");
  polyline.setAttribute("points", coords.join(" "));
  polyline.setAttribute("class", "win-prob-line");
  svg.appendChild(polyline);

  wrapper.appendChild(svg);

  const latest = points[points.length - 1];
  const labels = el("div", "win-prob-labels");
  labels.appendChild(el("span", null, `${awayTeam.abbreviation || awayTeam.name}: ${Math.round(100 - latest)}%`));
  labels.appendChild(el("span", null, `${homeTeam.abbreviation || homeTeam.name}: ${Math.round(latest)}%`));
  wrapper.appendChild(labels);

  return wrapper;
}

function buildPlayerBoxScores(playerStats, sport, teams) {
  // Each team gets its own card, rather than both sharing one, so a
  // long box score (kicking, kick returns, defense, ...) doesn't read
  // as one indistinct wall split only by an internal divider.
  const wrapper = el("div", "player-box-scores");
  wrapper.appendChild(el("h2", "section-label", "Player Stats"));

  for (const teamEntry of playerStats) {
    const teamBlock = el("div", "box-score-team info-card");

    // Purely decorative: a team's own primary color (when ESPN
    // supplies one) washes the top of its card and tints its accent
    // border, via a CSS variable rather than a generated class, so a
    // color that isn't there yet just falls back to the plain card
    // look already used everywhere else.
    const matchingTeam = (teams || []).find((t) => t.id === teamEntry.team_id);
    if (matchingTeam && matchingTeam.color) {
      teamBlock.style.setProperty("--team-color", matchingTeam.color);
    }

    teamBlock.appendChild(el("h3", null, teamEntry.team_name));

    for (const group of teamEntry.groups) {
      if (!group.athletes || group.athletes.length === 0) continue;

      const groupWrapper = el("div", "box-score-group");
      groupWrapper.appendChild(el("h4", null, group.category));

      const table = el("table", "data-table");
      const headRow = document.createElement("tr");
      headRow.appendChild(document.createElement("th"));
      for (const stat of group.athletes[0].stats) {
        headRow.appendChild(el("th", null, stat.label));
      }
      table.appendChild(headRow);

      for (const athlete of group.athletes) {
        const row = document.createElement("tr");
        const nameCell = document.createElement("td");
        const nameLink = el("a", null, athlete.name);
        nameLink.href = `player.html?sport=${sport}&teamId=${teamEntry.team_id}&playerId=${athlete.id}&name=${encodeURIComponent(athlete.name)}`;
        nameCell.appendChild(nameLink);
        row.appendChild(nameCell);
        for (const stat of athlete.stats) {
          row.appendChild(el("td", null, stat.value ?? ""));
        }
        table.appendChild(row);
      }

      groupWrapper.appendChild(table);
      teamBlock.appendChild(groupWrapper);
    }
    wrapper.appendChild(teamBlock);
  }

  return wrapper;
}

function buildLineScoreTable(teams) {
  const wrapper = el("div", "line-score info-card");
  wrapper.appendChild(el("h2", null, "Line Score"));

  const table = el("table", "data-table");
  const periodCounts = teams.map((t) => (t.linescores || []).length);
  const maxPeriods = Math.max(0, ...periodCounts);

  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (let i = 1; i <= maxPeriods; i++) {
    headRow.appendChild(el("th", null, String(i)));
  }
  headRow.appendChild(el("th", null, "T"));
  table.appendChild(headRow);

  for (const team of teams) {
    const row = document.createElement("tr");
    row.appendChild(el("td", null, team.abbreviation || team.name));
    for (let i = 0; i < maxPeriods; i++) {
      row.appendChild(el("td", null, (team.linescores || [])[i] ?? ""));
    }
    row.appendChild(el("td", "line-score-total", team.score ?? ""));
    table.appendChild(row);
  }

  wrapper.appendChild(table);
  return wrapper;
}

function buildTeamStatsTable(teamStats) {
  const wrapper = el("div", "team-stats info-card");
  wrapper.appendChild(el("h2", null, "Team Stats"));

  const statNames = new Set();
  for (const ts of teamStats) {
    Object.keys(ts.stats || {}).forEach((name) => statNames.add(name));
  }

  const table = el("table", "data-table");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const ts of teamStats) {
    headRow.appendChild(el("th", null, ts.abbreviation || ts.team));
  }
  table.appendChild(headRow);

  for (const statName of statNames) {
    const row = document.createElement("tr");
    row.appendChild(el("td", null, statName));
    for (const ts of teamStats) {
      row.appendChild(el("td", null, (ts.stats || {})[statName] ?? ""));
    }
    table.appendChild(row);
  }

  wrapper.appendChild(table);
  return wrapper;
}

function buildScoringPlaysList(plays) {
  const wrapper = el("div", "scoring-plays info-card");
  wrapper.appendChild(el("h2", null, "Scoring Plays"));

  const list = document.createElement("ul");
  for (const play of plays) {
    const hasScore = play.away_score !== undefined && play.home_score !== undefined;
    const scoreText = hasScore ? ` (${play.away_score}-${play.home_score})` : "";
    list.appendChild(el("li", null, `${play.text || ""}${scoreText}`));
  }
  wrapper.appendChild(list);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Team (school) page: a sport toggle plus Schedule / Stats / Roster
//
// The URL only ever names one sport and one team id (wherever the link
// came from). The other sport's team id isn't something we can assume,
// ESPN doesn't guarantee the same school shares one id across sports,
// so switching sport tabs resolves the sibling team by matching this
// school's name against that sport's full team list rather than
// guessing. If no match is found, that sport just isn't offered.
// ---------------------------------------------------------------------------

const teamPageState = {
  sport: null,
  teamName: null,
  section: "schedule",
  bySport: {
    football: { teamId: null, resolved: false, name: null, schedule: null, stats: null, roster: null, leaders: null },
    baseball: { teamId: null, resolved: false, name: null, schedule: null, stats: null, roster: null, leaders: null },
    // An NFL franchise has no college sibling to resolve, so it never
    // shows the sport-toggle at all (see initTeamPage), but it still
    // needs an entry here or a direct link straight to an NFL team
    // (from Search, Rankings, or Standings) would be rejected as an
    // unrecognized sport before ever reaching that check.
    nfl: { teamId: null, resolved: false, name: null, schedule: null, stats: null, roster: null, leaders: null },
  },
};

async function initTeamPage() {
  const params = new URLSearchParams(window.location.search);
  const sport = params.get("sport");
  const teamId = params.get("teamId");
  const content = document.getElementById("team-content-area");

  if (!sport || !teamId || !teamPageState.bySport[sport]) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Missing team reference."));
    return;
  }

  await loadFavorites();

  teamPageState.sport = sport;
  teamPageState.bySport[sport].teamId = teamId;
  teamPageState.bySport[sport].resolved = true;

  // The sport-toggle only ever offers switching between a school's
  // college football and college baseball programs, an NFL franchise
  // has no sibling to resolve at all, so the toggle just doesn't
  // render there rather than offering a switch that can't work.
  document.getElementById("team-sport-toggle").hidden = sport === "nfl";

  for (const s of SPORTS) {
    document.getElementById(`team-sport-${s}`).addEventListener("click", () => switchTeamSport(s));
  }
  for (const section of ["schedule", "stats", "roster"]) {
    document.getElementById(`team-section-${section}`).addEventListener("click", () => switchTeamSection(section));
  }

  updateTeamSportTabs();
  await ensureScheduleLoaded(sport);
  teamPageState.teamName = teamPageState.bySport[sport].name;
  renderTeamHeading();
  await renderTeamSection();
}

async function switchTeamSport(sport) {
  teamPageState.sport = sport;
  updateTeamSportTabs();

  const entry = teamPageState.bySport[sport];
  const content = document.getElementById("team-content-area");
  if (!entry.resolved) {
    content.innerHTML = "";
    content.appendChild(el("p", "loading", "Loading..."));
    await resolveSiblingTeam(sport);
  }

  renderTeamHeading();
  await renderTeamSection();
}

async function resolveSiblingTeam(sport) {
  const entry = teamPageState.bySport[sport];
  try {
    const res = await fetch(`/api/teams/${sport}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    const teams = data.teams || [];
    const targetName = (teamPageState.teamName || "").toLowerCase();

    let match = teams.find((t) => t.name.toLowerCase() === targetName);
    if (!match && targetName) {
      const firstWord = targetName.split(" ")[0];
      match = teams.find((t) => t.name.toLowerCase().startsWith(firstWord));
    }

    entry.teamId = match ? match.id : null;
    entry.name = match ? match.name : null;
  } catch (err) {
    console.warn(`Could not resolve this school's ${sport} team`, err);
    entry.teamId = null;
  }
  entry.resolved = true;
}

function switchTeamSection(section) {
  teamPageState.section = section;
  updateTeamSectionTabs();
  renderTeamSection();
}

function updateTeamSportTabs() {
  for (const s of SPORTS) {
    document.getElementById(`team-sport-${s}`).classList.toggle("active", teamPageState.sport === s);
  }
}

function updateTeamSectionTabs() {
  for (const section of ["schedule", "stats", "roster"]) {
    document.getElementById(`team-section-${section}`).classList.toggle("active", teamPageState.section === section);
  }
}

function renderTeamHeading() {
  const heading = document.getElementById("team-heading");
  const starContainer = document.getElementById("team-star-container");
  heading.textContent = teamPageState.teamName || "Team";

  starContainer.innerHTML = "";
  const entry = teamPageState.bySport[teamPageState.sport];
  if (entry.teamId) {
    starContainer.appendChild(
      buildFavoriteStar(teamPageState.sport, { id: entry.teamId, name: teamPageState.teamName, logo: null })
    );
  }
}

async function renderTeamSection() {
  const content = document.getElementById("team-content-area");
  const sport = teamPageState.sport;
  const entry = teamPageState.bySport[sport];

  if (!entry.teamId) {
    content.innerHTML = "";
    content.appendChild(el("p", "empty", `No ${sport} program found for this school.`));
    return;
  }

  content.innerHTML = "";
  content.appendChild(el("p", "loading", "Loading..."));

  if (teamPageState.section === "schedule") {
    await ensureScheduleLoaded(sport);
    renderScheduleSection(content, entry, sport);
  } else if (teamPageState.section === "stats") {
    await Promise.all([ensureScheduleLoaded(sport), ensureStatsLoaded(sport), ensureLeadersLoaded(sport)]);
    renderStatsSection(content, entry, sport);
  } else if (teamPageState.section === "roster") {
    await ensureRosterLoaded(sport);
    renderRosterSection(content, entry, sport);
  }
}

async function ensureScheduleLoaded(sport) {
  const entry = teamPageState.bySport[sport];
  if (entry.schedule || !entry.teamId) return;
  try {
    const res = await fetch(`/api/team/${sport}/${entry.teamId}/schedule`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    entry.schedule = data.games || [];
    entry.name = data.team_name || entry.name;
    if (!teamPageState.teamName) teamPageState.teamName = entry.name;
  } catch (err) {
    entry.schedule = [];
    console.warn(`Could not load ${sport} schedule`, err);
  }
}

async function ensureStatsLoaded(sport) {
  const entry = teamPageState.bySport[sport];
  if (entry.stats || !entry.teamId) return;
  try {
    const res = await fetch(`/api/team/${sport}/${entry.teamId}/stats`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    entry.stats = data.categories || [];
  } catch (err) {
    entry.stats = [];
    console.warn(`Could not load ${sport} team stats`, err);
  }
}

async function ensureLeadersLoaded(sport) {
  const entry = teamPageState.bySport[sport];
  if (entry.leaders || !entry.teamId) return;
  try {
    const res = await fetch(`/api/team/${sport}/${entry.teamId}/leaders`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    entry.leaders = data.leaders || {};
  } catch (err) {
    entry.leaders = {};
    console.warn(`Could not load ${sport} team leaders`, err);
  }
}

async function ensureRosterLoaded(sport) {
  const entry = teamPageState.bySport[sport];
  if (entry.roster || !entry.teamId) return;
  try {
    const res = await fetch(`/api/team/${sport}/${entry.teamId}/roster`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    entry.roster = data.players || [];
  } catch (err) {
    entry.roster = [];
    console.warn(`Could not load ${sport} roster`, err);
  }
}

function renderScheduleSection(content, entry, sport) {
  content.innerHTML = "";
  const games = entry.schedule || [];
  if (games.length === 0) {
    content.appendChild(el("p", "empty", "No schedule available."));
    return;
  }
  const list = el("div", "schedule-list");
  for (const game of games) {
    list.appendChild(buildScheduleRow(game, sport));
  }
  content.appendChild(list);
}

function renderStatsSection(content, entry, sport) {
  content.innerHTML = "";

  const highlights = buildTeamHighlights(entry, sport);
  if (highlights) content.appendChild(highlights);

  const categoriesContainer = el("div");
  content.appendChild(categoriesContainer);
  renderStatCategories(categoriesContainer, entry.stats || [], "No team stats available right now.");
}

// ---------------------------------------------------------------------------
// Highlight tiles: a team's win record and statistical leaders, or a
// player's position-specific headline numbers. Both render as the
// same small tile row, just built from different data.
// ---------------------------------------------------------------------------

function buildHighlightTile(label, value, sub) {
  const tile = el("div", "highlight-tile");
  tile.appendChild(el("div", "highlight-value", value));
  tile.appendChild(el("div", "highlight-label", label));
  if (sub) tile.appendChild(el("div", "highlight-sub", sub));
  return tile;
}

function computeRecord(schedule) {
  const decided = (schedule || []).filter((g) => g.result === "W" || g.result === "L");
  if (decided.length === 0) return null;
  const wins = decided.filter((g) => g.result === "W").length;
  return { wins, losses: decided.length - wins, pct: wins / decided.length };
}

function buildTeamHighlights(entry, sport) {
  const tiles = el("div", "highlight-tiles");

  const record = computeRecord(entry.schedule);
  if (record) {
    tiles.appendChild(buildHighlightTile("Win %", `${Math.round(record.pct * 100)}%`, `${record.wins}-${record.losses}`));
  }

  // Passing/rushing/receiving leaders are a football concept, college
  // or pro, the backend only computes them for those two sports.
  if ((sport === "football" || sport === "nfl") && entry.leaders) {
    const leaderSpecs = [
      { key: "passing", label: "Passing Leader" },
      { key: "rushing", label: "Rushing Leader" },
      { key: "receiving", label: "Receiving Leader" },
    ];
    for (const spec of leaderSpecs) {
      const leader = entry.leaders[spec.key];
      if (leader) tiles.appendChild(buildLeaderTile(spec.label, leader, sport, entry.teamId));
    }
  }

  if (tiles.children.length === 0) return null;
  const wrapper = el("div", "team-highlights");
  wrapper.appendChild(tiles);
  return wrapper;
}

function buildLeaderTile(label, leader, sport, teamId) {
  const params = new URLSearchParams({
    sport,
    teamId: teamId || "",
    playerId: leader.id,
    name: leader.name || "",
    jersey: leader.jersey || "",
    position: leader.position || "",
    headshot: leader.headshot || "",
    height: leader.height || "",
    weight: leader.weight || "",
    playerClass: leader.class || "",
  });

  const tile = el("a", "highlight-tile leader-tile");
  tile.href = `player.html?${params.toString()}`;
  tile.appendChild(el("div", "highlight-value", leader.value != null ? `${leader.value} yds` : ""));
  tile.appendChild(el("div", "highlight-label", label));
  tile.appendChild(el("div", "highlight-sub", leader.name));
  return tile;
}

// Position-specific headline stats shown under a player's photo. Only
// the QB entries (Passing/Rushing labels) are confirmed against real
// ESPN data; the rest follow the same naming convention as a
// best-effort guess and may need a label adjusted once seen against a
// real player at that position. A position with no curated list here,
// or one where none of its listed stats are actually present (offensive
// linemen typically have no individually tracked stats at all), simply
// shows nothing, the full stat tables below still render whatever ESPN
// does provide.
const POSITION_GROUPS = {
  QB: "QB",
  RB: "RB",
  FB: "RB",
  HB: "RB",
  WR: "WR",
  TE: "TE",
  OT: "OL",
  OG: "OL",
  OL: "OL",
  C: "OL",
  G: "OL",
  T: "OL",
  DT: "DL",
  DE: "DL",
  DL: "DL",
  NT: "DL",
  LB: "LB",
  ILB: "LB",
  OLB: "LB",
  MLB: "LB",
  CB: "DB",
  S: "DB",
  FS: "DB",
  SS: "DB",
  DB: "DB",
  K: "K",
  PK: "K",
  P: "P",
};

const POSITION_KEY_STATS = {
  QB: [
    { display: "Total Yards", compute: "sum", labels: ["Passing Yards", "Rushing Yards"] },
    { display: "Comp %", labels: ["Completion Percentage"] },
    { display: "TD:INT", compute: "ratio", labels: ["Passing Touchdowns", "Interceptions"] },
  ],
  RB: [
    { display: "Rushing Yards", labels: ["Rushing Yards"] },
    { display: "Yards/Carry", labels: ["Yards Per Rush Attempt"] },
    { display: "Rushing TDs", labels: ["Rushing Touchdowns"] },
    { display: "Receiving Yards", labels: ["Receiving Yards"] },
  ],
  WR: [
    { display: "Receiving Yards", labels: ["Receiving Yards"] },
    { display: "Receptions", labels: ["Receptions"] },
    { display: "Yards/Catch", labels: ["Yards Per Reception"] },
    { display: "Receiving TDs", labels: ["Receiving Touchdowns"] },
  ],
  TE: [
    { display: "Receiving Yards", labels: ["Receiving Yards"] },
    { display: "Receptions", labels: ["Receptions"] },
    { display: "Receiving TDs", labels: ["Receiving Touchdowns"] },
  ],
  DL: [
    { display: "Total Tackles", labels: ["Total Tackles"] },
    { display: "Sacks", labels: ["Sacks"] },
    { display: "Tackles For Loss", labels: ["Tackles For Loss"] },
  ],
  LB: [
    { display: "Total Tackles", labels: ["Total Tackles"] },
    { display: "Sacks", labels: ["Sacks"] },
    { display: "Interceptions", labels: ["Interceptions"] },
    { display: "Tackles For Loss", labels: ["Tackles For Loss"] },
  ],
  DB: [
    { display: "Interceptions", labels: ["Interceptions"] },
    { display: "Passes Defended", labels: ["Passes Defended"] },
    { display: "Total Tackles", labels: ["Total Tackles"] },
  ],
  K: [
    { display: "FG Made", labels: ["Field Goals Made"] },
    { display: "FG %", labels: ["Field Goal Percentage"] },
    { display: "Long", labels: ["Long Field Goal Made"] },
  ],
  P: [
    { display: "Punts", labels: ["Punts"] },
    { display: "Yards/Punt", labels: ["Yards Per Punt"] },
    { display: "Long", labels: ["Long Punt"] },
  ],
};

function findStatValue(categories, label) {
  for (const category of categories || []) {
    for (const stat of category.stats || []) {
      if (stat.label === label) return stat.value;
    }
  }
  return null;
}

function computeKeyStat(spec, categories) {
  const values = spec.labels.map((label) => findStatValue(categories, label));
  if (values.some((v) => v === null || v === undefined)) return null;

  if (spec.compute === "sum") {
    const nums = values.map(Number);
    if (nums.some((n) => Number.isNaN(n))) return null;
    return String(nums.reduce((a, b) => a + b, 0));
  }
  if (spec.compute === "ratio") {
    return `${values[0]}:${values[1]}`;
  }
  return values[0];
}

function renderPlayerKeyStats(container, position, categories) {
  container.innerHTML = "";
  const group = POSITION_GROUPS[(position || "").toUpperCase()];
  const specs = group ? POSITION_KEY_STATS[group] : null;
  if (!specs) return;

  const found = [];
  for (const spec of specs) {
    const value = computeKeyStat(spec, categories);
    if (value !== null) found.push({ spec, value });
  }
  if (found.length === 0) return;

  const row = el("div", "highlight-tiles");
  for (const { spec, value } of found.slice(0, 5)) {
    row.appendChild(buildHighlightTile(spec.display, value));
  }
  container.appendChild(row);
}

// Shared by the team stats sub-tab and the individual player page,
// since both are just a list of {category, stats: [{label, value}]}.
function renderStatCategories(content, categories, emptyMessage) {
  content.innerHTML = "";
  if (!categories || categories.length === 0) {
    content.appendChild(el("p", "empty", emptyMessage));
    return;
  }
  for (const category of categories) {
    const wrapper = el("div", "team-stats");
    wrapper.appendChild(el("h2", null, category.category));
    const table = document.createElement("table");
    for (const stat of category.stats) {
      const row = document.createElement("tr");
      row.appendChild(el("td", null, stat.label));
      row.appendChild(el("td", null, stat.value ?? ""));
      table.appendChild(row);
    }
    wrapper.appendChild(table);
    content.appendChild(wrapper);
  }
}

function renderRosterSection(content, entry, sport) {
  content.innerHTML = "";
  const players = entry.roster || [];
  if (players.length === 0) {
    content.appendChild(el("p", "empty", "No roster available right now."));
    return;
  }
  const list = el("div", "roster-list");
  for (const player of players) {
    list.appendChild(buildRosterRow(player, sport, entry.teamId));
  }
  content.appendChild(list);
}

function buildRosterRow(player, sport, teamId) {
  const row = el("a", "roster-row");
  const params = new URLSearchParams({
    sport,
    teamId,
    playerId: player.id,
    name: player.name || "",
    jersey: player.jersey || "",
    position: player.position || "",
    headshot: player.headshot || "",
    height: player.height || "",
    weight: player.weight || "",
    playerClass: player.class || "",
  });
  row.href = `player.html?${params.toString()}`;

  const photo = el("img", "roster-photo");
  photo.src = player.headshot || "icons/team-placeholder.png";
  photo.alt = player.name;
  photo.loading = "lazy";
  row.appendChild(photo);

  const body = el("div", "roster-body");
  body.appendChild(el("div", "roster-name", player.name));
  const metaParts = [player.position, player.jersey ? `#${player.jersey}` : null, player.class].filter(Boolean);
  body.appendChild(el("div", "roster-meta", metaParts.join(" · ")));
  row.appendChild(body);

  return row;
}

function buildScheduleRow(game, sport) {
  const row = el("div", "schedule-row");

  const dateLabel = game.date
    ? new Date(game.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "";
  row.appendChild(el("div", "schedule-date", dateLabel));

  if (game.opponent) {
    const link = el("a", "team-logo-link");
    link.href = `team.html?sport=${sport}&teamId=${game.opponent.id}`;
    const logo = el("img", "team-logo small");
    logo.src = game.opponent.logo || "icons/team-placeholder.png";
    logo.alt = game.opponent.name;
    link.appendChild(logo);
    row.appendChild(link);

    const prefix = game.is_home ? "vs " : "@ ";
    row.appendChild(el("div", "team-name", prefix + game.opponent.name));
  } else {
    row.appendChild(document.createElement("div"));
    row.appendChild(el("div", "team-name", "TBD"));
  }

  const statusText = displayGameStatus(game);
  const statusLink = el("a", "schedule-status", game.result ? `${game.result} · ${statusText}` : statusText);
  statusLink.href = `game.html?sport=${sport}&gameId=${game.id}`;
  row.appendChild(statusLink);

  return row;
}

// ---------------------------------------------------------------------------
// News page
// ---------------------------------------------------------------------------

const newsState = {
  source: "",
};

function initNewsPage() {
  const select = document.getElementById("news-source");
  select.addEventListener("change", () => {
    newsState.source = select.value;
    loadNews();
  });

  loadNewsSources();
  loadNews();
}

async function loadNewsSources() {
  const select = document.getElementById("news-source");
  try {
    const res = await fetch("/api/news/sources");
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    for (const source of data.sources || []) {
      const option = document.createElement("option");
      option.value = source.id;
      option.textContent = source.name;
      select.appendChild(option);
    }
  } catch (err) {
    // Not fatal, "All Sources" still works fine.
    console.warn("Could not load news sources", err);
  }
}

async function loadNews() {
  const list = document.getElementById("news-list");
  let url = "/api/news";
  if (newsState.source) url += `?source=${encodeURIComponent(newsState.source)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderNews(list, data.articles);
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", "error", "Could not load news."));
    console.error(err);
  }
}

function renderNews(list, articles) {
  list.innerHTML = "";
  if (!articles || articles.length === 0) {
    list.appendChild(el("p", "empty", "No articles available right now."));
    return;
  }
  for (const article of articles) {
    list.appendChild(buildNewsCard(article));
  }
}

function buildNewsCard(article) {
  const card = el("a", "news-card");
  card.href = article.link || "#";
  card.target = "_blank";
  card.rel = "noopener";

  const thumb = el("img", "news-thumb");
  thumb.src = article.image || "icons/team-placeholder.png";
  thumb.alt = "";
  thumb.loading = "lazy";
  card.appendChild(thumb);

  const body = el("div", "news-body");
  body.appendChild(el("div", "news-headline", article.headline || "Untitled"));
  if (article.description) {
    body.appendChild(el("div", "news-description", article.description));
  }
  body.appendChild(el("div", "news-meta", article.source_name || ""));
  card.appendChild(body);

  return card;
}

// ---------------------------------------------------------------------------
// Rankings page
// ---------------------------------------------------------------------------

const rankingsState = { sport: getSelectedLeague() };

function initRankingsPage() {
  for (const sport of LEAGUE_KEYS) {
    document.getElementById(`rankings-${sport}-tab`).addEventListener("click", () => {
      rankingsState.sport = sport;
      setSelectedLeague(sport);
      updateRankingsSportTabs();
      loadRankings();
    });
  }
  updateRankingsSportTabs();
  loadRankings();
}

function updateRankingsSportTabs() {
  for (const sport of LEAGUE_KEYS) {
    document.getElementById(`rankings-${sport}-tab`).classList.toggle("active", rankingsState.sport === sport);
  }
}

async function loadRankings() {
  const list = document.getElementById("rankings-list");
  list.innerHTML = "";

  const heading = document.getElementById("rankings-heading");
  heading.textContent = rankingsState.sport === "nfl" ? "Playoff Seeding" : "AP Top 25";

  // There's no AP/Coaches poll for the NFL, ESPN has nothing to serve
  // here for it. A playoff-seeding view is the planned replacement for
  // this tab specifically, not built yet, so this says so plainly
  // instead of firing a request guaranteed to fail.
  if (rankingsState.sport === "nfl") {
    list.appendChild(el("p", "empty", "NFL playoff seeding is coming in a future update."));
    return;
  }

  list.appendChild(el("p", "loading", "Loading..."));

  try {
    const res = await fetch(`/api/rankings/${rankingsState.sport}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderRankings(list, data.ranks);
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", "error", "Could not load rankings."));
    console.error(err);
  }
}

function renderRankings(list, ranks) {
  list.innerHTML = "";
  if (!ranks || ranks.length === 0) {
    list.appendChild(el("p", "empty", "No rankings available right now."));
    return;
  }
  for (const rank of ranks) {
    list.appendChild(buildRankRow(rank));
  }
}

function buildRankRow(rank) {
  const row = el("a", "rank-row");
  row.href = `team.html?sport=${rankingsState.sport}&teamId=${rank.team_id}`;

  row.appendChild(el("div", "rank-number", rank.rank != null ? String(rank.rank) : ""));

  const logo = el("img", "team-logo small");
  logo.src = rank.logo || "icons/team-placeholder.png";
  logo.alt = rank.team_name;
  row.appendChild(logo);

  const body = el("div", "rank-body");
  body.appendChild(el("div", "team-name", rank.team_name));
  if (rank.record) body.appendChild(el("div", "rank-record", rank.record));
  row.appendChild(body);

  row.appendChild(el("div", "rank-trend", buildTrendText(rank)));

  return row;
}

function buildTrendText(rank) {
  if (rank.previous_rank == null || rank.rank == null) return "";
  const delta = rank.previous_rank - rank.rank;
  if (delta > 0) return `▲${delta}`;
  if (delta < 0) return `▼${Math.abs(delta)}`;
  return "—";
}

// ---------------------------------------------------------------------------
// Standings page
// ---------------------------------------------------------------------------

const standingsState = { sport: getSelectedLeague(), conference: "" };

function initStandingsPage() {
  for (const sport of LEAGUE_KEYS) {
    document.getElementById(`standings-${sport}-tab`).addEventListener("click", () => {
      standingsState.sport = sport;
      setSelectedLeague(sport);
      updateStandingsSportTabs();
      loadStandingsConferenceOptions();
    });
  }
  document.getElementById("standings-conference").addEventListener("change", (event) => {
    standingsState.conference = event.target.value;
    loadStandings();
  });

  updateStandingsSportTabs();
  loadStandingsConferenceOptions();
}

function updateStandingsSportTabs() {
  for (const sport of LEAGUE_KEYS) {
    document.getElementById(`standings-${sport}-tab`).classList.toggle("active", standingsState.sport === sport);
  }
}

async function loadStandingsConferenceOptions() {
  const select = document.getElementById("standings-conference");
  select.innerHTML = "";
  standingsState.conference = "";

  try {
    const res = await fetch(`/api/conferences/${standingsState.sport}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    const conferences = data.conferences || [];
    for (const conf of conferences) {
      const option = document.createElement("option");
      option.value = conf.id;
      option.textContent = conf.name;
      select.appendChild(option);
    }
    if (conferences.length > 0) {
      standingsState.conference = conferences[0].id;
    }
  } catch (err) {
    console.warn("Could not load conferences for standings", err);
  }

  loadStandings();
}

async function loadStandings() {
  const list = document.getElementById("standings-list");
  list.innerHTML = "";

  if (!standingsState.conference) {
    list.appendChild(el("p", "empty", "Pick a conference to see standings."));
    return;
  }
  list.appendChild(el("p", "loading", "Loading..."));

  try {
    const res = await fetch(
      `/api/standings/${standingsState.sport}?conference=${encodeURIComponent(standingsState.conference)}`
    );
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderStandings(list, data.teams);
  } catch (err) {
    list.innerHTML = "";
    list.appendChild(el("p", "error", "Could not load standings."));
    console.error(err);
  }
}

function renderStandings(list, teams) {
  list.innerHTML = "";
  if (!teams || teams.length === 0) {
    list.appendChild(el("p", "empty", "No standings available right now."));
    return;
  }

  const statNames = new Set();
  for (const team of teams) {
    Object.keys(team.stats || {}).forEach((name) => statNames.add(name));
  }

  const table = el("table", "standings-table");
  const headRow = document.createElement("tr");
  headRow.appendChild(document.createElement("th"));
  for (const statName of statNames) {
    headRow.appendChild(el("th", null, statName));
  }
  table.appendChild(headRow);

  for (const team of teams) {
    const row = document.createElement("tr");

    const teamCell = el("td", "standings-team-cell");
    const link = el("a", "standings-team-link");
    link.href = `team.html?sport=${standingsState.sport}&teamId=${team.team_id}`;
    const logo = el("img", "team-logo small");
    logo.src = team.logo || "icons/team-placeholder.png";
    logo.alt = team.team_name;
    link.appendChild(logo);
    link.appendChild(el("span", null, team.team_name));
    teamCell.appendChild(link);
    row.appendChild(teamCell);

    for (const statName of statNames) {
      row.appendChild(el("td", null, (team.stats || {})[statName] ?? ""));
    }
    table.appendChild(row);
  }

  list.appendChild(table);
}

// ---------------------------------------------------------------------------
// Search page
// ---------------------------------------------------------------------------

let searchTeams = [];

function initSearchPage() {
  document.getElementById("search-input").addEventListener("input", (event) => {
    renderSearchResults(event.target.value);
  });
  loadSearchTeams();
}

async function loadSearchTeams() {
  const status = document.getElementById("search-status");
  status.textContent = "Loading teams...";

  // Each league is fetched independently, one failing (NFL's data is
  // newer and less exercised than the two college feeds) shouldn't
  // take down search for the other two.
  const bySport = await Promise.all(
    LEAGUE_KEYS.map(async (sport) => {
      try {
        const res = await fetch(`/api/teams/${sport}`);
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const data = await res.json();
        return (data.teams || []).map((t) => ({ ...t, sport }));
      } catch (err) {
        console.warn(`Could not load ${sport} teams for search`, err);
        return [];
      }
    })
  );
  searchTeams = bySport.flat();
  status.textContent = searchTeams.length > 0 ? "Start typing to search." : "No teams available right now.";
}

function renderSearchResults(query) {
  const list = document.getElementById("search-results");
  list.innerHTML = "";

  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return;

  const matches = searchTeams
    .filter((t) => t.name.toLowerCase().includes(trimmed) || t.abbreviation.toLowerCase().includes(trimmed))
    .slice(0, 30);

  if (matches.length === 0) {
    list.appendChild(el("p", "empty", "No matching schools."));
    return;
  }
  for (const team of matches) {
    list.appendChild(buildSearchResultRow(team));
  }
}

function buildSearchResultRow(team) {
  const row = el("a", "search-result");
  row.href = `team.html?sport=${team.sport}&teamId=${team.id}`;

  const logo = el("img", "team-logo small");
  logo.src = team.logo || "icons/team-placeholder.png";
  logo.alt = team.name;
  row.appendChild(logo);

  const body = el("div", "search-result-body");
  body.appendChild(el("div", "team-name", team.name));
  body.appendChild(el("div", "search-result-sport", team.sport));
  row.appendChild(body);

  return row;
}

// ---------------------------------------------------------------------------
// Settings page (device recovery code)
// ---------------------------------------------------------------------------

function initSettingsPage() {
  loadDeviceCode();

  document.getElementById("recover-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("recover-input");
    const status = document.getElementById("recover-status");
    const code = input.value.trim();
    if (!code) return;

    status.textContent = "Linking...";
    try {
      const res = await fetch("/api/device/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: DEVICE_ID, code }),
      });
      if (!res.ok) {
        status.textContent = "That code wasn't found.";
        return;
      }
      const data = await res.json();
      setStoredCode(data.code);
      status.textContent = "Linked. Your favorites from that code are now here.";
      input.value = "";
      loadDeviceCode();
    } catch (err) {
      status.textContent = "Could not check that code, try again.";
      console.error(err);
    }
  });

  document.getElementById("rename-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("rename-input");
    const status = document.getElementById("rename-status");
    const newCode = input.value.trim();
    if (!newCode) return;

    status.textContent = "Renaming...";
    try {
      const res = await fetch("/api/device/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: DEVICE_ID, new_code: newCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = data.detail || "Could not rename that code.";
        return;
      }
      setStoredCode(data.code);
      status.textContent = "Renamed.";
      input.value = "";
      loadDeviceCode();
    } catch (err) {
      status.textContent = "Could not rename that code, try again.";
      console.error(err);
    }
  });

  initPushToggle();
}

async function loadDeviceCode() {
  const codeEl = document.getElementById("device-code");
  codeEl.textContent = "Loading...";
  try {
    const params = new URLSearchParams({ device_id: DEVICE_ID });
    const cachedCode = getStoredCode();
    if (cachedCode) params.set("code", cachedCode);
    const res = await fetch(`/api/device/code?${params}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    codeEl.textContent = data.code;
    if (data.code) setStoredCode(data.code);
  } catch (err) {
    codeEl.textContent = "Unavailable";
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Individual player page
//
// Bio fields (name, jersey, position, headshot, height, weight, class)
// come straight from the roster row's link, since the roster call
// already has all of it. Only season stats need a fresh fetch here.
// ---------------------------------------------------------------------------

function initPlayerPage() {
  const params = new URLSearchParams(window.location.search);
  const sport = params.get("sport");
  const teamId = params.get("teamId");
  const playerId = params.get("playerId");

  if (!sport || !playerId) {
    document.getElementById("player-stats-area").innerHTML = "";
    document.getElementById("player-stats-area").appendChild(el("p", "error", "Missing player reference."));
    return;
  }

  const backLink = document.getElementById("player-back-link");
  if (teamId) backLink.href = `team.html?sport=${sport}&teamId=${teamId}`;

  renderPlayerBio({
    name: params.get("name"),
    jersey: params.get("jersey"),
    position: params.get("position"),
    headshot: params.get("headshot"),
    height: params.get("height"),
    weight: params.get("weight"),
    playerClass: params.get("playerClass"),
  });

  loadPlayerStats(sport, playerId, params.get("position"));
}

function renderPlayerBio(player) {
  document.title = `${player.name || "Player"} - NCAA Scores`;
  document.getElementById("player-name").textContent = player.name || "Player";

  const photo = document.getElementById("player-photo");
  photo.src = player.headshot || "icons/team-placeholder.png";
  photo.alt = player.name || "";

  const metaParts = [
    player.position,
    player.jersey ? `#${player.jersey}` : null,
    player.playerClass,
    player.height,
    player.weight,
  ].filter(Boolean);
  document.getElementById("player-meta").textContent = metaParts.join(" · ");
}

async function loadPlayerStats(sport, playerId, position) {
  const content = document.getElementById("player-stats-area");
  content.innerHTML = "";
  content.appendChild(el("p", "loading", "Loading stats..."));

  try {
    const res = await fetch(`/api/player/${sport}/${playerId}/stats`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderPlayerKeyStats(document.getElementById("player-key-stats"), position, data.categories);
    renderStatCategories(content, data.categories, "No stats available for this player right now.");
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Could not load this player's stats."));
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Close-game push notifications
//
// Real Web Push, the browser standard, not anything native-app-only.
// The notification itself is a plain banner (requireInteraction stays
// false in the service worker's push handler) that clears on its own
// rather than blocking until dismissed; on iOS that also depends on
// this app's own notification style being set to "Banners" rather
// than "Alerts" under iOS Settings, a per-app choice this code can't
// override.
// ---------------------------------------------------------------------------

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function arrayBufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function postPushSubscription(subscription) {
  return fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_id: DEVICE_ID,
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64url(subscription.getKey("p256dh")),
      auth: arrayBufferToBase64url(subscription.getKey("auth")),
    }),
  });
}

// The backend's subscription storage can be lost independently of the
// browser's own copy, most notably on a redeploy: there's no
// persistent disk attached, so every fresh deploy starts with an
// empty SQLite file and no memory of who was subscribed. The browser
// still holds its own subscription fine, so from its side everything
// looks "on", but the server has nothing to send to and nothing ever
// arrives, silently. Calling this on every page load re-posts an
// already-existing browser subscription unconditionally, a no-op when
// the backend already has it (save_subscription upserts by device
// id), a silent repair when it doesn't.
async function getAndResyncPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    try {
      await postPushSubscription(subscription);
    } catch (err) {
      // Best-effort repair, not fatal, the next page load tries again.
      console.warn("Could not resync push subscription with the server", err);
    }
  }
  return subscription;
}

async function initPushToggle() {
  const btn = document.getElementById("push-toggle-btn");
  const status = document.getElementById("push-status");
  const typesContainer = document.getElementById("notification-types");

  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    btn.textContent = "Not supported";
    btn.disabled = true;
    status.textContent = "This browser doesn't support push notifications.";
    return;
  }

  let config;
  try {
    const res = await fetch("/api/push/vapid-public-key");
    config = await res.json();
  } catch (err) {
    btn.textContent = "Unavailable";
    btn.disabled = true;
    status.textContent = "Could not reach the server to check notification support.";
    return;
  }

  if (!config.configured) {
    btn.textContent = "Not set up yet";
    btn.disabled = true;
    status.textContent = "Push notifications aren't configured on this server yet.";
    return;
  }

  initNotificationTypeControls();

  const registration = await navigator.serviceWorker.ready;
  let subscription = await getAndResyncPushSubscription();
  updatePushButton(btn, status, typesContainer, subscription);
  if (subscription) loadNotificationTypes();

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      if (subscription) {
        await subscription.unsubscribe();
        await fetch(`/api/push/subscribe/${encodeURIComponent(DEVICE_ID)}`, { method: "DELETE" });
        subscription = null;
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          status.textContent = "Notifications permission was not granted.";
          btn.disabled = false;
          return;
        }

        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(config.key),
        });

        await postPushSubscription(subscription);
      }
    } catch (err) {
      status.textContent = "Something went wrong changing that setting, try again.";
      console.error(err);
    }
    btn.disabled = false;
    updatePushButton(btn, status, typesContainer, subscription);
    if (subscription) loadNotificationTypes();
  });
}

function updatePushButton(btn, status, typesContainer, subscription) {
  if (subscription) {
    btn.textContent = "Disable game alerts";
    status.textContent = "On for this device.";
    typesContainer.hidden = false;
  } else {
    btn.textContent = "Enable game alerts";
    status.textContent = "Off for this device.";
    typesContainer.hidden = true;
  }
}

// Notification types (close games / favorites / more to come) are
// each their own checkbox, keyed by a data-notify-type attribute so
// adding another type later is just another checkbox with that
// attribute set, no JS changes needed here. "All" is a pure UI
// convenience, checking or unchecking every real checkbox at once,
// it isn't a type of its own and nothing stores its state directly.
function getNotificationTypeCheckboxes() {
  return Array.from(document.querySelectorAll("#notification-types input[data-notify-type]"));
}

function checkedNotificationTypes() {
  return getNotificationTypeCheckboxes()
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.notifyType);
}

function syncAllNotificationTypeCheckbox() {
  const boxes = getNotificationTypeCheckboxes();
  const allBox = document.getElementById("notify-type-all");
  allBox.checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
}

async function loadNotificationTypes() {
  try {
    const res = await fetch(`/api/push/notification-types?device_id=${encodeURIComponent(DEVICE_ID)}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    const enabled = new Set(data.types || []);
    getNotificationTypeCheckboxes().forEach((cb) => {
      cb.checked = enabled.has(cb.dataset.notifyType);
    });
    syncAllNotificationTypeCheckbox();
  } catch (err) {
    console.warn("Could not load notification type preferences", err);
  }
}

async function saveNotificationTypes() {
  try {
    await fetch("/api/push/notification-types", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: DEVICE_ID, types: checkedNotificationTypes() }),
    });
  } catch (err) {
    console.warn("Could not save notification type preferences", err);
  }
}

function initNotificationTypeControls() {
  getNotificationTypeCheckboxes().forEach((cb) => {
    cb.addEventListener("change", () => {
      syncAllNotificationTypeCheckbox();
      saveNotificationTypes();
    });
  });

  document.getElementById("notify-type-all").addEventListener("change", (event) => {
    getNotificationTypeCheckboxes().forEach((cb) => {
      cb.checked = event.target.checked;
    });
    saveNotificationTypes();
  });
}
