"""FastAPI app: routes plus the background scoreboard poller.

Routes read from the SQLite cache first and only call ESPN when the
cached copy has aged past its TTL. A background job also keeps today's
scoreboards warm on its own schedule, speeding up while a game is live
and backing off when nothing is in progress, but never polling ESPN more
often than every 30 seconds either way.
"""

import logging
from datetime import date as date_cls, datetime, timezone
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

import cache
import espn_client
import news_client
from conferences import CONFERENCES_BY_SPORT
from models import game_to_dict

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="NCAA Scores API")

SPORTS = ["football", "baseball"]

LIVE_POLL_SECONDS = 30
IDLE_POLL_SECONDS = 300
SCOREBOARD_TTL_SECONDS = 30
SUMMARY_TTL_SECONDS = 30
SCHEDULE_TTL_SECONDS = 3600
NEWS_TTL_SECONDS = 900  # news doesn't need live-score cadence

REFRESH_JOB_ID = "refresh_scoreboards"

scheduler = BackgroundScheduler()


def today_str() -> str:
    return date_cls.today().strftime("%Y%m%d")


def scoreboard_cache_key(sport: str, date: str, conference: Optional[str] = None) -> str:
    return f"scoreboard:{sport}:{date}:{conference or 'all'}"


def fetch_and_build_scoreboard(sport: str, date: str, conference: Optional[str] = None) -> list[dict]:
    raw = espn_client.fetch_scoreboard_raw(sport, date=date, groups=conference)
    games = espn_client.parse_scoreboard(raw, sport)
    return [game_to_dict(g) for g in games]


def is_known_conference(sport: str, conference: str) -> bool:
    return any(c["id"] == conference for c in CONFERENCES_BY_SPORT.get(sport, []))


def refresh_today_scoreboards() -> None:
    """Background job body. Refreshes today's cache for both sports and
    speeds up or slows down its own interval based on whether any game
    is currently live."""
    date = today_str()
    any_live = False

    for sport in SPORTS:
        try:
            games = fetch_and_build_scoreboard(sport, date)
            cache.set_cached(scoreboard_cache_key(sport, date), games)
            if any(g["status_state"] == "in" for g in games):
                any_live = True
        except Exception as exc:
            logger.warning("Background refresh failed for %s: %s", sport, exc)

    desired_interval = LIVE_POLL_SECONDS if any_live else IDLE_POLL_SECONDS
    job = scheduler.get_job(REFRESH_JOB_ID)
    if job is not None and job.trigger.interval.total_seconds() != desired_interval:
        scheduler.reschedule_job(REFRESH_JOB_ID, trigger=IntervalTrigger(seconds=desired_interval))


@app.on_event("startup")
def on_startup() -> None:
    cache.init_db()
    scheduler.add_job(
        refresh_today_scoreboards,
        trigger=IntervalTrigger(seconds=LIVE_POLL_SECONDS),
        id=REFRESH_JOB_ID,
        max_instances=1,
        coalesce=True,
    )
    scheduler.start()
    refresh_today_scoreboards()


@app.on_event("shutdown")
def on_shutdown() -> None:
    scheduler.shutdown(wait=False)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/conferences/{sport}")
def get_conferences(sport: str) -> dict:
    if sport not in SPORTS:
        raise HTTPException(status_code=404, detail=f"Unknown sport: {sport}")
    return {"sport": sport, "conferences": CONFERENCES_BY_SPORT.get(sport, [])}


@app.get("/api/scoreboard/{sport}")
def get_scoreboard(sport: str, date: Optional[str] = None, conference: Optional[str] = None) -> dict:
    if sport not in SPORTS:
        raise HTTPException(status_code=404, detail=f"Unknown sport: {sport}")
    if conference and not is_known_conference(sport, conference):
        raise HTTPException(status_code=404, detail=f"Unknown conference for {sport}: {conference}")

    target_date = date or today_str()
    key = scoreboard_cache_key(sport, target_date, conference)

    try:
        games = cache.get_or_fetch(
            key,
            SCOREBOARD_TTL_SECONDS,
            lambda: fetch_and_build_scoreboard(sport, target_date, conference),
        )
    except espn_client.EspnApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {"sport": sport, "date": target_date, "conference": conference, "games": games}


@app.get("/api/game/{sport}/{game_id}")
def get_game(sport: str, game_id: str) -> dict:
    if sport not in SPORTS:
        raise HTTPException(status_code=404, detail=f"Unknown sport: {sport}")

    key = f"summary:{sport}:{game_id}"

    def fetch() -> dict:
        raw = espn_client.fetch_summary_raw(sport, game_id)
        return espn_client.parse_summary(raw, sport, game_id)

    try:
        return cache.get_or_fetch(key, SUMMARY_TTL_SECONDS, fetch)
    except espn_client.EspnApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/team/{sport}/{team_id}/schedule")
def get_team_schedule(sport: str, team_id: str) -> dict:
    if sport not in SPORTS:
        raise HTTPException(status_code=404, detail=f"Unknown sport: {sport}")

    key = f"schedule:{sport}:{team_id}"

    def fetch() -> dict:
        raw = espn_client.fetch_team_schedule_raw(sport, team_id)
        return espn_client.parse_schedule(raw, sport, team_id)

    try:
        return cache.get_or_fetch(key, SCHEDULE_TTL_SECONDS, fetch)
    except espn_client.EspnApiError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@app.get("/api/news/sources")
def get_news_sources() -> dict:
    return {"sources": [{"id": s["id"], "name": s["name"]} for s in news_client.SOURCES]}


@app.get("/api/news")
def get_news(source: Optional[str] = None) -> dict:
    if source and not any(s["id"] == source for s in news_client.SOURCES):
        raise HTTPException(status_code=404, detail=f"Unknown news source: {source}")

    sources_to_fetch = [s for s in news_client.SOURCES if not source or s["id"] == source]

    articles = []
    unavailable_sources = []
    for src in sources_to_fetch:
        key = f"news:{src['id']}"
        try:
            articles.extend(cache.get_or_fetch(key, NEWS_TTL_SECONDS, lambda s=src: news_client.fetch_source(s)))
        except news_client.NewsSourceError as exc:
            logger.warning("News source %s unavailable: %s", src["id"], exc)
            unavailable_sources.append(src["id"])

    articles.sort(key=_article_sort_key, reverse=True)

    return {"source": source, "articles": articles, "unavailable_sources": unavailable_sources}


def _article_sort_key(article: dict) -> datetime:
    return news_client.parse_published(article.get("published")) or datetime.min.replace(tzinfo=timezone.utc)


# Serve the dependency-free frontend straight off disk. This is mounted
# last so the API routes above are matched first.
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
