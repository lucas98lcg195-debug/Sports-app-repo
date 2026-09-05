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

document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker();

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
  conference: { football: "", baseball: "" },
  gamesBySport: { football: [], baseball: [] },
};

async function initScoreboardPage() {
  document.getElementById("prev-day").addEventListener("click", () => shiftDate(-1));
  document.getElementById("next-day").addEventListener("click", () => shiftDate(1));
  document.getElementById("today-btn").addEventListener("click", () => setDate(new Date()));

  for (const sport of SPORTS) {
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

async function loadConferenceOptions() {
  for (const sport of SPORTS) {
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

async function loadScoreboards() {
  document.getElementById("date-label").textContent = formatDateLabel(scoreboardState.date);
  await Promise.all(SPORTS.map((sport) => loadSportScoreboard(sport)));
}

async function loadSportScoreboard(sport) {
  const container = document.getElementById(`${sport}-games`);
  const dateParam = formatDateParam(scoreboardState.date);
  const conference = scoreboardState.conference[sport];

  let url = `/api/scoreboard/${sport}?date=${dateParam}`;
  if (conference) url += `&conference=${encodeURIComponent(conference)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    scoreboardState.gamesBySport[sport] = data.games || [];
    renderGames(container, data.games, sport);
    renderMyTeams();
  } catch (err) {
    container.innerHTML = "";
    container.appendChild(el("p", "error", `Could not load ${sport} scores.`));
    console.error(err);
  }
}

function renderGames(container, games, sport) {
  container.innerHTML = "";
  if (!games || games.length === 0) {
    container.appendChild(el("p", "empty", "No games scheduled."));
    return;
  }
  for (const game of games) {
    container.appendChild(buildGameRow(game, sport));
  }
}

function renderMyTeams() {
  const section = document.getElementById("my-teams-section");
  const container = document.getElementById("my-teams-games");
  if (!section || !container) return;

  const matches = [];
  for (const sport of SPORTS) {
    for (const game of scoreboardState.gamesBySport[sport] || []) {
      if (game.teams.some((t) => isFavorite(sport, t.id))) {
        matches.push({ game, sport });
      }
    }
  }

  if (matches.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  container.innerHTML = "";
  for (const { game, sport } of matches) {
    container.appendChild(buildGameRow(game, sport));
  }
}

function buildGameRow(game, sport) {
  const row = el("div", "game-row");
  const away = game.teams.find((t) => t.home_away === "away") || game.teams[0];
  const home = game.teams.find((t) => t.home_away === "home") || game.teams[1];

  row.appendChild(buildTeamBlock(away, sport, `game.html?sport=${sport}&gameId=${game.id}`));
  row.appendChild(buildStatusBlock(game));
  row.appendChild(buildTeamBlock(home, sport, `game.html?sport=${sport}&gameId=${game.id}`));

  return row;
}

function buildTeamBlock(team, sport, logoHref) {
  const block = el("div", "team-block");

  const link = el("a", "team-logo-link");
  link.href = logoHref;

  const logo = el("img", "team-logo");
  logo.src = (team && team.logo) || "icons/team-placeholder.png";
  logo.alt = team ? team.name : "TBD";
  logo.loading = "lazy";
  link.appendChild(logo);
  block.appendChild(link);

  block.appendChild(el("div", "team-name", team ? team.abbreviation || team.name : "TBD"));

  if (team) {
    block.appendChild(buildFavoriteStar(sport, team, renderMyTeams));
  }

  const score = team && team.score !== null && team.score !== undefined ? team.score : "";
  block.appendChild(el("div", "team-score", score));

  return block;
}

function buildStatusBlock(game) {
  const block = el("div", "status-block");
  if (game.status_state === "in") block.classList.add("live");
  block.appendChild(el("div", "status-detail", game.status_detail || ""));
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
  loadGame(sport, gameId);
}

async function loadGame(sport, gameId) {
  const content = document.getElementById("game-content");
  try {
    const res = await fetch(`/api/game/${sport}/${gameId}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderGame(content, data, sport);
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Could not load this game."));
    console.error(err);
  }
}

function renderGame(content, data, sport) {
  content.innerHTML = "";

  const header = el("div", "game-header");
  for (const team of data.teams) {
    header.appendChild(buildGameTeamBlock(team, sport));
  }
  content.appendChild(header);

  content.appendChild(el("p", "status-detail", data.status_detail || ""));
  if (data.broadcast) {
    content.appendChild(el("p", "broadcast", data.broadcast));
  }
  content.appendChild(buildWatchLink(sport, data.id));

  if (data.teams.some((t) => t.linescores && t.linescores.length > 0)) {
    content.appendChild(buildLineScoreTable(data.teams));
  }

  if (data.team_stats && data.team_stats.length > 0) {
    content.appendChild(buildTeamStatsTable(data.team_stats));
  }

  if (data.scoring_plays && data.scoring_plays.length > 0) {
    content.appendChild(buildScoringPlaysList(data.scoring_plays));
  }
}

function buildGameTeamBlock(team, sport) {
  const block = el("div", "team-block");

  const link = el("a", "team-logo-link");
  link.href = `team.html?sport=${sport}&teamId=${team.id}`;
  const logo = el("img", "team-logo large");
  logo.src = team.logo || "icons/team-placeholder.png";
  logo.alt = team.name;
  link.appendChild(logo);
  block.appendChild(link);

  block.appendChild(el("div", "team-name", team.name));
  block.appendChild(buildFavoriteStar(sport, team));
  block.appendChild(el("div", "team-score large", team.score ?? ""));

  return block;
}

function buildLineScoreTable(teams) {
  const table = el("table", "line-score");
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
    row.appendChild(el("td", null, team.score ?? ""));
    table.appendChild(row);
  }

  return table;
}

function buildTeamStatsTable(teamStats) {
  const wrapper = el("div", "team-stats");
  wrapper.appendChild(el("h2", null, "Team Stats"));

  const statNames = new Set();
  for (const ts of teamStats) {
    Object.keys(ts.stats || {}).forEach((name) => statNames.add(name));
  }

  const table = document.createElement("table");
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
  const wrapper = el("div", "scoring-plays");
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
    football: { teamId: null, resolved: false, name: null, schedule: null, stats: null, roster: null },
    baseball: { teamId: null, resolved: false, name: null, schedule: null, stats: null, roster: null },
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
    await ensureStatsLoaded(sport);
    renderStatsSection(content, entry);
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

function renderStatsSection(content, entry) {
  renderStatCategories(content, entry.stats || [], "No team stats available right now.");
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

  const statusLink = el(
    "a",
    "schedule-status",
    game.result ? `${game.result} · ${game.status_detail}` : game.status_detail || ""
  );
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

const rankingsState = { sport: "football" };

function initRankingsPage() {
  for (const sport of SPORTS) {
    document.getElementById(`rankings-${sport}-tab`).addEventListener("click", () => {
      rankingsState.sport = sport;
      updateRankingsSportTabs();
      loadRankings();
    });
  }
  updateRankingsSportTabs();
  loadRankings();
}

function updateRankingsSportTabs() {
  for (const sport of SPORTS) {
    document.getElementById(`rankings-${sport}-tab`).classList.toggle("active", rankingsState.sport === sport);
  }
}

async function loadRankings() {
  const list = document.getElementById("rankings-list");
  list.innerHTML = "";
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

const standingsState = { sport: "football", conference: "" };

function initStandingsPage() {
  for (const sport of SPORTS) {
    document.getElementById(`standings-${sport}-tab`).addEventListener("click", () => {
      standingsState.sport = sport;
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
  for (const sport of SPORTS) {
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

  try {
    const bySport = await Promise.all(
      SPORTS.map(async (sport) => {
        const res = await fetch(`/api/teams/${sport}`);
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const data = await res.json();
        return (data.teams || []).map((t) => ({ ...t, sport }));
      })
    );
    searchTeams = bySport.flat();
    status.textContent = searchTeams.length > 0 ? "Start typing to search." : "No teams available right now.";
  } catch (err) {
    status.textContent = "Could not load the team list.";
    console.error(err);
  }
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

    status.textContent = "Checking...";
    try {
      const res = await fetch("/api/device/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        status.textContent = "That code wasn't found.";
        return;
      }
      const data = await res.json();
      setDeviceId(data.device_id);
      status.textContent = "Linked. Your favorites from that device are now here.";
      input.value = "";
      loadDeviceCode();
    } catch (err) {
      status.textContent = "Could not check that code, try again.";
      console.error(err);
    }
  });
}

async function loadDeviceCode() {
  const codeEl = document.getElementById("device-code");
  codeEl.textContent = "Loading...";
  try {
    const res = await fetch(`/api/device/code?device_id=${encodeURIComponent(DEVICE_ID)}`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    codeEl.textContent = data.code;
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

  loadPlayerStats(sport, playerId);
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

async function loadPlayerStats(sport, playerId) {
  const content = document.getElementById("player-stats-area");
  content.innerHTML = "";
  content.appendChild(el("p", "loading", "Loading stats..."));

  try {
    const res = await fetch(`/api/player/${sport}/${playerId}/stats`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderStatCategories(content, data.categories, "No stats available for this player right now.");
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Could not load this player's stats."));
    console.error(err);
  }
}
