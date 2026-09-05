"""Favorites and lightweight device identity, no accounts involved.

Favorites are keyed by an anonymous device id the frontend generates
and stores itself (in both localStorage and a cookie, for redundancy),
never a login. Each device can also be given a short, human-typeable
recovery code, an adjective and a noun, that maps back to its device
id, so favorites survive a browser storage wipe or a move to a new
phone without a password anywhere. The code is a friendly label for
the real id, not a replacement for it: the id is what actually keys
every row, the code is just how a person types it back in.
"""

import random
import time

import cache

ADJECTIVES = ["blue", "red", "green", "gold", "silver", "orange"]
NOUNS = ["dog", "cat", "fox", "wolf", "bear", "hawk"]


def init_tables() -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS devices (
                device_id TEXT PRIMARY KEY,
                code TEXT UNIQUE NOT NULL,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS favorites (
                device_id TEXT NOT NULL,
                sport TEXT NOT NULL,
                team_id TEXT NOT NULL,
                team_name TEXT NOT NULL,
                logo TEXT,
                added_at REAL NOT NULL,
                PRIMARY KEY (device_id, sport, team_id)
            )
            """
        )
        conn.commit()


def _generate_code(conn) -> str:
    # 36 plain adjective-noun combinations. Try a handful of random
    # picks first, since a collision is very unlikely for a personal
    # app. Only fall back to a numbered variant if every combination
    # is somehow already taken.
    for _ in range(50):
        code = f"{random.choice(ADJECTIVES)}-{random.choice(NOUNS)}"
        taken = conn.execute("SELECT 1 FROM devices WHERE code = ?", (code,)).fetchone()
        if not taken:
            return code

    suffix = 2
    while True:
        code = f"{random.choice(ADJECTIVES)}-{random.choice(NOUNS)}-{suffix}"
        taken = conn.execute("SELECT 1 FROM devices WHERE code = ?", (code,)).fetchone()
        if not taken:
            return code
        suffix += 1


def get_or_create_code(device_id: str) -> str:
    with cache.connect() as conn:
        row = conn.execute("SELECT code FROM devices WHERE device_id = ?", (device_id,)).fetchone()
        if row:
            return row[0]

        code = _generate_code(conn)
        conn.execute(
            "INSERT INTO devices (device_id, code, created_at) VALUES (?, ?, ?)",
            (device_id, code, time.time()),
        )
        conn.commit()
        return code


def resolve_code(code: str) -> str | None:
    """Return the device id a recovery code maps to, or None."""
    normalized = code.strip().lower()
    with cache.connect() as conn:
        row = conn.execute("SELECT device_id FROM devices WHERE code = ?", (normalized,)).fetchone()
    return row[0] if row else None


def list_favorites(device_id: str) -> list[dict]:
    with cache.connect() as conn:
        rows = conn.execute(
            "SELECT sport, team_id, team_name, logo FROM favorites WHERE device_id = ? ORDER BY added_at",
            (device_id,),
        ).fetchall()
    return [{"sport": r[0], "team_id": r[1], "team_name": r[2], "logo": r[3]} for r in rows]


def add_favorite(device_id: str, sport: str, team_id: str, team_name: str, logo: str | None) -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            INSERT INTO favorites (device_id, sport, team_id, team_name, logo, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id, sport, team_id)
            DO UPDATE SET team_name = excluded.team_name, logo = excluded.logo
            """,
            (device_id, sport, team_id, team_name, logo, time.time()),
        )
        conn.commit()


def remove_favorite(device_id: str, sport: str, team_id: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            "DELETE FROM favorites WHERE device_id = ? AND sport = ? AND team_id = ?",
            (device_id, sport, team_id),
        )
        conn.commit()
