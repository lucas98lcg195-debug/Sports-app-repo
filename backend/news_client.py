"""Fetches and normalizes sports news from several sources into one shape.

ESPN's news endpoint is JSON, the same trust tier as the scoreboard
endpoint this app already relies on. The rest are plain RSS or Atom
feeds, the format publishers put out specifically for aggregation
rather than a private API meant only for their own app. Each source is
still treated as best-effort: a feed that is dead, moved, or was never
right to begin with is skipped rather than failing the whole news tab.
If a source in SOURCES below turns out to have the wrong url, fix it
here, nothing else needs to change.
"""

import logging
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT_SECONDS = 10
ATOM_NS = "{http://www.w3.org/2005/Atom}"
MEDIA_NS = "{http://search.yahoo.com/mrss/}"

# A plain browser User-Agent, some of these sites reject the default
# python-requests one.
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; ncaa-scores-app/1.0)"}

SOURCES = [
    {
        "id": "espn-football",
        "name": "ESPN (Football)",
        "kind": "espn_json",
        "url": "https://site.api.espn.com/apis/site/v2/sports/football/college-football/news",
    },
    {
        "id": "espn-baseball",
        "name": "ESPN (Baseball)",
        "kind": "espn_json",
        "url": "https://site.api.espn.com/apis/site/v2/sports/baseball/college-baseball/news",
    },
    {
        "id": "cbs-sports",
        "name": "CBS Sports",
        "kind": "rss",
        "url": "https://www.cbssports.com/rss/headlines/college-football/",
    },
    {
        "id": "on3",
        "name": "On3",
        "kind": "rss",
        "url": "https://www.on3.com/feed/",
    },
    {
        "id": "247sports",
        "name": "247Sports",
        "kind": "rss",
        "url": "https://247sports.com/college/rss/",
    },
    {
        "id": "si",
        "name": "Sports Illustrated",
        "kind": "rss",
        "url": "https://www.si.com/rss/si_topstories.rss",
    },
]


class NewsSourceError(Exception):
    """Raised when a single news source can't be fetched or parsed.
    Callers should catch this per source rather than let one dead feed
    take down the rest."""


def _get(url: str):
    try:
        response = requests.get(url, timeout=REQUEST_TIMEOUT_SECONDS, headers=REQUEST_HEADERS)
        response.raise_for_status()
        return response
    except requests.RequestException as exc:
        raise NewsSourceError(f"Failed to reach {url}: {exc}") from exc


def fetch_source(source: dict) -> list[dict]:
    """Fetch and normalize one source's articles."""
    try:
        if source["kind"] == "espn_json":
            return _fetch_espn_json(source)
        if source["kind"] == "rss":
            return _fetch_feed(source)
        raise NewsSourceError(f"Unknown source kind: {source['kind']}")
    except NewsSourceError:
        raise
    except Exception as exc:
        raise NewsSourceError(f"Failed to fetch {source['id']}: {exc}") from exc


def _fetch_espn_json(source: dict) -> list[dict]:
    response = _get(source["url"])
    try:
        raw = response.json()
    except ValueError as exc:
        raise NewsSourceError(f"{source['id']} returned invalid JSON: {exc}") from exc

    articles = []
    for item in raw.get("articles", []):
        try:
            images = item.get("images") or []
            image = images[0].get("url") if images else None
            link = ((item.get("links") or {}).get("web") or {}).get("href")
            articles.append(
                {
                    "headline": item.get("headline", ""),
                    "description": item.get("description", ""),
                    "link": link,
                    "image": image,
                    "published": item.get("published"),
                    "source_id": source["id"],
                    "source_name": source["name"],
                }
            )
        except (KeyError, IndexError, TypeError) as exc:
            logger.warning("Skipping malformed article from %s: %s", source["id"], exc)
    return articles


def _fetch_feed(source: dict) -> list[dict]:
    response = _get(source["url"])
    try:
        root = ET.fromstring(response.content)
    except ET.ParseError as exc:
        raise NewsSourceError(f"{source['id']} returned invalid XML: {exc}") from exc

    if root.tag.endswith("feed"):
        return _parse_atom(root, source)
    return _parse_rss(root, source)


def _parse_rss(root, source: dict) -> list[dict]:
    articles = []
    for item in root.findall(".//item"):
        try:
            image = None
            enclosure = item.find("enclosure")
            if enclosure is not None:
                image = enclosure.get("url")
            if image is None:
                media_thumb = item.find(f"{MEDIA_NS}thumbnail")
                if media_thumb is not None:
                    image = media_thumb.get("url")

            articles.append(
                {
                    "headline": _text(item, "title"),
                    "description": _text(item, "description"),
                    "link": _text(item, "link"),
                    "image": image,
                    "published": _text(item, "pubDate"),
                    "source_id": source["id"],
                    "source_name": source["name"],
                }
            )
        except Exception as exc:
            logger.warning("Skipping malformed RSS item from %s: %s", source["id"], exc)
    return articles


def _parse_atom(root, source: dict) -> list[dict]:
    articles = []
    for entry in root.findall(f"{ATOM_NS}entry"):
        try:
            link = None
            for link_el in entry.findall(f"{ATOM_NS}link"):
                if link_el.get("rel") in (None, "alternate"):
                    link = link_el.get("href")
                    break

            articles.append(
                {
                    "headline": _text(entry, f"{ATOM_NS}title"),
                    "description": _text(entry, f"{ATOM_NS}summary") or _text(entry, f"{ATOM_NS}content"),
                    "link": link,
                    "image": None,
                    "published": _text(entry, f"{ATOM_NS}updated") or _text(entry, f"{ATOM_NS}published"),
                    "source_id": source["id"],
                    "source_name": source["name"],
                }
            )
        except Exception as exc:
            logger.warning("Skipping malformed Atom entry from %s: %s", source["id"], exc)
    return articles


def _text(element, tag: str) -> str:
    child = element.find(tag)
    if child is None or child.text is None:
        return ""
    return child.text.strip()


def parse_published(value):
    """Best-effort parse of a published date into a sortable, timezone
    aware datetime. Returns None rather than raising when a date is
    missing or in a format we don't recognize, dates arrive as RFC 822
    from RSS feeds and as ISO 8601 from ESPN's JSON and Atom feeds."""
    if not value:
        return None

    dt = None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        pass

    if dt is None:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt
