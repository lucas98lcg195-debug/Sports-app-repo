"""Data classes describing the shapes we hand back to the frontend.

These are intentionally small. ESPN's raw payloads carry a lot more than
we need (articles, odds, betting lines, etc.), so espn_client.py trims
everything down to these shapes before it ever reaches a route.
"""

from dataclasses import asdict, dataclass, field
from typing import Optional


@dataclass
class Team:
    id: str
    name: str
    abbreviation: str
    logo: Optional[str]
    score: Optional[str]
    record: Optional[str]
    home_away: str
    winner: Optional[bool]


@dataclass
class Game:
    id: str
    sport: str
    date: str
    status_state: str  # "pre", "in", or "post"
    status_detail: str
    period: Optional[int]
    clock: Optional[str]
    venue: Optional[str]
    broadcast: Optional[str]
    teams: list = field(default_factory=list)


def game_to_dict(game: Game) -> dict:
    return asdict(game)
