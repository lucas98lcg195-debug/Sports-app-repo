"""Thin wrapper around ESPN's public (unofficial) scoreboard API.

ESPN does not publish a schema for these endpoints and has changed field
names before without notice. Every parsing function here assumes the
payload could be missing keys or shaped differently than expected, and
skips or fails gracefully rather than letting a KeyError take down a
request.
"""

import logging

import requests

from models import Game, Team

logger = logging.getLogger(__name__)

BASE_URL = "https://site.api.espn.com/apis/site/v2/sports"

SPORT_PATHS = {
    "football": "football/college-football",
    "baseball": "baseball/college-baseball",
}

REQUEST_TIMEOUT_SECONDS = 10


class EspnApiError(Exception):
    """Raised when ESPN can't be reached or returns something we can't parse."""


def _sport_path(sport: str) -> str:
    if sport not in SPORT_PATHS:
        raise ValueError(f"Unknown sport: {sport}")
    return SPORT_PATHS[sport]


def _get(url: str, params: dict | None = None) -> dict:
    try:
        response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as exc:
        raise EspnApiError(f"Failed to reach ESPN: {exc}") from exc
    except ValueError as exc:
        raise EspnApiError(f"ESPN returned invalid JSON: {exc}") from exc


# ---------------------------------------------------------------------------
# Scoreboard
# ---------------------------------------------------------------------------


def fetch_scoreboard_raw(sport: str, date: str | None = None, groups: str | None = None) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/scoreboard"
    params = {}
    if date:
        params["dates"] = date
    if groups:
        params["groups"] = groups
    return _get(url, params)


def parse_scoreboard(raw: dict, sport: str) -> list[Game]:
    games = []
    for event in raw.get("events", []):
        try:
            games.append(_parse_event(event, sport))
        except (KeyError, IndexError, TypeError) as exc:
            logger.warning("Skipping malformed scoreboard event %s: %s", event.get("id"), exc)
            continue
    return games


def _parse_event(event: dict, sport: str) -> Game:
    competitions = event.get("competitions") or [{}]
    competition = competitions[0]
    status = event.get("status", {})
    status_type = status.get("type", {})

    teams = [_parse_team(competitor) for competitor in competition.get("competitors", [])]
    venue = (competition.get("venue") or {}).get("fullName")

    return Game(
        id=str(event.get("id", "")),
        sport=sport,
        date=event.get("date", ""),
        status_state=status_type.get("state", "pre"),
        status_detail=status_type.get("shortDetail") or status_type.get("detail", ""),
        period=status.get("period"),
        clock=status.get("displayClock"),
        venue=venue,
        broadcast=_parse_broadcast(competition),
        teams=teams,
    )


def _parse_broadcast(competition: dict) -> str | None:
    names = []
    for broadcast in competition.get("broadcasts") or []:
        names.extend(broadcast.get("names") or [])
    if not names:
        for geo_broadcast in competition.get("geoBroadcasts") or []:
            name = (geo_broadcast.get("media") or {}).get("shortName")
            if name:
                names.append(name)
    if not names:
        return None
    # Dedupe while preserving order, ESPN sometimes repeats a network
    # once per market (national, regional, streaming, ...).
    return ", ".join(dict.fromkeys(names))


def _parse_team(competitor: dict) -> Team:
    team_info = competitor.get("team", {})
    records = competitor.get("records") or []
    record = records[0].get("summary") if records else None

    return Team(
        id=str(team_info.get("id", "")),
        name=team_info.get("displayName", "Unknown"),
        abbreviation=team_info.get("abbreviation", ""),
        logo=team_info.get("logo"),
        score=competitor.get("score"),
        record=record,
        home_away=competitor.get("homeAway", ""),
        winner=competitor.get("winner"),
    )


# ---------------------------------------------------------------------------
# Game summary / box score
# ---------------------------------------------------------------------------


def fetch_summary_raw(sport: str, game_id: str) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/summary"
    return _get(url, {"event": game_id})


def parse_summary(raw: dict, sport: str, game_id: str) -> dict:
    try:
        header = raw.get("header", {})
        competitions = header.get("competitions") or [{}]
        competition = competitions[0]
        status_type = competition.get("status", {}).get("type", {})

        teams = [_parse_summary_team(c) for c in competition.get("competitors", [])]

        return {
            "id": str(game_id),
            "sport": sport,
            "status_state": status_type.get("state", "pre"),
            "status_detail": status_type.get("shortDetail") or status_type.get("detail", ""),
            "broadcast": _parse_broadcast(competition),
            "teams": teams,
            "team_stats": _parse_team_stats(raw),
            "scoring_plays": _parse_scoring_plays(raw),
        }
    except (KeyError, IndexError, TypeError) as exc:
        raise EspnApiError(f"Failed to parse box score for game {game_id}: {exc}") from exc


def _parse_summary_team(competitor: dict) -> dict:
    team_info = competitor.get("team", {})
    logo = team_info.get("logo")
    if not logo:
        logos = team_info.get("logos") or []
        logo = logos[0].get("href") if logos else None

    linescores = [ls.get("displayValue") for ls in competitor.get("linescores", [])]

    return {
        "id": str(team_info.get("id", "")),
        "name": team_info.get("displayName", "Unknown"),
        "abbreviation": team_info.get("abbreviation", ""),
        "logo": logo,
        "score": competitor.get("score"),
        "home_away": competitor.get("homeAway", ""),
        "winner": competitor.get("winner"),
        "linescores": linescores,
    }


def _parse_team_stats(raw: dict) -> list[dict]:
    stats_by_team = []
    for team_entry in raw.get("boxscore", {}).get("teams", []):
        team_info = team_entry.get("team", {})
        stats = {
            stat.get("label", stat.get("name")): stat.get("displayValue")
            for stat in team_entry.get("statistics", [])
        }
        stats_by_team.append(
            {
                "team": team_info.get("displayName", "Unknown"),
                "abbreviation": team_info.get("abbreviation", ""),
                "stats": stats,
            }
        )
    return stats_by_team


def _parse_scoring_plays(raw: dict) -> list[dict]:
    plays = []
    for play in raw.get("scoringPlays", []):
        plays.append(
            {
                "text": play.get("text", ""),
                "period": (play.get("period") or {}).get("number"),
                "clock": (play.get("clock") or {}).get("displayValue"),
                "team": (play.get("team") or {}).get("abbreviation"),
                "away_score": play.get("awayScore"),
                "home_score": play.get("homeScore"),
            }
        )
    return plays


# ---------------------------------------------------------------------------
# Team schedule
# ---------------------------------------------------------------------------


def fetch_team_schedule_raw(sport: str, team_id: str) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/teams/{team_id}/schedule"
    return _get(url)


def parse_schedule(raw: dict, sport: str, team_id: str) -> dict:
    team_name = raw.get("team", {}).get("displayName", "")
    games = []
    for event in raw.get("events", []):
        try:
            games.append(_parse_schedule_event(event, team_id))
        except (KeyError, IndexError, TypeError) as exc:
            logger.warning("Skipping malformed schedule event %s: %s", event.get("id"), exc)
            continue

    return {
        "team_id": str(team_id),
        "team_name": team_name,
        "sport": sport,
        "games": games,
    }


def _parse_schedule_event(event: dict, team_id: str) -> dict:
    competitions = event.get("competitions") or [{}]
    competition = competitions[0]
    status_type = event.get("status", {}).get("type", {})

    opponent = None
    is_home = True
    result = None

    for competitor in competition.get("competitors", []):
        team_info = competitor.get("team", {})
        if str(team_info.get("id")) == str(team_id):
            is_home = competitor.get("homeAway") == "home"
            winner = competitor.get("winner")
            if winner is True:
                result = "W"
            elif winner is False:
                result = "L"
        else:
            opponent = {
                "id": str(team_info.get("id", "")),
                "name": team_info.get("displayName", "Unknown"),
                "logo": team_info.get("logo"),
            }

    return {
        "id": str(event.get("id", "")),
        "date": event.get("date", ""),
        "opponent": opponent,
        "is_home": is_home,
        "status_state": status_type.get("state", "pre"),
        "status_detail": status_type.get("shortDetail") or status_type.get("detail", ""),
        "result": result,
    }


# ---------------------------------------------------------------------------
# Rankings (AP poll)
# ---------------------------------------------------------------------------


def fetch_rankings_raw(sport: str) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/rankings"
    return _get(url)


def parse_rankings(raw: dict, sport: str) -> list[dict]:
    polls = raw.get("rankings") or []
    if not polls:
        return []

    ap_poll = None
    for poll in polls:
        name = (poll.get("name") or poll.get("shortName") or "").lower()
        if "ap" in name:
            ap_poll = poll
            break
    if ap_poll is None:
        ap_poll = polls[0]

    ranks = []
    for entry in ap_poll.get("ranks", []):
        try:
            team_info = entry.get("team", {})
            logos = team_info.get("logos") or []
            logo = team_info.get("logo") or (logos[0].get("href") if logos else None)
            record = entry.get("recordSummary") or (entry.get("record") or {}).get("summary")

            ranks.append(
                {
                    "rank": entry.get("current"),
                    "previous_rank": entry.get("previous"),
                    "team_id": str(team_info.get("id", "")),
                    "team_name": team_info.get("displayName") or team_info.get("name", "Unknown"),
                    "logo": logo,
                    "record": record,
                    "points": entry.get("points"),
                    "first_place_votes": entry.get("firstPlaceVotes"),
                }
            )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed rankings entry for %s: %s", sport, exc)

    return ranks


# ---------------------------------------------------------------------------
# Conference standings
# ---------------------------------------------------------------------------


def fetch_standings_raw(sport: str, conference: str) -> dict:
    url = f"https://site.api.espn.com/apis/v2/sports/{_sport_path(sport)}/standings"
    return _get(url, {"group": conference})


def parse_standings(raw: dict) -> list[dict]:
    entries = (raw.get("standings") or {}).get("entries") or []
    # Some responses nest standings a level deeper under "children" (one
    # per division within the conference) rather than a flat "entries"
    # list. Fall back to flattening those if the flat list is empty.
    if not entries:
        entries = []
        for child in raw.get("children") or []:
            entries.extend((child.get("standings") or {}).get("entries") or [])

    teams = []
    for entry in entries:
        try:
            team_info = entry.get("team", {})
            logos = team_info.get("logos") or []
            logo = team_info.get("logo") or (logos[0].get("href") if logos else None)

            stats = {}
            for stat in entry.get("stats", []):
                label = stat.get("shortDisplayName") or stat.get("name")
                if label:
                    stats[label] = stat.get("displayValue")

            teams.append(
                {
                    "team_id": str(team_info.get("id", "")),
                    "team_name": team_info.get("displayName", "Unknown"),
                    "logo": logo,
                    "stats": stats,
                }
            )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed standings entry: %s", exc)

    return teams


# ---------------------------------------------------------------------------
# Teams list (for search)
# ---------------------------------------------------------------------------


def fetch_teams_raw(sport: str) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/teams"
    return _get(url, {"limit": 1000})


def parse_teams(raw: dict) -> list[dict]:
    teams = []
    sports = raw.get("sports") or []
    leagues = sports[0].get("leagues") if sports else []
    league_teams = leagues[0].get("teams") if leagues else []

    for entry in league_teams or []:
        try:
            team_info = entry.get("team", {})
            logos = team_info.get("logos") or []
            logo = team_info.get("logo") or (logos[0].get("href") if logos else None)
            teams.append(
                {
                    "id": str(team_info.get("id", "")),
                    "name": team_info.get("displayName", "Unknown"),
                    "abbreviation": team_info.get("abbreviation", ""),
                    "logo": logo,
                }
            )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed team entry: %s", exc)

    return teams
