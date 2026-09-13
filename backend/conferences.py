"""Conference reference data used for the scoreboard's conference filter.

ESPN's scoreboard endpoint accepts a `groups` id that scopes the results
to a single conference, but nothing in ESPN's scoreboard or summary
payloads names a game's conference back to us, so there is no reliable
way to read this from the API response itself. These ids are ESPN's own
internal identifiers for each conference, the same ones ESPN's own site
uses for its conference filter, so they are unlikely to change.

The football list is well established and used widely. The baseball
list only covers the conferences shared with football (the ids are the
same organization across sports), since the smaller baseball-only
conferences are harder to confirm without hitting ESPN directly. Add to
either list here if a conference is missing or an id turns out wrong.
"""

FOOTBALL_CONFERENCES = [
    {"id": "1", "name": "ACC"},
    {"id": "4", "name": "Big 12"},
    {"id": "5", "name": "Big Ten"},
    {"id": "8", "name": "SEC"},
    {"id": "9", "name": "Pac-12"},
    {"id": "12", "name": "Conference USA"},
    {"id": "15", "name": "MAC"},
    {"id": "17", "name": "Mountain West"},
    {"id": "18", "name": "FBS Independents"},
    {"id": "37", "name": "Sun Belt"},
    {"id": "62", "name": "American Athletic"},
]

BASEBALL_CONFERENCES = [
    {"id": "1", "name": "ACC"},
    {"id": "4", "name": "Big 12"},
    {"id": "5", "name": "Big Ten"},
    {"id": "8", "name": "SEC"},
    {"id": "9", "name": "Pac-12"},
]

# The NFL has no NCAA-style conferences, this is its own separate id
# namespace (AFC/NFC), unrelated to the college football/baseball ids
# above even where a number happens to coincide. Conference-level only
# for now, not broken out by division yet, and a best-effort guess
# rather than confirmed against a real standings response the way the
# college list above has been in practice, correct these if ESPN
# rejects either id or returns the wrong conference's teams.
NFL_CONFERENCES = [
    {"id": "8", "name": "AFC"},
    {"id": "7", "name": "NFC"},
]

CONFERENCES_BY_SPORT = {
    "football": FOOTBALL_CONFERENCES,
    "baseball": BASEBALL_CONFERENCES,
    "nfl": NFL_CONFERENCES,
}
