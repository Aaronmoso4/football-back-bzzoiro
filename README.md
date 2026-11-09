# football-back (Bzzoiro edition)

Backend for the Android app `com.sunsetpm.footballlatest.cricfy`.

The published app calls `https://football-back-1cj4.onrender.com/` and **only accepts answers from that exact
host**, so this code must replace what runs on that existing Render service. A new service with a different URL
will not work without a new app release.

## What it does

| App calls                                  | Served from Bzzoiro                                  |
|--------------------------------------------|------------------------------------------------------|
| `/v1/scores/matches/live.json`             | `/api/v2/events/live/`                               |
| `/v1/scores/fixtures/list.json?date=`      | `/api/v2/events/?date_from&date_to&status=notstarted`|
| `/v1/scores/matches/history.json?from&to`  | `/api/v2/events/?date_from&date_to` (finished only)  |
| `/v1/scores/matches/events.json?match_id=` | `/api/v2/events/{id}/incidents/`                     |
| `/v1/scores/matches/lineups.json`          | `/api/v2/events/{id}/lineups/`                       |
| `/v1/scores/statistics/matches.json`       | `/api/v2/events/{id}/stats/`                         |
| `/v1/scores/teams/head2head.json`          | `/api/v2/events/?team_id=` filtered to the opponent  |
| `/v1/scores/competitions/list.json`        | `/api/v2/leagues/`                                   |
| `/v1/scores/competitions/table.json`       | `/api/v2/leagues/{id}/standings/`                    |
| `/v1/scores/competitions/topscorers.json`  | `/api/v2/leagues/{id}/top/scorers/` + `assists`      |
| `/v1/scores/teams/list.json`               | `/api/v2/teams/`                                     |
| `/v1/scores/federations/list.json`         | empty list (Bzzoiro has no federations)              |
| `/v1/predictions/...`                      | passed straight through to `/api/...`                |
| `/` and `/privacy`                         | `public/privacy.html`                                |
| `/healthz`                                 | `{ ok, key_configured }`                             |

Responses keep the Live-Score-API shape the app was built for (`{ "success": true, "data": … }`).
Results are cached in memory (live 20 s, fixtures 5 min, leagues and teams 6 h) to save your Bzzoiro quota.

## Known gaps

* Bzzoiro gives no team logos or player photos, so `logo` and `photo` are empty strings.
* No federations list.
* Head-to-head uses the last 5 years of team 1's finished matches.

## Deploy on Render (existing service)

1. Put this folder in a new GitHub repository (private is fine).
2. Render dashboard → service **football-back** → **Settings** → **Build & Deploy**:
   * Repository: the new repository
   * Runtime / Language: **Node**
   * Build command: `npm install`
   * Start command: `node server.js`
3. **Environment** → add `BZZOIRO_API_KEY` = your Bzzoiro token. Remove the old Live Score API variables once it works.
4. **Manual Deploy** → *Deploy latest commit*.
5. Check `https://football-back-1cj4.onrender.com/healthz` shows `"key_configured": true`, then
   `https://football-back-1cj4.onrender.com/v1/scores/matches/live.json`, then open the app.

## Run locally

```
set BZZOIRO_API_KEY=your-token
node server.js
```

Then open http://localhost:10000/v1/scores/matches/live.json
