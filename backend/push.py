"""Web Push notifications for game alerts.

There's no native app and no direct line to Apple's push service here,
this uses the actual Web Push standard: the browser registers a
subscription through the installed service worker, and this module
signs a message with a VAPID key pair and hands it to pywebpush, which
encrypts it and delivers it to whichever push service (Apple's,
Google's, etc.) that subscription belongs to.

Four kinds of alert, each checked independently against every game in
a refresh batch:

  "close": 7 points or less with 5 minutes or less left in the 4th
    quarter, football only, any team, nationally.
  "start": a game involving Auburn or Mississippi State just went live.
  "final": a game involving Auburn or Mississippi State just ended.
  "score": the score changed in a live game involving Auburn or
    Mississippi State.

Every subscribed device gets every alert that fires, there's no
per-device favorites scoping. Close/start/final each fire at most once
per game, tracked in notified_alerts so the same game/kind pair doesn't
re-fire on every 30-second refresh. A score-change alert can fire more
than once per game, once per distinct score, since the whole point is
to hear about each change, that's handled by folding the actual score
into the alert's kind string (see check_and_notify) rather than a
separate table, so notified_alerts still only ever sends a given exact
score once per game.
"""

import json
import logging
import os
import time

from pywebpush import WebPushException, webpush

import cache

logger = logging.getLogger(__name__)

# Set on the deployment, not committed to the repo, since the private
# key lets whoever holds it sign push messages as this server.
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_CLAIM_EMAIL = os.environ.get("VAPID_CLAIM_EMAIL", "mailto:admin@example.com")

CLOSE_GAME_MARGIN = 7
CLOSE_GAME_SECONDS_REMAINING = 5 * 60
CLOSE_GAME_PERIOD = 4

# Matched against a team's full name, lowercased, substring match, the
# same approach news_client.py uses for its relevance filter. Neither
# name collides with any other Division I school, so a substring match
# is precise enough without needing team ids, which can also differ
# between a school's football and baseball programs.
TRACKED_TEAM_NAMES = ["auburn", "mississippi state"]


def is_configured() -> bool:
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


def init_tables() -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                device_id TEXT PRIMARY KEY,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS notified_alerts (
                device_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                notified_at REAL NOT NULL,
                PRIMARY KEY (device_id, game_id, kind)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tracked_game_scores (
                game_id TEXT PRIMARY KEY,
                away_score TEXT NOT NULL,
                home_score TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        conn.commit()


def save_subscription(device_id: str, endpoint: str, p256dh: str, auth: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                endpoint = excluded.endpoint,
                p256dh = excluded.p256dh,
                auth = excluded.auth,
                created_at = excluded.created_at
            """,
            (device_id, endpoint, p256dh, auth, time.time()),
        )
        conn.commit()


def remove_subscription(device_id: str) -> None:
    with cache.connect() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE device_id = ?", (device_id,))
        conn.commit()


def all_subscriptions() -> list[dict]:
    with cache.connect() as conn:
        rows = conn.execute("SELECT device_id, endpoint, p256dh, auth FROM push_subscriptions").fetchall()
    return [{"device_id": r[0], "endpoint": r[1], "p256dh": r[2], "auth": r[3]} for r in rows]


def _already_notified(device_id: str, game_id: str, kind: str) -> bool:
    with cache.connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM notified_alerts WHERE device_id = ? AND game_id = ? AND kind = ?",
            (device_id, game_id, kind),
        ).fetchone()
    return row is not None


def _mark_notified(device_id: str, game_id: str, kind: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO notified_alerts (device_id, game_id, kind, notified_at) VALUES (?, ?, ?, ?)",
            (device_id, game_id, kind, time.time()),
        )
        conn.commit()


def _parse_clock_seconds(clock) -> int | None:
    if not clock:
        return None
    parts = clock.split(":")
    if len(parts) != 2:
        return None
    try:
        minutes, seconds = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    return minutes * 60 + seconds


def is_close_game(game: dict) -> bool:
    """7 points or less with 5 minutes or less left in the 4th
    quarter. Football only, "4th quarter" has no baseball equivalent
    this rule is meant to describe."""
    if game.get("sport") != "football":
        return False
    if game.get("status_state") != "in":
        return False
    if game.get("period") != CLOSE_GAME_PERIOD:
        return False

    seconds_left = _parse_clock_seconds(game.get("clock"))
    if seconds_left is None or seconds_left > CLOSE_GAME_SECONDS_REMAINING:
        return False

    teams = game.get("teams") or []
    if len(teams) != 2:
        return False
    try:
        scores = [int(t["score"]) for t in teams]
    except (TypeError, ValueError, KeyError):
        return False

    return abs(scores[0] - scores[1]) <= CLOSE_GAME_MARGIN


def _is_tracked_team(team: dict) -> bool:
    name = (team.get("name") or "").lower()
    return any(tracked in name for tracked in TRACKED_TEAM_NAMES)


def is_tracked_team_game(game: dict) -> bool:
    return any(_is_tracked_team(t) for t in game.get("teams") or [])


def is_game_start_alert(game: dict) -> bool:
    """Fires once a tracked team's game is live. Checked against
    whatever status a refresh happens to see, there's no memory of the
    previous status here, so if the server was asleep or just restarted
    while the game was already underway, this fires late, on the first
    refresh that catches it "in", rather than not at all."""
    return game.get("status_state") == "in" and is_tracked_team_game(game)


def is_final_score_alert(game: dict) -> bool:
    return game.get("status_state") == "post" and is_tracked_team_game(game)


def _current_scores(game: dict) -> tuple[str, str] | None:
    teams = {t["home_away"]: t for t in game.get("teams", [])}
    away, home = teams.get("away"), teams.get("home")
    if not away or not home:
        return None
    away_score, home_score = away.get("score"), home.get("score")
    if away_score in (None, "") or home_score in (None, ""):
        return None
    return (str(away_score), str(home_score))


def _get_last_score(game_id: str) -> tuple[str, str] | None:
    with cache.connect() as conn:
        row = conn.execute(
            "SELECT away_score, home_score FROM tracked_game_scores WHERE game_id = ?",
            (game_id,),
        ).fetchone()
    return (row[0], row[1]) if row else None


def _set_last_score(game_id: str, away_score: str, home_score: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            INSERT INTO tracked_game_scores (game_id, away_score, home_score, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET
                away_score = excluded.away_score,
                home_score = excluded.home_score,
                updated_at = excluded.updated_at
            """,
            (game_id, away_score, home_score, time.time()),
        )
        conn.commit()


def _clear_last_score(game_id: str) -> None:
    with cache.connect() as conn:
        conn.execute("DELETE FROM tracked_game_scores WHERE game_id = ?", (game_id,))
        conn.commit()


def _build_payload(game: dict, title: str) -> str:
    teams = {t["home_away"]: t for t in game.get("teams", [])}
    away, home = teams.get("away"), teams.get("home")
    away_label = away.get("abbreviation") or away.get("name") if away else "?"
    home_label = home.get("abbreviation") or home.get("name") if home else "?"
    away_score = away.get("score") if away else None
    home_score = home.get("score") if home else None

    if away_score not in (None, "") and home_score not in (None, ""):
        body = f"{away_label} {away_score} - {home_score} {home_label} · {game.get('status_detail', '')}"
    else:
        body = f"{away_label} at {home_label} · {game.get('status_detail', '')}"

    return json.dumps(
        {
            "title": title,
            "body": body,
            "url": f"game.html?sport={game.get('sport')}&gameId={game.get('id')}",
        }
    )


def _send(subscription: dict, payload: str) -> bool:
    """Sends one push message. Returns True on success. A 404/410
    response means the subscription is dead (browser data cleared,
    permission revoked, etc.) and is removed so it stops being tried."""
    try:
        webpush(
            subscription_info={
                "endpoint": subscription["endpoint"],
                "keys": {"p256dh": subscription["p256dh"], "auth": subscription["auth"]},
            },
            data=payload,
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_CLAIM_EMAIL},
        )
        return True
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            logger.info("Push subscription for device %s is gone, removing it", subscription["device_id"])
            remove_subscription(subscription["device_id"])
        else:
            logger.warning("Push failed for device %s: %s", subscription["device_id"], exc)
        return False


def check_and_notify(games_by_sport: dict[str, list[dict]]) -> None:
    """Called after each scoreboard refresh with the games that were
    just fetched. Every subscribed device gets every alert that fires
    out of this batch, close games nationally plus start/final/score
    alerts for Auburn and Mississippi State specifically, each one at
    most once per game (score alerts: once per distinct score)."""
    if not is_configured():
        return

    all_games = [game for games in games_by_sport.values() for game in games]
    if not all_games:
        return

    alerts = []  # (kind, game, title)
    for game in all_games:
        if is_close_game(game):
            alerts.append(("close", game, "Close game"))
        if is_game_start_alert(game):
            alerts.append(("start", game, "Game starting"))
        if is_final_score_alert(game):
            alerts.append(("final", game, "Final score"))
            _clear_last_score(game["id"])

        if game.get("status_state") == "in" and is_tracked_team_game(game):
            current = _current_scores(game)
            if current is not None:
                previous = _get_last_score(game["id"])
                if previous is not None and previous != current:
                    kind = f"score:{current[0]}-{current[1]}"
                    alerts.append((kind, game, "Score update"))
                _set_last_score(game["id"], current[0], current[1])

    if not alerts:
        return

    subscriptions = all_subscriptions()
    if not subscriptions:
        return

    for subscription in subscriptions:
        device_id = subscription["device_id"]

        for kind, game, title in alerts:
            game_id = game["id"]
            if _already_notified(device_id, game_id, kind):
                continue

            if _send(subscription, _build_payload(game, title)):
                _mark_notified(device_id, game_id, kind)
