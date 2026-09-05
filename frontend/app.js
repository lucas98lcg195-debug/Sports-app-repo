// All fetch calls hit our own backend, never ESPN directly, so there is
// no CORS to deal with and ESPN's calls stay server-side.

const SPORTS = ["football", "baseball"];
const SCOREBOARD_POLL_MS = 30000;

document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker();

  const page = document.body.dataset.page;
  if (page === "scoreboard") initScoreboardPage();
  else if (page === "game") initGamePage();
  else if (page === "team") initTeamPage();
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
};

function initScoreboardPage() {
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
    renderGames(container, data.games, sport);
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

function buildGameRow(game, sport) {
  const row = el("div", "game-row");
  const away = game.teams.find((t) => t.home_away === "away") || game.teams[0];
  const home = game.teams.find((t) => t.home_away === "home") || game.teams[1];

  row.appendChild(buildTeamBlock(away, `game.html?sport=${sport}&gameId=${game.id}`));
  row.appendChild(buildStatusBlock(game));
  row.appendChild(buildTeamBlock(home, `game.html?sport=${sport}&gameId=${game.id}`));

  return row;
}

function buildTeamBlock(team, logoHref) {
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
  return block;
}

// ---------------------------------------------------------------------------
// Game (box score) page
// ---------------------------------------------------------------------------

function initGamePage() {
  const params = new URLSearchParams(window.location.search);
  const sport = params.get("sport");
  const gameId = params.get("gameId");
  const content = document.getElementById("game-content");

  if (!sport || !gameId) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Missing game reference."));
    return;
  }
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
// Team schedule page
// ---------------------------------------------------------------------------

function initTeamPage() {
  const params = new URLSearchParams(window.location.search);
  const sport = params.get("sport");
  const teamId = params.get("teamId");
  const content = document.getElementById("team-content");

  if (!sport || !teamId) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Missing team reference."));
    return;
  }
  loadTeamSchedule(sport, teamId);
}

async function loadTeamSchedule(sport, teamId) {
  const content = document.getElementById("team-content");
  try {
    const res = await fetch(`/api/team/${sport}/${teamId}/schedule`);
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
    const data = await res.json();
    renderTeamSchedule(content, data, sport);
  } catch (err) {
    content.innerHTML = "";
    content.appendChild(el("p", "error", "Could not load this team's schedule."));
    console.error(err);
  }
}

function renderTeamSchedule(content, data, sport) {
  content.innerHTML = "";
  content.appendChild(el("h1", null, data.team_name || "Team Schedule"));

  if (!data.games || data.games.length === 0) {
    content.appendChild(el("p", "empty", "No schedule available."));
    return;
  }

  const list = el("div", "schedule-list");
  for (const game of data.games) {
    list.appendChild(buildScheduleRow(game, sport));
  }
  content.appendChild(list);
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
