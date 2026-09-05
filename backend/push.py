"""Web Push notifications for close-game alerts.

There's no native app and no direct line to Apple's push service here,
this uses the actual Web Push standard: the browser registers a
subscription through the installed service worker, and this module
signs a message with a VAPID key pair and hands it to pywebpush, which
encrypts it and delivers it to whichever push service (Apple's,
Google's, etc.) that subscription belongs to.

A "close game" is 7 points or less with 5 minutes or less left in the
4th quarter, football only, checked against a device's own favorited
teams so a personal alert doesn't turn into a firehose of every close
game in the country. Each device gets exactly one alert per game, the
first time it crosses into that territory, tracked in
notified_close_games so the same game doesn't re-fire every 30 seconds
while it stays close.
"""

import json
import logging
import os
import time

from pywebpush import WebPushException, webpush

import cache
import favorites

logger = logging.getLogger(__name__)

# Set on the deployment, not committed to the repo, since the private
# key lets whoever holds it sign push messages as this server.
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY")
VAPID_CLAIM_EMAIL = os.environ.get("VAPID_CLAIM_EMAIL", "mailto:admin@example.com")

CLOSE_GAME_MARGIN = 7
CLOSE_GAME_SECONDS_REMAINING = 5 * 60
CLOSE_GAME_PERIOD = 4


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
            CREATE TABLE IF NOT EXISTS notified_close_games (
                device_id TEXT NOT NULL,
                game_id TEXT NOT NULL,
                notified_at REAL NOT NULL,
                PRIMARY KEY (device_id, game_id)
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


def _already_notified(device_id: str, game_id: str) -> bool:
    with cache.connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM notified_close_games WHERE device_id = ? AND game_id = ?",
            (device_id, game_id),
        ).fetchone()
    return row is not None


def _mark_notified(device_id: str, game_id: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO notified_close_games (device_id, game_id, notified_at) VALUES (?, ?, ?)",
            (device_id, game_id, time.time()),
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


def _build_payload(game: dict) -> str:
    teams = {t["home_away"]: t for t in game.get("teams", [])}
    away, home = teams.get("away"), teams.get("home")
    away_label = away.get("abbreviation") or away.get("name") if away else "?"
    home_label = home.get("abbreviation") or home.get("name") if home else "?"
    away_score = away.get("score") if away else "?"
    home_score = home.get("score") if home else "?"

    return json.dumps(
        {
            "title": "Close game",
            "body": f"{away_label} {away_score} - {home_score} {home_label} · {game.get('status_detail', '')}",
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
    just fetched. For every device with a saved subscription, checks
    that device's own favorited teams against the close games in this
    batch, and sends one alert per game the first time it qualifies."""
    if not is_configured():
        return

    close_games = [game for games in games_by_sport.values() for game in games if is_close_game(game)]
    if not close_games:
        return

    subscriptions = all_subscriptions()
    if not subscriptions:
        return

    for subscription in subscriptions:
        device_id = subscription["device_id"]
        favorite_team_ids = {f["team_id"] for f in favorites.list_favorites(device_id)}
        if not favorite_team_ids:
            continue

        for game in close_games:
            game_id = game["id"]
            if _already_notified(device_id, game_id):
                continue
            if not any(t["id"] in favorite_team_ids for t in game["teams"]):
                continue

            if _send(subscription, _build_payload(game)):
                _mark_notified(device_id, game_id)
