// Football backend for the app com.sunsetpm.footballlatest.cricfy.
//
// The app was built against Live-Score-API.com's response format (routes under /v1/scores/)
// and Bzzoiro's predictions format (routes under /v1/predictions/). This server keeps both
// sets of routes and response shapes, but gets all data from Bzzoiro Sports Data
// (https://sports.bzzoiro.com), so the published app works without an update.
//
// Environment variables (set them in Render, never in code):
//   BZZOIRO_API_KEY  required: your Bzzoiro token
//   PORT             set by Render automatically
//
// Node 18+ only, no npm packages needed.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 10000;
const API_KEY = (process.env.BZZOIRO_API_KEY || '').trim();
const BZZ = 'https://sports.bzzoiro.com';
const PAGE_SIZE = 100;

if (!API_KEY) console.warn('BZZOIRO_API_KEY is not set: every data request will fail.');

// ---------------------------------------------------------------------------
// Bzzoiro client with a small in-memory cache (saves your API quota)
// ---------------------------------------------------------------------------

const cache = new Map(); // url -> { at, ttl, value }

class UpstreamError extends Error {
  constructor(status, retryAfter) {
    super(`Bzzoiro answered ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function bzz(apiPath, params = {}, ttlSeconds = 60) {
  const url = new URL(apiPath, BZZ);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) return hit.value;

  const res = await fetch(key, {
    headers: { Authorization: `Token ${API_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new UpstreamError(res.status, res.headers.get('retry-after'));
  const value = await res.json();
  cache.set(key, { at: Date.now(), ttl: ttlSeconds, value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

// Fetch every page of a paginated Bzzoiro list (count/next/results), up to maxPages.
async function bzzAll(apiPath, params, ttl, maxPages = 20) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const data = await bzz(apiPath, { ...params, limit: 200, offset: page * 200 }, ttl);
    out.push(...(data.results || []));
    if (!data.next) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lookups: league names and countries (events only carry league_id)
// ---------------------------------------------------------------------------

async function leagueMap() {
  const leagues = await bzzAll('/api/v2/leagues/', {}, 6 * 3600);
  const map = new Map();
  for (const l of leagues) map.set(String(l.id), l);
  return map;
}

// ---------------------------------------------------------------------------
// Conversions into Live-Score-API shapes the app parses
// ---------------------------------------------------------------------------

const s = (v) => (v === undefined || v === null ? '' : String(v));

// Bzzoiro ids may arrive from the app with a "match:" or "fixture:" prefix.
const cleanId = (v) => s(v).replace(/^(match|fixture):/, '');

function splitDate(iso) {
  // "2026-11-09T19:45:00+00:00" -> ["2026-11-09", "19:45"] (UTC)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ['', ''];
  const t = d.toISOString();
  return [t.slice(0, 10), t.slice(11, 16)];
}

function statusOf(e) {
  const st = s(e.status).toLowerCase();
  const period = s(e.period).toLowerCase();
  const pens = e.penalty_shootout && (e.penalty_shootout.home != null || e.penalty_shootout.away != null);
  switch (st) {
    case 'notstarted': case 'upcoming': case 'scheduled': case 'delayed': return 'NOT STARTED';
    case 'halftime': return 'HALF TIME BREAK';
    case 'extratime': return 'EXTRA TIME';
    case 'penalties': return 'PENALTY SHOOTOUT';
    case 'finished': case 'ft': return pens ? 'AFTER PENALTIES' : 'FINISHED';
    case 'aet': return pens ? 'AFTER PENALTIES' : 'AFTER EXTRA TIME';
    case 'ap': return 'AFTER PENALTIES';
    case 'cancelled': case 'canceled': return 'CANCELLED';
    case 'postponed': return 'POSTPONED';
    case 'interrupted': return 'INTERRUPTED';
    case 'suspended': return 'SUSPENDED';
    case 'abandoned': return 'ABANDONED';
    case 'unresolved': return 'INSUFFICIENT DATA';
    case '1st_half': case '2nd_half': case 'inprogress': case 'live':
      if (period.includes('ht') || period.includes('half_time')) return 'HALF TIME BREAK';
      return 'IN PLAY';
    default: return 'NOT STARTED';
  }
}

function toMatch(e, leagues) {
  const [date, hhmm] = splitDate(e.event_date);
  const status = statusOf(e);
  const league = (leagues && leagues.get(String(e.league_id))) || {};
  const hasScore = e.home_score != null && e.away_score != null;
  const score = hasScore ? `${e.home_score} - ${e.away_score}` : '';
  let time = hhmm;
  if (status === 'IN PLAY' || status === 'EXTRA TIME') time = s(e.current_minute || '');
  else if (status === 'HALF TIME BREAK') time = 'HT';
  else if (status === 'FINISHED' || status === 'AFTER EXTRA TIME' || status === 'AFTER PENALTIES') time = 'FT';
  const id = s(e.id);
  return {
    id,
    fixture_id: id,
    date,
    scheduled: hhmm,
    time,
    added: '',
    status,
    location: '',
    home: { id: s(e.home_team_id), name: s(e.home_team), logo: '' },
    away: { id: s(e.away_team_id), name: s(e.away_team), logo: '' },
    home_id: s(e.home_team_id),
    home_name: s(e.home_team),
    away_id: s(e.away_team_id),
    away_name: s(e.away_team),
    competition: { id: s(e.league_id), name: s(e.league_name || league.name) },
    country: { name: s(league.country) },
    scores: { score, ht_score: e.home_score_ht != null ? `${e.home_score_ht} - ${e.away_score_ht}` : '' },
  };
}

function paged(key, rows, page) {
  const total = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(1, Number(page) || 1), total);
  return {
    [key]: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE),
    total_pages: total,
    next_page: p < total ? `?page=${p + 1}` : null,
  };
}

const INCIDENT_TYPES = {
  goal: 'GOAL', own_goal: 'GOAL', owngoal: 'GOAL', penalty: 'GOAL', penalty_goal: 'GOAL',
  yellow_card: 'YELLOW_CARD', yellowcard: 'YELLOW_CARD', yellow: 'YELLOW_CARD',
  red_card: 'RED_CARD', redcard: 'RED_CARD', red: 'RED_CARD',
  yellow_red_card: 'YELLOW_RED_CARD', yellowred: 'YELLOW_RED_CARD', second_yellow: 'YELLOW_RED_CARD',
  substitution: 'SUBSTITUTION', sub: 'SUBSTITUTION',
};

function incidentType(i) {
  const t = s(i.type || i.incident_type).toLowerCase();
  if (t === 'card') {
    const c = s(i.card || i.card_type || i.color || i.class).toLowerCase();
    if (c.includes('yellowred') || c.includes('second')) return 'YELLOW_RED_CARD';
    return c.includes('red') ? 'RED_CARD' : 'YELLOW_CARD';
  }
  return INCIDENT_TYPES[t] || null;
}

const nameOf = (v) => (v && typeof v === 'object' ? s(v.name || v.short_name) : s(v));

function lineupPlayers(side) {
  if (!side) return { players: [] };
  const map = (p, sub) => ({
    id: s(p.id || p.player_id),
    name: s(p.name || p.player_name || p.short_name),
    shirt_number: Number(p.shirt_number || p.jersey_number || p.number || 0),
    position: s(p.position || p.pos),
    substitution: sub ? 1 : 0,
  });
  return {
    players: [
      ...(side.players || []).map((p) => map(p, false)),
      ...(side.substitutes || []).map((p) => map(p, true)),
    ],
  };
}

const STAT_LABELS = [
  ['ball_possession', 'Ball possession', true],
  ['total_shots', 'Total shots'],
  ['shots_on_target', 'Shots on target'],
  ['corner_kicks', 'Corner kicks'],
  ['fouls', 'Fouls'],
  ['offsides', 'Offsides'],
  ['yellow_cards', 'Yellow cards'],
  ['red_cards', 'Red cards'],
  ['pass_accuracy_pct', 'Pass accuracy', true],
];

// ---------------------------------------------------------------------------
// /v1/scores/<route> handlers (Live-Score-API compatible)
// ---------------------------------------------------------------------------

const scores = {
  async 'matches/live.json'() {
    const [live, leagues] = await Promise.all([bzz('/api/v2/events/live/', { limit: 200 }, 20), leagueMap()]);
    return { match: (live.events || []).map((e) => toMatch(e, leagues)) };
  },

  async 'fixtures/list.json'(q) {
    const date = q.get('date') || new Date().toISOString().slice(0, 10);
    const [events, leagues] = await Promise.all([
      bzzAll('/api/v2/events/', { date_from: date, date_to: date, status: 'notstarted' }, 300),
      leagueMap(),
    ]);
    return paged('fixtures', events.map((e) => toMatch(e, leagues)), q.get('page'));
  },

  async 'matches/history.json'(q) {
    const today = new Date().toISOString().slice(0, 10);
    const from = q.get('from') || today;
    const to = q.get('to') || from;
    const [events, leagues] = await Promise.all([
      bzzAll('/api/v2/events/', { date_from: from, date_to: to }, 120),
      leagueMap(),
    ]);
    const done = events.filter((e) => /^(finished|aet|ap|ft)$/i.test(s(e.status)));
    return paged('match', done.map((e) => toMatch(e, leagues)), q.get('page'));
  },

  async 'matches/events.json'(q) {
    const id = cleanId(q.get('match_id') || q.get('id'));
    const data = await bzz(`/api/v2/events/${encodeURIComponent(id)}/incidents/`, {}, 30);
    const event = [];
    (data.incidents || []).forEach((i, n) => {
      const type = incidentType(i);
      if (!type) return;
      const minute = s(i.minute ?? i.time ?? '');
      const added = i.added_time || i.added ? `+${i.added_time || i.added}` : '';
      const isSub = type === 'SUBSTITUTION';
      event.push({
        id: `${id}_${n}`,
        time: minute ? `${minute}${added}` : '',
        event: type,
        is_home: i.is_home === true || i.is_home === 1 || s(i.side).toLowerCase() === 'home',
        player: { name: isSub ? nameOf(i.player_in || i.player) : nameOf(i.player) },
        info: { name: isSub ? nameOf(i.player_out) : nameOf(i.assist) },
        label: s(i.text || i.description || i.reason || ''),
      });
    });
    return { event };
  },

  async 'matches/lineups.json'(q) {
    const id = cleanId(q.get('match_id') || q.get('id'));
    const data = await bzz(`/api/v2/events/${encodeURIComponent(id)}/lineups/`, {}, 300);
    const l = data.lineups || {};
    return { lineup: { home: lineupPlayers(l.home), away: lineupPlayers(l.away) } };
  },

  async 'statistics/matches.json'(q) {
    const id = cleanId(q.get('match_id') || q.get('id'));
    const data = await bzz(`/api/v2/events/${encodeURIComponent(id)}/stats/`, {}, 30);
    const h = (data.stats && data.stats.home) || {};
    const a = (data.stats && data.stats.away) || {};
    return STAT_LABELS
      .filter(([k]) => h[k] != null || a[k] != null)
      .map(([k, label, pct]) => ({
        label,
        home: `${h[k] ?? 0}${pct ? '%' : ''}`,
        away: `${a[k] ?? 0}${pct ? '%' : ''}`,
      }));
  },

  async 'teams/head2head.json'(q) {
    const t1 = cleanId(q.get('team1_id'));
    const t2 = cleanId(q.get('team2_id'));
    const today = new Date();
    const from = new Date(today.getTime() - 5 * 365 * 864e5).toISOString().slice(0, 10);
    const [events, leagues] = await Promise.all([
      bzzAll('/api/v2/events/', { team_id: t1, date_from: from, date_to: today.toISOString().slice(0, 10), status: 'finished' }, 3600, 5),
      leagueMap(),
    ]);
    const h2h = events
      .filter((e) => s(e.home_team_id) === t2 || s(e.away_team_id) === t2)
      .sort((x, y) => s(y.event_date).localeCompare(s(x.event_date)))
      .slice(0, 10)
      .map((e) => toMatch(e, leagues));
    return { h2h };
  },

  async 'competitions/list.json'(q) {
    const leagues = [...(await leagueMap()).values()];
    const rows = leagues.map((l) => ({
      id: s(l.id),
      name: s(l.name),
      logo: '',
      countries: l.country ? [{ id: '', name: s(l.country) }] : [],
      federations: [],
      season: { name: s(l.current_season && l.current_season.name) },
    }));
    return paged('competition', rows, q.get('page'));
  },

  async 'federations/list.json'() {
    return { federation: [] }; // Bzzoiro has no federations (UEFA, CAF...) list.
  },

  async 'teams/list.json'(q) {
    const teams = await bzzAll('/api/v2/teams/', {}, 6 * 3600, 30);
    const rows = teams.map((t) => ({ id: s(t.id), name: s(t.name), country: s(t.country), logo: '', stadium: '' }));
    return paged('teams', rows, q.get('page'));
  },

  async 'competitions/table.json'(q) {
    const id = cleanId(q.get('competition_id'));
    const data = await bzz(`/api/v2/leagues/${encodeURIComponent(id)}/standings/`, {}, 600);
    const row = (r) => ({
      team: { id: s(r.team_id), name: s(r.team_name), logo: '' },
      rank: r.position,
      matches: r.played,
      won: r.won,
      drawn: r.drawn,
      lost: r.lost,
      goals_scored: r.gf,
      goals_conceded: r.ga,
      goal_diff: r.gd,
      points: r.pts,
    });
    let groups;
    if (data.grouped && data.groups && typeof data.groups === 'object') {
      const entries = Array.isArray(data.groups)
        ? data.groups.map((g, n) => [g.name || g.group_name || `${n + 1}`, g.standings || g.rows || []])
        : Object.entries(data.groups);
      groups = entries.map(([name, rows]) => ({ name: s(name), standings: (rows || []).map(row) }));
    } else {
      groups = [{ name: '', standings: (data.standings || []).map(row) }];
    }
    return { stages: [{ name: s(data.season && data.season.name), groups }] };
  },

  async 'competitions/topscorers.json'(q) {
    const id = encodeURIComponent(cleanId(q.get('competition_id')));
    const [goals, assists] = await Promise.all([
      bzz(`/api/v2/leagues/${id}/top/scorers/`, { stat: 'scorers', limit: 50 }, 1800),
      bzz(`/api/v2/leagues/${id}/top/assists/`, { stat: 'assists', limit: 200 }, 1800).catch(() => ({ leaders: [] })),
    ]);
    const assistBy = new Map((assists.leaders || []).map((p) => [s(p.player_id), p.value]));
    const topscorers = (goals.leaders || []).map((p) => ({
      player: { id: s(p.player_id), name: s(p.player_name), photo: '' },
      team: { id: s(p.team_id), name: s(p.team_name), logo: '' },
      goals: p.value ?? 0,
      assists: assistBy.get(s(p.player_id)) ?? 0,
      played: p.matches ?? 0,
    }));
    return { topscorers };
  },
};

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const privacyHtml = fs.readFileSync(path.join(__dirname, 'public', 'privacy.html'));

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function upstreamFailure(res, err, route) {
  if (err instanceof UpstreamError) {
    console.warn(`${route}: Bzzoiro ${err.status}`);
    if (err.status === 429) return send(res, 429, { success: false, error: 'rate limited' }, { 'Retry-After': err.retryAfter || '60' });
    if (err.status === 404) return null; // caller turns this into an empty result
    return send(res, 502, { success: false, error: `provider error ${err.status}` });
  }
  console.error(`${route}:`, err && err.message);
  return send(res, 502, { success: false, error: 'provider unavailable' });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { success: false });

    if (p === '/' || p === '/privacy' || p === '/privacy/') return send(res, 200, privacyHtml);
    if (p === '/healthz') return send(res, 200, { ok: true, key_configured: Boolean(API_KEY) });

    if (p.startsWith('/v1/scores/')) {
      const route = p.slice('/v1/scores/'.length);
      const handler = scores[route];
      if (!handler) return send(res, 404, { success: false, error: 'unknown route' });
      try {
        const data = await handler(url.searchParams);
        return send(res, 200, { success: true, data });
      } catch (err) {
        if (err instanceof UpstreamError && err.status === 404) return send(res, 200, { success: true, data: {} });
        return upstreamFailure(res, err, route);
      }
    }

    if (p.startsWith('/v1/predictions/')) {
      // The app already speaks Bzzoiro's predictions format: pass it straight through.
      const rest = p.slice('/v1/predictions/'.length).replace(/\.\./g, '');
      const params = Object.fromEntries(url.searchParams);
      try {
        const data = await bzz(`/api/${rest}`, params, 600);
        // Page links must point back at this server: the app refuses any other host.
        const self = `https://${req.headers.host}/v1/predictions/`;
        const fix = (link) => (typeof link === 'string' ? link.replace(/^https?:\/\/sports\.bzzoiro\.com\/api\//, self) : link);
        return send(res, 200, { ...data, next: fix(data.next), previous: fix(data.previous) });
      } catch (err) {
        return upstreamFailure(res, err, `predictions/${rest}`) || send(res, 404, { detail: 'Not found.' });
      }
    }

    return send(res, 404, { success: false, error: 'not found' });
  } finally {
    console.log(`${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`);
  }
});

server.listen(PORT, () => console.log(`football-back listening on ${PORT}`));
