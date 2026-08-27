// Canned data used only when MOCK_STRAVA=1 (local testing without real
// Strava OAuth credentials). Mirrors the *raw* Strava API response shapes
// so it exercises the same normalization code real traffic would.
function genRawStream(opts){
  var n = opts.n || 120;
  var distTotal = opts.distTotal;
  var baseHr = opts.baseHr;
  var stopAtFrac = opts.stopAtFrac == null ? null : opts.stopAtFrac;
  var stopSeconds = opts.stopSeconds || 90;
  var time=[], distance=[], altitude=[], heartrate=[], velocity_smooth=[], moving=[];
  var elapsed = 0, stopInserted = false;
  for (var i=0;i<n;i++){
    var frac = i/(n-1);
    var d = Math.round(distTotal*frac*10)/10;
    var stepTime = (distTotal/3)/(n-1);
    if (stopAtFrac!=null && !stopInserted && frac>=stopAtFrac){
      var holdDist = distance.length ? distance[distance.length-1] : 0;
      var stopSamples = 8;
      for (var ss=0; ss<stopSamples; ss++){
        elapsed += stopSeconds/stopSamples;
        time.push(Math.round(elapsed));
        distance.push(holdDist);
        altitude.push(80);
        heartrate.push(Math.round(baseHr*0.85));
        velocity_smooth.push(0);
        moving.push(false);
      }
      stopInserted = true;
    }
    elapsed += stepTime;
    time.push(Math.round(elapsed));
    distance.push(d);
    altitude.push(Math.round((80 + Math.sin(frac*10)*15 + frac*5)*10)/10);
    heartrate.push(Math.round(baseHr + Math.sin(frac*6)*8 + frac*10));
    velocity_smooth.push(Math.round((2.6 + Math.sin(frac*8)*0.3)*1000)/1000);
    moving.push(true);
  }
  return {
    time: { data: time }, distance: { data: distance }, altitude: { data: altitude },
    heartrate: { data: heartrate }, velocity_smooth: { data: velocity_smooth }, moving: { data: moving }
  };
}

export const MOCK_ATHLETE = { id: 999001, firstname: 'Test', lastname: 'Runner' };

export const MOCK_ACTIVITIES = [
  // start_latlng + start_date (UTC) are present here so MOCK_STRAVA=1
  // can still exercise a real weather lookup — that call goes to
  // Open-Meteo, a separate free/no-key service, not to Strava, so mocking
  // Strava doesn't need to mock it too.
  { id: 700000001, name: 'Sunday long run', sport_type: 'Run', start_date_local: '2026-08-24T08:00:00Z',
    start_date: '2026-08-24T08:00:00Z', start_latlng: [43.6532, -79.3832],
    distance: 12030, moving_time: 3600, elapsed_time: 3780, total_elevation_gain: 88,
    average_speed: 3.34, max_speed: 4.1, calories: 720, suffer_score: 61,
    average_heartrate: 148, max_heartrate: 171, has_heartrate: true },
  { id: 700000002, name: 'Tempo intervals', sport_type: 'Run', start_date_local: '2026-08-20T18:15:00Z',
    start_date: '2026-08-20T18:15:00Z', start_latlng: [51.5072, -0.1276],
    distance: 8050, moving_time: 2100, elapsed_time: 2160, total_elevation_gain: 30,
    average_speed: 3.83, max_speed: 5.2, calories: 540, suffer_score: 78,
    average_heartrate: 162, max_heartrate: 181, has_heartrate: true },
  { id: 700000003, name: 'Evening walk', sport_type: 'Walk', start_date_local: '2026-08-19T20:00:00Z',
    distance: 2500, moving_time: 1800, elapsed_time: 1900, total_elevation_gain: 5,
    average_speed: 1.39, max_speed: 2.0, calories: 120, suffer_score: 3 },
  // Older run, deliberately far enough back to land on a later page —
  // used to exercise the "search reaches into older history" picker flow.
  // No start_latlng, on purpose: exercises the "no location data" path.
  { id: 700000004, name: 'Spring 10k race', sport_type: 'Run', start_date_local: '2026-05-10T09:00:00Z',
    distance: 10210, moving_time: 2820, elapsed_time: 2850, total_elevation_gain: 45,
    average_speed: 3.62, max_speed: 4.6, calories: 610, suffer_score: 70,
    average_heartrate: 167, max_heartrate: 184, has_heartrate: true },
  // Second ~10K run, further back still — with the two of them spread
  // across different pages, this exercises "don't stop scanning after
  // the first distance-filter match, keep going for every match".
  { id: 700000005, name: 'Winter 10k tempo', sport_type: 'Run', start_date_local: '2025-12-02T07:30:00Z',
    distance: 9870, moving_time: 2760, elapsed_time: 2790, total_elevation_gain: 25,
    average_speed: 3.58, max_speed: 4.4, calories: 590, suffer_score: 65,
    average_heartrate: 160, max_heartrate: 179, has_heartrate: true }
];

const STREAMS_BY_ID = {
  700000001: genRawStream({ n: 200, distTotal: 12030, baseHr: 148, stopAtFrac: 0.3, stopSeconds: 100 }),
  700000002: genRawStream({ n: 150, distTotal: 8050, baseHr: 162 }),
  700000004: genRawStream({ n: 170, distTotal: 10210, baseHr: 167 })
};

export function mockGetActivity(id){
  const a = MOCK_ACTIVITIES.find(x => String(x.id) === String(id));
  if (!a) { const e = new Error('not found'); e.status = 404; throw e; }
  return { ...a, laps: [] };
}

export function mockGetStreams(id){
  const s = STREAMS_BY_ID[String(id)] || STREAMS_BY_ID[id];
  if (!s) { const e = new Error('not found'); e.status = 404; throw e; }
  return s;
}
