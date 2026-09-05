"""Team statistical leaders, computed rather than fetched.

ESPN doesn't expose a "team leaders" endpoint this app has found, so
this figures out passing, rushing, and receiving leaders itself: take
the roster, narrow to the positions that plausibly lead each category
(so this isn't fetching every single player's stats), and check each
candidate's own season stats, the same endpoint and the same cache
entries the player page uses, so a player already looked at elsewhere
is free to check here. Football only, these categories are specific
to that sport.
"""

import cache
import espn_client

PASSING_LEADER_POSITIONS = {"QB"}
RUSHING_LEADER_POSITIONS = {"RB", "FB", "HB", "QB", "WR", "ATH"}
RECEIVING_LEADER_POSITIONS = {"WR", "TE", "RB", "FB", "ATH"}

PLAYER_STATS_TTL_SECONDS = 3600


def _player_stats_cached(sport: str, player_id: str) -> list[dict]:
    key = f"player_stats:{sport}:{player_id}"

    def fetch() -> list[dict]:
        raw = espn_client.fetch_player_stats_raw(sport, player_id)
        return espn_client.parse_player_stats(raw)

    return cache.get_or_fetch(key, PLAYER_STATS_TTL_SECONDS, fetch)


def _stat_value(categories: list[dict], label: str):
    for category in categories:
        for stat in category.get("stats", []):
            if stat.get("label") == label:
                return stat.get("value")
    return None


def _find_leader(roster: list[dict], stat_label: str, positions: set) -> dict | None:
    best = None
    best_value = None

    for player in roster:
        if player.get("position") not in positions:
            continue
        try:
            categories = _player_stats_cached("football", player["id"])
        except espn_client.EspnApiError:
            continue

        raw_value = _stat_value(categories, stat_label)
        if raw_value is None:
            continue
        try:
            numeric = float(raw_value)
        except (TypeError, ValueError):
            continue

        if best_value is None or numeric > best_value:
            best_value = numeric
            best = {**player, "value": raw_value}

    return best


def compute_team_leaders(roster: list[dict]) -> dict:
    return {
        "passing": _find_leader(roster, "Passing Yards", PASSING_LEADER_POSITIONS),
        "rushing": _find_leader(roster, "Rushing Yards", RUSHING_LEADER_POSITIONS),
        "receiving": _find_leader(roster, "Receiving Yards", RECEIVING_LEADER_POSITIONS),
    }
