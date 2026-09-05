"""SQLite-backed cache so we don't hammer ESPN's unofficial API.

The cache is a single generic key/value table. Callers ask for data by
key with a TTL; if the stored copy is still fresh it's returned as-is,
otherwise the caller's fetch function runs and the result is stored. If
the fetch fails and we have a stale copy on hand, we serve the stale copy
rather than failing the request outright, since slightly-old scores beat
an error page.
"""

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent / "cache.db"


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
    finally:
        conn.close()


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cache (
                key TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                fetched_at REAL NOT NULL
            )
            """
        )
        conn.commit()


def get_cached(key: str):
    with _connect() as conn:
        row = conn.execute(
            "SELECT data, fetched_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
    if row is None:
        return None, None
    data, fetched_at = row
    return json.loads(data), fetched_at


def set_cached(key: str, data) -> None:
    now = time.time()
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO cache (key, data, fetched_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at
            """,
            (key, json.dumps(data), now),
        )
        conn.commit()


def is_fresh(fetched_at, ttl_seconds: float) -> bool:
    if fetched_at is None:
        return False
    return (time.time() - fetched_at) < ttl_seconds


def get_or_fetch(key: str, ttl_seconds: float, fetch_fn: Callable[[], object]):
    cached_data, fetched_at = get_cached(key)
    if is_fresh(fetched_at, ttl_seconds):
        return cached_data

    try:
        fresh_data = fetch_fn()
    except Exception:
        if cached_data is not None:
            logger.warning("Fetch failed for %s, serving stale cache instead", key)
            return cached_data
        raise

    set_cached(key, fresh_data)
    return fresh_data
