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


def _get_first_working(url_templates: list[str], **format_kwargs) -> dict:
    """Try each URL template in order, returning the first one that
    responds successfully. Used for endpoints where ESPN's actual host
    and path aren't reliably known in advance, athlete and team
    statistics turned out to live under a different host and namespace
    than the rest of this app's endpoints, discovered by a 404 in
    production rather than anything documented. Raises the last error
    only if every candidate fails."""
    last_error = None
    for template in url_templates:
        url = template.format(**format_kwargs)
        try:
            return _get(url)
        except EspnApiError as exc:
            last_error = exc
            continue
    raise last_error


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
        status_state = status_type.get("state", "pre")

        teams = [_parse_summary_team(c) for c in competition.get("competitors", [])]

        return {
            "id": str(game_id),
            "sport": sport,
            "status_state": status_state,
            "status_detail": status_type.get("shortDetail") or status_type.get("detail", ""),
            "broadcast": _parse_broadcast(competition),
            "venue": _parse_venue(raw, competition),
            # Only meaningful while a game is actually in progress.
            "situation": _parse_situation(competition, sport) if status_state == "in" else None,
            "teams": teams,
            "team_stats": _parse_team_stats(raw),
            "scoring_plays": _parse_scoring_plays(raw),
            "player_stats": _parse_player_box_scores(raw),
            "win_probability": _parse_win_probability(raw),
        }
    except (KeyError, IndexError, TypeError) as exc:
        raise EspnApiError(f"Failed to parse box score for game {game_id}: {exc}") from exc


def _parse_venue(raw: dict, competition: dict) -> dict:
    game_info = raw.get("gameInfo") or {}
    venue = game_info.get("venue") or competition.get("venue") or {}
    address = venue.get("address") or {}
    return {
        "name": venue.get("fullName"),
        "city": address.get("city"),
        "state": address.get("state"),
        "attendance": game_info.get("attendance"),
    }


_ORDINALS = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th"}


def _parse_situation(competition: dict, sport: str) -> dict | None:
    """The live "down and distance" (football) or "outs and runners"
    (baseball) strip. Field names here are a best-effort guess at
    ESPN's live in-game situation shape, unconfirmed against a real
    live game the way the stats endpoints eventually were, so this
    returns None on anything unexpected rather than guessing wrong."""
    situation = competition.get("situation")
    if not situation:
        return None

    try:
        if sport == "football":
            text = situation.get("downDistanceText") or situation.get("shortDownDistanceText")
            if not text:
                down = situation.get("down")
                distance = situation.get("distance")
                if down and distance is not None:
                    text = f"{_ORDINALS.get(down, f'{down}th')} & {distance}"
            if not text:
                return None
            possession = situation.get("possession")
            return {
                "text": text,
                "possession_team_id": str(possession) if possession else None,
                "is_red_zone": situation.get("isRedZone"),
            }

        # Baseball
        parts = []
        balls, strikes = situation.get("balls"), situation.get("strikes")
        if balls is not None and strikes is not None:
            parts.append(f"{balls}-{strikes}")
        outs = situation.get("outs")
        if outs is not None:
            parts.append(f"{outs} out" + ("" if outs == 1 else "s"))
        bases = [
            name
            for name, key in (("1st", "onFirst"), ("2nd", "onSecond"), ("3rd", "onThird"))
            if situation.get(key)
        ]
        if bases:
            parts.append("on " + "/".join(bases))
        if not parts:
            return None
        return {"text": ", ".join(parts), "possession_team_id": None, "is_red_zone": None}
    except (KeyError, TypeError) as exc:
        logger.warning("Skipping malformed situation data: %s", exc)
        return None


def _parse_player_box_scores(raw: dict) -> list[dict]:
    """Per-game player stat lines, as opposed to the season totals
    parse_player_stats returns. Unconfirmed against a real payload, so
    this returns an empty list on any shape it doesn't recognize
    rather than guessing at one."""
    result = []
    for team_entry in (raw.get("boxscore") or {}).get("players") or []:
        try:
            team_info = team_entry.get("team", {})
            groups = []
            for stat_group in team_entry.get("statistics") or []:
                labels = stat_group.get("labels") or stat_group.get("names") or []
                athletes = []
                for athlete_entry in stat_group.get("athletes") or []:
                    athlete_info = athlete_entry.get("athlete", {})
                    values = athlete_entry.get("stats") or []
                    stats = [
                        {"label": label, "value": value}
                        for label, value in zip(labels, values)
                        if value not in (None, "")
                    ]
                    if stats:
                        athletes.append(
                            {
                                "id": str(athlete_info.get("id", "")),
                                "name": athlete_info.get("displayName") or athlete_info.get("shortName", "Unknown"),
                                "stats": stats,
                            }
                        )
                if athletes:
                    groups.append(
                        {
                            "category": stat_group.get("displayName") or stat_group.get("name", "Stats"),
                            "athletes": athletes,
                        }
                    )
            if groups:
                result.append(
                    {
                        "team_id": str(team_info.get("id", "")),
                        "team_name": team_info.get("displayName", "Unknown"),
                        "groups": groups,
                    }
                )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed player box score entry: %s", exc)

    return result


def _parse_win_probability(raw: dict) -> list[float]:
    """The home team's win probability at each recorded point in the
    game, 0-100. Unconfirmed against a real payload."""
    points = []
    for entry in raw.get("winprobability") or []:
        pct = entry.get("homeWinPercentage")
        if pct is None:
            continue
        try:
            points.append(round(float(pct) * 100, 1))
        except (TypeError, ValueError):
            continue
    return points


def _parse_summary_team(competitor: dict) -> dict:
    team_info = competitor.get("team", {})
    logo = team_info.get("logo")
    if not logo:
        logos = team_info.get("logos") or []
        logo = logos[0].get("href") if logos else None

    linescores = [ls.get("displayValue") for ls in competitor.get("linescores", [])]

    records = competitor.get("records") or []
    record = records[0].get("summary") if records else None

    rank = (competitor.get("curatedRank") or {}).get("current")
    if rank is not None and (not isinstance(rank, int) or rank > 25):
        # ESPN uses a sentinel (99 in every case seen so far) for "not
        # ranked", not just an absent field, and a non-int here would
        # only mean a shape we don't recognize either way.
        rank = None

    return {
        "id": str(team_info.get("id", "")),
        "name": team_info.get("displayName", "Unknown"),
        "abbreviation": team_info.get("abbreviation", ""),
        "logo": logo,
        "score": competitor.get("score"),
        "home_away": competitor.get("homeAway", ""),
        "winner": competitor.get("winner"),
        "record": record,
        "rank": rank,
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


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------


def fetch_roster_raw(sport: str, team_id: str) -> dict:
    url = f"{BASE_URL}/{_sport_path(sport)}/teams/{team_id}/roster"
    return _get(url)


def parse_roster(raw: dict) -> list[dict]:
    athletes = raw.get("athletes") or []

    # Football rosters are grouped by unit (offense/defense/special
    # teams), each a {"position": ..., "items": [...]}. Other sports
    # sometimes return a flat list of athletes directly. Flatten either
    # shape down to one list of players.
    if athletes and isinstance(athletes[0], dict) and "items" in athletes[0]:
        flattened = []
        for group in athletes:
            flattened.extend(group.get("items") or [])
        athletes = flattened

    players = []
    for athlete in athletes:
        try:
            position = (athlete.get("position") or {}).get("abbreviation", "")
            headshot = (athlete.get("headshot") or {}).get("href")
            experience = (athlete.get("experience") or {}).get("displayValue")

            players.append(
                {
                    "id": str(athlete.get("id", "")),
                    "name": athlete.get("fullName") or athlete.get("displayName", "Unknown"),
                    "jersey": athlete.get("jersey"),
                    "position": position,
                    "headshot": headshot,
                    "height": athlete.get("displayHeight"),
                    "weight": athlete.get("displayWeight"),
                    "class": experience,
                }
            )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed roster entry: %s", exc)

    return players


# ---------------------------------------------------------------------------
# Team season stats
# ---------------------------------------------------------------------------


# Team statistics turned out not to live under the same
# apis/site/v2 host and namespace as the scoreboard/summary/roster
# endpoints this app otherwise uses. site.web.api.espn.com's
# apis/common/v3 namespace is what ESPN's own web player pages use for
# this data, tried first; the original guess is kept as a fallback in
# case it works for some sport or team.
TEAM_STATS_URL_CANDIDATES = [
    "https://site.web.api.espn.com/apis/common/v3/sports/{sport_path}/teams/{team_id}/statistics",
    "https://site.api.espn.com/apis/site/v2/sports/{sport_path}/teams/{team_id}/statistics",
]


def fetch_team_stats_raw(sport: str, team_id: str) -> dict:
    return _get_first_working(TEAM_STATS_URL_CANDIDATES, sport_path=_sport_path(sport), team_id=team_id)


def parse_team_stats(raw: dict) -> list[dict]:
    return _parse_espn_splits(raw, "team stats") or _extract_stat_categories(raw, "team stats")


def _parse_espn_splits(raw: dict, log_label: str) -> list[dict]:
    """Parse the shape confirmed against a real ESPN response for the
    apis/common/v3 .../athletes/{id}/splits endpoint (and presumed to
    match the equivalent team endpoint, since it's the same API
    family). This shape is unlike anything else this app parses: stat
    names and values are flat, parallel arrays shared across every
    category, sliced by each category's declared `count` rather than
    each category nesting its own stats. The actual numbers live under
    splitCategories, in the group named "split", in whichever entry is
    named "Season" (the full-season aggregate, as opposed to Home/Away
    or other situational splits)."""
    categories_meta = raw.get("categories") or []
    display_names = raw.get("displayNames") or raw.get("labels") or []
    split_categories = raw.get("splitCategories") or []

    value_group = next((sc for sc in split_categories if sc.get("name") == "split"), None)
    if value_group is None:
        return []

    splits = value_group.get("splits") or []
    season_split = next((s for s in splits if s.get("displayName") == "Season"), None)
    if season_split is None and splits:
        season_split = splits[0]
    if season_split is None:
        return []

    values = season_split.get("stats") or []

    parsed = []
    offset = 0
    for category in categories_meta:
        count = category.get("count", 0) if isinstance(category, dict) else 0
        try:
            names = display_names[offset : offset + count]
            cat_values = values[offset : offset + count]
            stats = [
                {"label": name, "value": value} for name, value in zip(names, cat_values) if value not in (None, "")
            ]
            if stats:
                parsed.append({"category": category.get("displayName") or category.get("name", "Stats"), "stats": stats})
        except (KeyError, TypeError, AttributeError) as exc:
            logger.warning("Skipping malformed %s split category: %s", log_label, exc)
        offset += count

    return parsed


def _extract_stat_categories(raw: dict, log_label: str) -> list[dict]:
    # Fallback for a differently-shaped statistics response, kept in
    # case some sport or context returns this instead of the splits
    # shape _parse_espn_splits handles. Returns an empty list rather
    # than raising if neither shape matches.
    categories = (
        ((raw.get("results") or {}).get("stats") or {}).get("categories")
        or (raw.get("splits") or {}).get("categories")
        or raw.get("categories")
        or []
    )

    parsed = []
    for category in categories:
        try:
            stats = [
                {
                    "label": stat.get("displayName") or stat.get("shortDisplayName") or stat.get("name"),
                    "value": stat.get("displayValue"),
                }
                for stat in category.get("stats", [])
                if stat.get("displayValue") is not None
            ]
            if stats:
                parsed.append(
                    {
                        "category": category.get("displayName") or category.get("name", "Stats"),
                        "stats": stats,
                    }
                )
        except (KeyError, TypeError) as exc:
            logger.warning("Skipping malformed %s category: %s", log_label, exc)

    return parsed


# ---------------------------------------------------------------------------
# Individual player stats
# ---------------------------------------------------------------------------


# Confirmed in production: apis/site/v2/.../athletes/{id}/stats 404s.
# Athlete splits/stats live under site.web.api.espn.com's
# apis/common/v3 namespace instead, the same one ESPN's own web player
# pages use. Tries a couple of path names there since which one is
# right isn't confirmed either, then falls back to the plain athlete
# bio endpoint, which at least returns something rather than nothing
# if both stats paths are wrong.
PLAYER_STATS_URL_CANDIDATES = [
    "https://site.web.api.espn.com/apis/common/v3/sports/{sport_path}/athletes/{player_id}/splits",
    "https://site.web.api.espn.com/apis/common/v3/sports/{sport_path}/athletes/{player_id}/stats",
    "https://site.api.espn.com/apis/site/v2/sports/{sport_path}/athletes/{player_id}",
]


def fetch_player_stats_raw(sport: str, player_id: str) -> dict:
    return _get_first_working(PLAYER_STATS_URL_CANDIDATES, sport_path=_sport_path(sport), player_id=player_id)


def parse_player_stats(raw: dict) -> list[dict]:
    return _parse_espn_splits(raw, "player stats") or _extract_stat_categories(raw, "player stats")
