"""Favorites and device identity, keyed by a code, not a device.

Favorites, and every other per-person setting, are keyed by a short
code (an adjective and a noun, like "blue-dog", auto-generated but
freely renameable to anything memorable), not by the device id a
browser generates for itself. A device id is just a pointer to a code,
and a code can have more than one device id pointing at it, any
device that's ever been registered under it or explicitly linked to
it. That indirection is what makes this resilient to a browser losing
its own storage (Safari clearing site data, a fresh install, iOS
occasionally wiping localStorage on its own): as long as the code
itself survives somewhere the frontend can still read it from, a
brand new device id can be silently reattached to it, no manual
recovery needed. Only losing every local copy of the code itself
still requires typing it back in by hand, the same as before.

There's still no login and no password anywhere, a code is a shared,
typeable label, not a secret credential in the way a password is.
"""

import random
import re
import time

import cache

ADJECTIVES = ["blue", "red", "green", "gold", "silver", "orange"]
NOUNS = ["dog", "cat", "fox", "wolf", "bear", "hawk"]

CODE_MIN_LENGTH = 3
CODE_MAX_LENGTH = 20
_CODE_PATTERN = re.compile(r"^[a-z0-9_-]+$")


def init_tables() -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS codes (
                code TEXT PRIMARY KEY,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS code_devices (
                device_id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                first_seen_at REAL NOT NULL,
                last_seen_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS favorites (
                code TEXT NOT NULL,
                sport TEXT NOT NULL,
                team_id TEXT NOT NULL,
                team_name TEXT NOT NULL,
                logo TEXT,
                added_at REAL NOT NULL,
                PRIMARY KEY (code, sport, team_id)
            )
            """
        )
        conn.commit()


def _normalize(code: str) -> str:
    return code.strip().lower()


def _code_exists(conn, code: str) -> bool:
    return conn.execute("SELECT 1 FROM codes WHERE code = ?", (code,)).fetchone() is not None


def _generate_code(conn) -> str:
    # 36 plain adjective-noun combinations. Try a handful of random
    # picks first, since a collision is very unlikely for a personal
    # app. Only fall back to a numbered variant if every combination
    # is somehow already taken.
    for _ in range(50):
        code = f"{random.choice(ADJECTIVES)}-{random.choice(NOUNS)}"
        if not _code_exists(conn, code):
            return code

    suffix = 2
    while True:
        code = f"{random.choice(ADJECTIVES)}-{random.choice(NOUNS)}-{suffix}"
        if not _code_exists(conn, code):
            return code
        suffix += 1


def register_device(device_id: str, local_code: str | None) -> str:
    """Called once per app load. Returns the code this device belongs
    to, creating whatever's missing:

    - Already registered: returns its existing code (and touches
      last_seen_at, mostly for future debugging/cleanup use).
    - Not registered, but the caller has a real code cached locally
      (the self-heal case, this device id is new but the person isn't):
      attaches this device id to that code instead of starting fresh.
    - Neither: mints a brand new code and registers this device under
      it, a genuinely first-ever visit.
    """
    now = time.time()
    with cache.connect() as conn:
        row = conn.execute("SELECT code FROM code_devices WHERE device_id = ?", (device_id,)).fetchone()
        if row:
            conn.execute("UPDATE code_devices SET last_seen_at = ? WHERE device_id = ?", (now, device_id))
            conn.commit()
            return row[0]

        normalized = _normalize(local_code) if local_code else None
        if normalized and _code_exists(conn, normalized):
            conn.execute(
                "INSERT INTO code_devices (device_id, code, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
                (device_id, normalized, now, now),
            )
            conn.commit()
            return normalized

        new_code = _generate_code(conn)
        conn.execute("INSERT INTO codes (code, created_at) VALUES (?, ?)", (new_code, now))
        conn.execute(
            "INSERT INTO code_devices (device_id, code, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
            (device_id, new_code, now, now),
        )
        conn.commit()
        return new_code


def resolve_code_for_device(device_id: str) -> str | None:
    with cache.connect() as conn:
        row = conn.execute("SELECT code FROM code_devices WHERE device_id = ?", (device_id,)).fetchone()
    return row[0] if row else None


def code_for_device(device_id: str) -> str:
    """Like register_device, but for routes that just need a code to
    operate on and shouldn't be the ones deciding whether to self-heal
    (that's register_device's job, called once up front by the
    frontend). Falls back to registering fresh only if a request
    somehow arrives before that initial call ever happened."""
    existing = resolve_code_for_device(device_id)
    return existing if existing is not None else register_device(device_id, None)


def link_device_to_code(device_id: str, code: str) -> bool:
    """"Link a device": attaches device_id to an existing code,
    switching away from whatever code it was previously registered
    under, if any. That old code and its favorites aren't touched or
    deleted, this device just stops pointing at them. Returns False if
    the code doesn't exist."""
    normalized = _normalize(code)
    now = time.time()
    with cache.connect() as conn:
        if not _code_exists(conn, normalized):
            return False
        conn.execute(
            """
            INSERT INTO code_devices (device_id, code, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET code = excluded.code, last_seen_at = excluded.last_seen_at
            """,
            (device_id, normalized, now, now),
        )
        conn.commit()
    return True


def rename_code(old_code: str, new_code: str) -> tuple[bool, str]:
    """Changes a code's own text, e.g. swapping an auto-generated
    "blue-dog" for something memorable. Every table keyed by code
    updates together in one transaction. Returns (True, "") on
    success, or (False, a message safe to show the person) otherwise."""
    normalized_old = _normalize(old_code)
    normalized_new = _normalize(new_code)

    if not _CODE_PATTERN.match(normalized_new) or not (CODE_MIN_LENGTH <= len(normalized_new) <= CODE_MAX_LENGTH):
        return False, f"Use {CODE_MIN_LENGTH}-{CODE_MAX_LENGTH} letters, numbers, dashes, or underscores."

    with cache.connect() as conn:
        if not _code_exists(conn, normalized_old):
            return False, "Unknown code."
        if normalized_new != normalized_old and _code_exists(conn, normalized_new):
            return False, "That code is already taken."

        conn.execute("UPDATE codes SET code = ? WHERE code = ?", (normalized_new, normalized_old))
        conn.execute("UPDATE code_devices SET code = ? WHERE code = ?", (normalized_new, normalized_old))
        conn.execute("UPDATE favorites SET code = ? WHERE code = ?", (normalized_new, normalized_old))
        conn.commit()
    return True, ""


def list_favorites(code: str) -> list[dict]:
    with cache.connect() as conn:
        rows = conn.execute(
            "SELECT sport, team_id, team_name, logo FROM favorites WHERE code = ? ORDER BY added_at",
            (code,),
        ).fetchall()
    return [{"sport": r[0], "team_id": r[1], "team_name": r[2], "logo": r[3]} for r in rows]


def add_favorite(code: str, sport: str, team_id: str, team_name: str, logo: str | None) -> None:
    with cache.connect() as conn:
        conn.execute(
            """
            INSERT INTO favorites (code, sport, team_id, team_name, logo, added_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(code, sport, team_id)
            DO UPDATE SET team_name = excluded.team_name, logo = excluded.logo
            """,
            (code, sport, team_id, team_name, logo, time.time()),
        )
        conn.commit()


def remove_favorite(code: str, sport: str, team_id: str) -> None:
    with cache.connect() as conn:
        conn.execute(
            "DELETE FROM favorites WHERE code = ? AND sport = ? AND team_id = ?",
            (code, sport, team_id),
        )
        conn.commit()
