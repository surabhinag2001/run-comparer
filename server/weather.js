// Historical weather for a run's start location/time, via Open-Meteo's
// free Archive API (no key required: https://open-meteo.com). Strava's
// own API doesn't expose real weather conditions — only an optional
// average_temp field that's only present when the recording device has
// a temperature sensor, which is inconsistent enough to not be useful on
// its own (same sparse-data situation as heart rate).
//
// Coordinates are only ever used here, server-side, to make the lookup —
// never returned to the client or stored anywhere, since a run's start
// point can reveal where someone lives.
const WEATHER_CODE_DESCRIPTIONS = {
  0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle',
  56: 'Light freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Light freezing rain', 67: 'Heavy freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Severe thunderstorm with hail'
};

export function describeWeatherCode(code) {
  return WEATHER_CODE_DESCRIPTIONS[code] || 'Unknown conditions';
}

// Returns null (rather than throwing) for anything that just means "no
// weather to show" — missing/invalid coordinates, a date outside the
// archive's coverage, no matching hour — so callers can treat "no data"
// uniformly without needing to distinguish every reason.
export async function getHistoricalWeather({ lat, lon, startDateUtc }) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const d = new Date(startDateUtc);
  if (isNaN(d.getTime())) return null;

  const iso = d.toISOString(); // e.g. 2026-08-24T08:15:00.000Z
  const date = iso.slice(0, 10);
  const targetHour = iso.slice(0, 13) + ':00';

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${date}&end_date=${date}` +
    `&hourly=temperature_2m,precipitation,wind_speed_10m,weather_code&timezone=UTC`;

  const res = await fetch(url);
  if (!res.ok) return null;
  const body = await res.json();
  const hourly = body.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return null;

  const idx = hourly.time.indexOf(targetHour);
  if (idx === -1) return null;

  const code = hourly.weather_code[idx];
  return {
    temperature_c: hourly.temperature_2m[idx],
    precipitation_mm: hourly.precipitation[idx],
    wind_speed_kmh: hourly.wind_speed_10m[idx],
    weather_code: code,
    description: describeWeatherCode(code)
  };
}
