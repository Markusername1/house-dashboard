'use strict';

/**
 * House dashboard collector.
 *
 * Polls each source independently and writes data/dashboard.json.
 * One source failing must never blank the page, so every source is wrapped:
 * on failure the previous good value is carried forward with its ORIGINAL
 * fetchedAt, so the age shown on screen is the age of the data, not the age
 * of the attempt.
 *
 *   node fetch.js            write data/dashboard.json
 *   node fetch.js --inspect  print raw upstream shapes, write nothing
 *
 * Node 20+. Native fetch only, no dependencies.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const OUT = path.join(ROOT, 'data', 'dashboard.json');
const TZ = CONFIG.timezone;

const UA = 'house-dashboard/1.0 (+github-pages static site)';

/* ------------------------------------------------------------------ *
 * Time. Actions runs in UTC and the house is in Australia/Sydney, so
 * every date decision below goes through Intl with an explicit zone.
 * Plain calendar dates ("2026-09-04") are handled as UTC-noon instants
 * so day arithmetic can never drift across a boundary.
 * ------------------------------------------------------------------ */

/** Wall-clock parts at instant `d` in zone `tz`. */
function partsIn(d, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long',
  });
  const p = {};
  for (const { type, value } of f.formatToParts(d)) p[type] = value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour === '24' ? '0' : p.hour),
    minute: Number(p.minute),
    weekday: p.weekday,
  };
}

/** Today's calendar date in the house's zone, as YYYY-MM-DD. */
function todayYmd(now = new Date()) {
  return partsIn(now, TZ).ymd;
}

function ymdToUTC(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

/** Whole days from `a` to `b`, both YYYY-MM-DD. Negative if b is past. */
function daysBetween(a, b) {
  return Math.round((ymdToUTC(b) - ymdToUTC(a)) / 86400000);
}

function addDays(ymd, n) {
  const d = new Date(ymdToUTC(ymd) + n * 86400000);
  return d.toISOString().slice(0, 10);
}

/** Long weekday name for a plain calendar date. */
function weekdayOf(ymd) {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: 'long' })
    .format(new Date(ymdToUTC(ymd)));
}

/** "04/09/2026" (the ACT dataset's format) -> "2026-09-04". */
function auDateToYmd(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

async function get(url, { as = 'json', tries = 3, timeout = 15000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      if (as === 'text') return text;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`response was not JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}…)`);
      }
    } catch (err) {
      last = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw new Error(`${new URL(url).host}: ${last.message}`);
}

/** Read a field by its exact key, falling back to a regex over the row's keys. */
function pick(row, exactKey, pattern) {
  if (row[exactKey] != null && row[exactKey] !== '') return row[exactKey];
  const key = Object.keys(row).find((k) => pattern.test(k));
  return key ? row[key] : null;
}

/* ------------------------------------------------------------------ *
 * Minimal XML reading. The ESA feeds are flat RSS; this is deliberately
 * not a general parser.
 * ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagText(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\s[^>]*)?>([\s\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : null;
}

function itemBlocks(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ------------------------------------------------------------------ *
 * Sources. Each returns plain data, or null to mean "nothing to show".
 * Throwing is fine — the wrapper turns it into a visible stale state.
 * ------------------------------------------------------------------ */

const BINS_URL = 'https://www.data.act.gov.au/resource/jzzy-44un.json';

/**
 * ACT kerbside collection. Column names below were confirmed against the
 * live dataset; the regex is kept only as a fallback if the portal renames
 * a field. The dataset publishes real forward pickup dates, so nothing here
 * is derived from a weekday offset.
 */
async function bins() {
  const rows = await get(`${BINS_URL}?$limit=5000`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('bin dataset returned no rows');

  const want = String(CONFIG.suburb || '').trim().toUpperCase();
  if (!want) throw new Error('config.json has no suburb set');

  let matches = rows.filter((r) => String(pick(r, 'suburb', /suburb/i) || '').trim().toUpperCase() === want);
  if (!matches.length) throw new Error(`suburb "${CONFIG.suburb}" is not in the ACT collection dataset`);

  // Some suburbs are split across collection days (Charnwood, Dunlop, Lyneham).
  // Guessing here would put the wrong bin on the kerb, which is the single
  // worst thing this page could do, so an unresolved split is a hard error.
  if (matches.length > 1) {
    const parts = matches.map((r) => pick(r, 'split_suburb', /split/i) || '(unlabelled)');
    console.error(`  ${want} has ${matches.length} rows: ${parts.join(', ')}`);
    const wantSplit = String(CONFIG.splitSuburb || '').trim().toLowerCase();
    if (!wantSplit) {
      throw new Error(
        `${CONFIG.suburb} is split into ${parts.join(' / ')} — set "splitSuburb" in config.json to one of these`
      );
    }
    matches = matches.filter((r) => String(pick(r, 'split_suburb', /split/i) || '').trim().toLowerCase() === wantSplit);
    if (!matches.length) {
      throw new Error(`splitSuburb "${CONFIG.splitSuburb}" does not match any ${CONFIG.suburb} row (${parts.join(' / ')})`);
    }
  }

  const row = matches[0];
  const today = todayYmd();
  const greenType = pick(row, 'greenwaste_type', /greenwaste_type/i) || 'Greenwaste';

  const defs = [
    {
      key: 'garbage', lid: 'red', name: 'General waste',
      date: ['garbage_pickup_date', /garbage.*(pickup|date)/i],
      day: ['garbage_collection_day', /garbage.*day/i],
      freq: ['garbage_collection_frequency', /garbage.*freq/i],
    },
    {
      key: 'recycling', lid: 'yellow', name: 'Recycling',
      date: ['recycling_pickup_date', /recycl.*(pickup|date)/i],
      day: ['recycling_collection_day', /recycl.*day/i],
      freq: ['recycling_collection_frequency', /recycl.*freq/i],
    },
    {
      key: 'green', lid: 'green', name: /fogo/i.test(greenType) ? 'FOGO' : 'Garden waste',
      date: ['next_greenwaste_date', /greenwaste.*date|next_green/i],
      day: ['greenwaste_collection_day', /greenwaste.*day/i],
      freq: ['greenwaste_collection_frequency', /greenwaste.*freq/i],
    },
  ];

  const streams = [];
  for (const def of defs) {
    const raw = pick(row, def.date[0], def.date[1]);
    const parsed = auDateToYmd(raw);
    if (!parsed) continue; // no date published for this stream — say nothing rather than guess

    const freq = pick(row, def.freq[0], def.freq[1]) || '';
    const step = /fortnight/i.test(freq) ? 14 : 7;

    // The dataset is normally kept ahead of today. If it has fallen behind,
    // roll forward on the published frequency and mark it, rather than
    // showing a date that has already passed as if it were next.
    let date = parsed;
    let projected = false;
    let guard = 0;
    while (daysBetween(today, date) < 0 && guard++ < 60) {
      date = addDays(date, step);
      projected = true;
    }

    streams.push({
      key: def.key,
      name: def.name,
      lid: def.lid,
      date,
      publishedDate: parsed,
      projected,
      weekday: weekdayOf(date),
      scheduledDay: pick(row, def.day[0], def.day[1]) || null,
      frequency: freq || null,
      daysUntil: daysBetween(today, date),
    });
  }

  if (!streams.length) throw new Error('no usable collection dates for this suburb');
  streams.sort((a, b) => a.daysUntil - b.daysUntil || a.key.localeCompare(b.key));

  return {
    suburb: String(pick(row, 'suburb', /suburb/i)),
    splitSuburb: pick(row, 'split_suburb', /split/i) || null,
    collectionWeek: pick(row, 'collection_week', /^collection_week/i) || null,
    greenwasteWeek: pick(row, 'greenwaste_collection_week', /greenwaste_collection_week/i) || null,
    greenwasteType: greenType,
    asOf: today,
    streams,
  };
}

/** Open-Meteo forecast. Also supplies the sunrise/sunset the sky gradient uses. */
async function weather() {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', CONFIG.latitude);
  u.searchParams.set('longitude', CONFIG.longitude);
  u.searchParams.set('timezone', TZ);
  u.searchParams.set('forecast_days', '3');
  u.searchParams.set('current', [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
    'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'is_day', 'precipitation',
  ].join(','));
  u.searchParams.set('hourly', ['temperature_2m', 'precipitation_probability'].join(','));
  u.searchParams.set('daily', [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min',
    'precipitation_sum', 'precipitation_probability_max', 'uv_index_max',
    'sunrise', 'sunset', 'wind_speed_10m_max',
  ].join(','));

  const r = await get(u.toString());
  if (!r || !r.current || !r.daily) throw new Error('unexpected forecast shape');

  const days = r.daily.time.map((d, i) => ({
    date: d,
    weekday: weekdayOf(d),
    code: r.daily.weather_code[i],
    max: r.daily.temperature_2m_max[i],
    min: r.daily.temperature_2m_min[i],
    rain: r.daily.precipitation_sum[i],
    rainChance: r.daily.precipitation_probability_max[i],
    uv: r.daily.uv_index_max[i],
    sunrise: r.daily.sunrise[i],
    sunset: r.daily.sunset[i],
    windMax: r.daily.wind_speed_10m_max[i],
  }));

  // Next 12 hours from the current wall-clock hour, in the house's zone.
  const nowHourIso = `${todayYmd()}T${String(partsIn(new Date(), TZ).hour).padStart(2, '0')}:00`;
  let start = r.hourly.time.indexOf(nowHourIso);
  if (start < 0) start = 0;
  const hourly = r.hourly.time.slice(start, start + 12).map((t, i) => ({
    time: t,
    temp: r.hourly.temperature_2m[start + i],
    rainChance: r.hourly.precipitation_probability[start + i],
  }));

  return {
    now: {
      temp: r.current.temperature_2m,
      feelsLike: r.current.apparent_temperature,
      humidity: r.current.relative_humidity_2m,
      code: r.current.weather_code,
      wind: r.current.wind_speed_10m,
      windDir: r.current.wind_direction_10m,
      isDay: !!r.current.is_day,
      precipitation: r.current.precipitation,
      observedAt: r.current.time,
    },
    today: days[0],
    days,
    hourly,
  };
}

function aqiBand(aqi) {
  if (aqi <= 50) return { label: 'Good', tone: 'good' };
  if (aqi <= 100) return { label: 'Moderate', tone: 'ok' };
  if (aqi <= 150) return { label: 'Poor for sensitive groups', tone: 'warn' };
  if (aqi <= 200) return { label: 'Unhealthy', tone: 'bad' };
  if (aqi <= 300) return { label: 'Very unhealthy', tone: 'bad' };
  return { label: 'Hazardous', tone: 'bad' };
}

/** Open-Meteo air quality. Bushfire smoke is the reason this card exists. */
async function air() {
  const u = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
  u.searchParams.set('latitude', CONFIG.latitude);
  u.searchParams.set('longitude', CONFIG.longitude);
  u.searchParams.set('timezone', TZ);
  u.searchParams.set('current', ['pm2_5', 'pm10', 'us_aqi', 'uv_index'].join(','));
  u.searchParams.set('forecast_days', '1');

  const r = await get(u.toString());
  if (!r || !r.current) throw new Error('unexpected air quality shape');

  const aqi = r.current.us_aqi;
  return {
    aqi: aqi == null ? null : Math.round(aqi),
    band: aqi == null ? null : aqiBand(aqi),
    pm25: r.current.pm2_5 ?? null,
    pm10: r.current.pm10 ?? null,
    uv: r.current.uv_index ?? null,
    observedAt: r.current.time,
    scale: 'US AQI',
  };
}

/** National + ACT public holidays. */
async function holidays() {
  const today = todayYmd();
  const y = Number(today.slice(0, 4));
  const [thisYear, nextYear] = await Promise.all([
    get(`https://date.nager.at/api/v3/PublicHolidays/${y}/AU`),
    get(`https://date.nager.at/api/v3/PublicHolidays/${y + 1}/AU`).catch(() => []),
  ]);

  const seen = new Set();
  const all = [...thisYear, ...nextYear]
    .filter((h) => (h.types || ['Public']).includes('Public'))
    .filter((h) => h.global === true || (h.counties || []).includes('AU-ACT'))
    .filter((h) => {
      const k = `${h.date}|${h.localName}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((h) => ({
      date: h.date,
      name: h.localName || h.name,
      weekday: weekdayOf(h.date),
      actOnly: h.global !== true,
      daysUntil: daysBetween(today, h.date),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const upcoming = all.filter((h) => h.daysUntil >= 0);
  if (!upcoming.length) throw new Error('no upcoming holidays returned');

  return {
    asOf: today,
    isTodayHoliday: upcoming[0].daysUntil === 0 ? upcoming[0] : null,
    next: upcoming.find((h) => h.daysUntil > 0) || null,
    upcoming: upcoming.slice(0, 4),
  };
}

/**
 * ACT fire danger rating, total fire ban, and nearby ESA incidents.
 * Returns null when there is genuinely nothing active — the page renders
 * no card at all in that case rather than an empty one.
 */
async function fire() {
  const [ratingXml, incidentXml] = await Promise.all([
    get('https://esa.act.gov.au/feeds/firedangerrating.xml', { as: 'text' }),
    get('https://esa.act.gov.au/feeds/currentincidents.xml', { as: 'text' }).catch(() => ''),
  ]);

  const district = (ratingXml.match(/<District>([\s\S]*?)<\/District>/i) || ['', ''])[1];
  const norm = (v) => (v && !/^no rating$/i.test(v) ? v : null);
  const rating = {
    today: norm(tagText(district, 'DangerLevelToday')),
    tomorrow: norm(tagText(district, 'DangerLevelTomorrow')),
  };
  const ban = {
    today: /^yes$/i.test(tagText(district, 'FireBanToday') || ''),
    tomorrow: /^yes$/i.test(tagText(district, 'FireBanTomorrow') || ''),
  };

  const radius = Number(CONFIG.incidentRadiusKm) || 15;
  const incidents = [];
  for (const block of itemBlocks(incidentXml)) {
    const point = tagText(block, 'georss:point') || tagText(block, 'point');
    if (!point) continue;
    const [lat, lon] = point.split(/\s+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const km = haversineKm(CONFIG.latitude, CONFIG.longitude, lat, lon);
    if (km > radius) continue;

    const desc = tagText(block, 'description') || '';
    const field = (label) => {
      const m = desc.match(new RegExp(label + ':\s*(.+)'));
      return m ? m[1].trim() : null;
    };
    incidents.push({
      title: tagText(block, 'title'),
      type: tagText(block, 'type'),
      agency: tagText(block, 'agency'),
      status: tagText(block, 'resourceStatus') || field('Status'),
      controlStatus: tagText(block, 'controlStatus'),
      suburb: field('Suburb'),
      updated: field('Updated'),
      km: Math.round(km * 10) / 10,
      lat, lon,
    });
  }
  incidents.sort((a, b) => a.km - b.km);

  const elevated = rating.today && !/^(low|moderate)$/i.test(rating.today);
  if (!ban.today && !ban.tomorrow && !elevated && !incidents.length) return null;

  return {
    rating,
    ban,
    incidents: incidents.slice(0, 6),
    incidentCount: incidents.length,
    radiusKm: radius,
    source: 'ACT Emergency Services Agency',
  };
}

const SOURCES = { bins, weather, air, holidays, fire };

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run one source and shape it into the section contract.
 *
 * On failure the previous value is carried forward with its ORIGINAL
 * fetchedAt, so the age rendered on the page is the age of the data rather
 * than the age of the attempt. A source that has never succeeded carries
 * data:null and the page says what went wrong.
 */
async function runSource(name, fn, prev) {
  const before = prev && prev.sections ? prev.sections[name] : null;
  try {
    const data = await fn();
    return { ok: true, fetchedAt: new Date().toISOString(), data };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.error(`  ✗ ${name}: ${message}`);
    return {
      ok: false,
      fetchedAt: before && before.fetchedAt ? before.fetchedAt : new Date().toISOString(),
      error: message,
      data: before && before.data !== undefined ? before.data : null,
      stale: !!(before && before.data),
    };
  }
}

async function inspect() {
  console.log('Raw upstream shapes — nothing is written in this mode.\n');

  console.log('--- ACT kerbside collection: first row');
  try {
    const rows = await get(`${BINS_URL}?$limit=1`);
    console.log(JSON.stringify(rows[0], null, 2));
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }

  console.log(`\n--- rows matching suburb "${CONFIG.suburb}"`);
  try {
    const rows = await get(`${BINS_URL}?$limit=5000`);
    const want = String(CONFIG.suburb || '').trim().toUpperCase();
    const hits = rows.filter((r) => String(r.suburb || '').trim().toUpperCase() === want);
    console.log(`${hits.length} row(s) of ${rows.length}`);
    for (const h of hits) console.log(JSON.stringify(h));
    if (hits.length > 1) {
      console.log(`\n  ! split suburb — set "splitSuburb" in config.json to one of: ` +
        hits.map((h) => h.split_suburb || '(unlabelled)').join(', '));
    }
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }

  for (const [name, fn] of Object.entries(SOURCES)) {
    if (name === 'bins') continue;
    console.log(`\n--- ${name}`);
    try {
      const data = await fn();
      console.log(data === null ? 'null (nothing active — card is not rendered)'
        : JSON.stringify(data, null, 2).slice(0, 1400));
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }
}

async function main() {
  if (process.argv.includes('--inspect')) return inspect();

  const prev = readPrevious();
  console.log(`Collecting for ${CONFIG.suburb} (${TZ}) at ${new Date().toISOString()}`);

  const names = Object.keys(SOURCES);
  const results = await Promise.all(names.map((n) => runSource(n, SOURCES[n], prev)));

  const sections = {};
  names.forEach((n, i) => { sections[n] = results[i]; });

  const out = {
    generatedAt: new Date().toISOString(),
    houseName: CONFIG.houseName || 'Home',
    timezone: TZ,
    suburb: CONFIG.suburb,
    sections,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

  const ok = names.filter((n) => sections[n].ok);
  console.log(`Wrote ${path.relative(ROOT, OUT)} — ${ok.length}/${names.length} sources ok (${ok.join(', ')})`);

  // A partial failure is still a successful run: the page renders stale data
  // rather than nothing, so the workflow must not be marked failed.
  if (!ok.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  partsIn, todayYmd, daysBetween, addDays, weekdayOf, auDateToYmd,
  aqiBand, haversineKm, tagText, itemBlocks, decodeEntities, pick,
  SOURCES,
};
