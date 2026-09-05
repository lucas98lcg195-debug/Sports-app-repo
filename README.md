# Sports-app-repo

A lightweight, ad-free personal scores app for NCAA football and baseball. It pulls live data from ESPN's public unofficial JSON API and shows scores, schedules, and box scores without any of the articles, ads, or clutter of the official ESPN app. It ships as a Progressive Web App, so it installs on an iPhone through Safari's Add to Home Screen option without going through the App Store.

## How it is built

The backend is a FastAPI application under `backend/`. It fetches data from ESPN's scoreboard, summary, and team schedule endpoints, trims each response down to the handful of fields the frontend actually needs, and stores the result in a small SQLite cache so the app never hits ESPN more often than once every thirty seconds. A background job keeps today's scoreboards refreshed on its own, polling every thirty seconds while a game is in progress and backing off to every five minutes once nothing is live.

The frontend under `frontend/` is plain HTML, CSS, and JavaScript with no build step and no framework. `index.html` shows today's games grouped by sport with each team's logo, score, and status. Tapping a team logo on the scoreboard opens that game's box score in `game.html`. From the box score, tapping a team logo opens that team's full season schedule in `team.html`, and from a schedule, tapping an opponent's logo jumps to that opponent's schedule in turn. Each game also carries a "Watch on ESPN" link straight to that game's real ESPN page, where ESPN's own sign-in and player live, this app never touches a password or streams video itself. A `news.html` tab shows a merged, filterable headline feed pulled from ESPN and a few other sports outlets, always linking out to the original article rather than reproducing it. A manifest and service worker make the app installable and keep the static shell and team logos available offline, while live score and news requests always go to the network so nothing goes stale.

## Running it locally

Install the backend dependencies with `pip install -r backend/requirements.txt`, then start the server from the `backend/` directory with `uvicorn main:app --reload --port 8000`. The FastAPI app serves both the API routes and the static frontend from the same process, so visiting `http://localhost:8000/` in a browser loads the scoreboard directly. There is no separate frontend server and no npm install to run.

## API routes

`GET /api/health` returns a simple status check. `GET /api/scoreboard/{sport}` returns today's games for `football` or `baseball`, or a specific day when given an optional `date` query parameter in `YYYYMMDD` form, each game including the TV or streaming channel it's on where ESPN reports one. An optional `conference` query parameter scopes the results to one conference, using the id ESPN itself assigns that conference. `GET /api/conferences/{sport}` lists the conferences available for that sport's dropdown, each with the id the scoreboard route expects. `GET /api/game/{sport}/{gameId}` returns box score data for a single game, including the line score, team stats, and scoring plays where ESPN provides them. `GET /api/team/{sport}/{teamId}/schedule` returns a team's full season schedule.

The conference list is a small static table in `backend/conferences.py` rather than something read from ESPN, since ESPN's scoreboard and summary payloads never name a game's conference back to the caller. The football ids are well established. The baseball list only covers the conferences shared with football, since the smaller baseball-only conferences are harder to confirm without hitting ESPN directly. Add to either list in that file if a conference is missing.

`GET /api/news` returns a merged, newest-first list of articles from every configured news source, or just one source when given an optional `source` query parameter. `GET /api/news/sources` lists the sources available for that dropdown. The source list lives in `backend/news_client.py`, mixing ESPN's own news endpoint with plain RSS and Atom feeds from a few other outlets, RSS being the format publishers put out specifically for this kind of aggregation. Each source is fetched independently and a dead or wrong feed URL is simply left out of the merged list rather than failing the whole tab, so if a source in that file never shows any articles, its feed URL is the first thing to check and fix.

Every article is also run through a relevance filter before it reaches the feed, keeping only stories whose headline or description mention football, baseball, Auburn, Mississippi State University, MSU, or the transfer portal. That keyword list is `RELEVANCE_KEYWORDS` in `backend/news_client.py`, plain text and easy to edit directly.

## Deploying

The app is a single Python process with no external database, so it deploys cleanly to Render's free web service tier straight from this GitHub repository. Point Render at the `backend/` directory, set the start command to `uvicorn main:app --host 0.0.0.0 --port $PORT`, and the same process will serve the API and the installable frontend at the resulting public URL. A custom domain from a registrar such as Cloudflare can be pointed at that Render service afterward if wanted, though it is not required to use the app.

## Scope

This is a single-user personal project. There are no user accounts, no authentication, and no multi-user features, and none are planned.
