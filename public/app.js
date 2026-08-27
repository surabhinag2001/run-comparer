(function(){
  "use strict";
  var RUN_TYPES = ['Run', 'TrailRun', 'VirtualRun'];
  function isRunType(sportType){ return RUN_TYPES.indexOf(sportType) !== -1; }

  /* ---------------- tiny DOM helpers ---------------- */
  function applyAttrs(n, attrs){
    if (!attrs) return;
    for (var k in attrs){
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class'){ n.setAttribute('class', v); }
      else if (k === 'style' && typeof v === 'object'){ for (var sk in v){ n.style[sk] = v[sk]; } }
      else if (k.indexOf('on') === 0 && typeof v === 'function'){ n.addEventListener(k.slice(2).toLowerCase(), v); }
      else { n.setAttribute(k, v); }
    }
  }
  function appendKids(n, kids){
    for (var i=0;i<kids.length;i++){
      var k = kids[i];
      if (k == null || k === false) continue;
      if (Array.isArray(k)){ appendKids(n, k); continue; }
      n.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
  }
  function el(tag, attrs){
    var n = document.createElement(tag);
    applyAttrs(n, attrs);
    appendKids(n, Array.prototype.slice.call(arguments, 2));
    return n;
  }
  function svgEl(tag, attrs){
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    applyAttrs(n, attrs);
    appendKids(n, Array.prototype.slice.call(arguments, 2));
    return n;
  }
  function $(id){ return document.getElementById(id); }

  /* ---------------- formatting ---------------- */
  function pad(n){ return String(n).padStart(2,'0'); }
  function fmtKm(m){
    if (m == null || isNaN(m)) return '—';
    var km = m/1000;
    return (km>=10 ? km.toFixed(1) : km.toFixed(2)) + ' km';
  }
  function fmtDuration(s){
    if (s == null || isNaN(s)) return '—';
    s = Math.round(s);
    var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return h>0 ? (h+':'+pad(m)+':'+pad(sec)) : (m+':'+pad(sec));
  }
  function paceMinutesFromSpeed(mps){
    if (!mps || mps<=0) return null;
    return (1000/mps)/60;
  }
  function fmtPaceMin(v){
    if (v == null || !isFinite(v)) return '—';
    var totalSec = Math.round(v*60);
    var m = Math.floor(totalSec/60), s = totalSec%60;
    return m+':'+pad(s);
  }
  function fmtPaceFromSpeed(mps){
    var v = paceMinutesFromSpeed(mps);
    return v==null ? '—' : (fmtPaceMin(v)+' /km');
  }
  function weatherIcon(code){
    if (code === 0) return '☀️';
    if (code === 1 || code === 2) return '⛅';
    if (code === 3) return '☁️';
    if (code === 45 || code === 48) return '🌫️';
    if (code >= 51 && code <= 57) return '🌦️';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️';
    if (code >= 95) return '⛈️';
    return '🌡️';
  }
  function fmtWeather(w){
    if (!w || !w.available) return '—';
    return weatherIcon(w.weather_code) + ' ' + Math.round(w.temperature_c) + '°C · ' + w.description;
  }
  function relDate(iso){
    if (!iso) return 'date unknown';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'date unknown';
    var now = new Date();
    function startOfDay(x){ return new Date(x.getFullYear(), x.getMonth(), x.getDate()); }
    var diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    var opts = d.getFullYear()===now.getFullYear() ? {month:'short', day:'numeric'} : {month:'short', day:'numeric', year:'numeric'};
    return d.toLocaleDateString(undefined, opts);
  }
  function niceStep(range, targetTicks){
    if (!isFinite(range) || range<=0) return 1;
    var rough = range/targetTicks;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough/mag;
    var step = norm<1.5 ? 1 : norm<3 ? 2 : norm<7 ? 5 : 10;
    return step*mag;
  }
  function extractActivityId(raw){
    if (!raw) return null;
    var m = raw.match(/strava\.com\/activities\/(\d+)/i);
    if (m) return m[1];
    var d = raw.trim().match(/^(\d{5,})$/);
    if (d) return d[1];
    return null;
  }
  // Links copied from Strava's own mobile-app share sheet look like
  // strava.app.link/xxxxx (a Branch.io short link) rather than
  // strava.com/activities/<id> — the id isn't in the URL at all, and
  // resolving it requires following a redirect that Branch only serves
  // to browser-like requests, which a client-side fetch can't do
  // (blocked by CORS regardless). See /api/resolve-link.
  var APP_LINK_RE = /^https:\/\/strava\.app\.link\/[A-Za-z0-9_-]+\/?(\?.*)?$/i;

  /* ---------------- state ---------------- */
  function parseShareIdsFromPath(){
    var m = location.pathname.match(/^\/s\/([A-Za-z0-9,]+)\/?$/);
    if (!m) return null;
    return m[1].split(',').map(function(s){ return s.trim(); }).filter(Boolean).slice(0,10);
  }

  // Selection and filters are deliberately in-memory only — a refresh
  // starts clean rather than restoring a prior session's picks, except
  // for the share-link path below, which is a distinct flow (reads the
  // ids straight out of the URL, not out of local state).
  var appState = { selected: [] };
  var initialShareIds = parseShareIdsFromPath();
  var pendingShareIds = initialShareIds;

  // distMax at DIST_SLIDER_MAX means "no upper limit" (so long/ultra runs
  // aren't silently excluded just because they're past the slider's end).
  var DIST_SLIDER_MAX = 50;
  var DIST_PRESETS = [
    { label:'5K', min:4.5, max:5.5 },
    { label:'10K', min:9.5, max:10.5 },
    { label:'Half', min:20.6, max:21.6 },
    { label:'Marathon', min:41.7, max:42.7 }
  ];
  var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var ui = { search:'', manualInput:'', manualLoading:false, monthNum:'', year:'', distMin:0, distMax:DIST_SLIDER_MAX };
  // activities accumulate across pages. Whenever any filter is active, the
  // picker keeps auto-loading further pages until the account's full
  // history is exhausted (not just until the first match appears) — so
  // e.g. selecting "Half" surfaces every half marathon ever run, not just
  // the most recent one. Once exhausted, all activities are cached
  // client-side, so switching filters afterward is instant with no
  // further requests. scanBlocked pauses that auto-loop after a fetch
  // error (distinct from exhausted, which means "reached the real end of
  // history") until the user retries explicitly.
  var recent = { activities:[], error:null, loading:false, page:0, exhausted:false, loadingMore:false, scanBlocked:false };
  var ACTIVITIES_PER_PAGE = 200; // Strava's per_page cap — fewer round trips for a full-history scan
  var auth = { checked:false, authenticated:false, athlete:null };
  var activityCache = new Map();
  var toasts = []; var toastSeq = 0;
  var shareState = { building:false, url:null };

  /* ---------------- toasts ---------------- */
  function showToast(text){
    var id = ++toastSeq;
    toasts.push({id:id, text:text});
    render();
    setTimeout(function(){ toasts = toasts.filter(function(t){ return t.id!==id; }); render(); }, 4200);
  }
  function buildToastStack(){
    if (!toasts.length) return null;
    var stack = el('div',{class:'toast-stack'});
    toasts.forEach(function(t){ stack.appendChild(el('div',{class:'toast'}, t.text)); });
    return stack;
  }

  /* ---------------- api ---------------- */
  function apiError(err){
    if (err && err.error) return err.error;
    return { code:'network_error', message:'Couldn’t reach the server.' };
  }
  async function api(path, opts){
    var res;
    try {
      res = await fetch(path, Object.assign({ headers:{'Content-Type':'application/json'} }, opts||{}));
    } catch(e){
      throw { code:'network_error', message:'Couldn’t reach the server.' };
    }
    var body = null;
    try { body = await res.json(); } catch(e){}
    if (!res.ok) throw apiError(body);
    return body;
  }

  function errorNote(err){
    var text = (err && err.message) || 'Something went wrong.';
    var critical = err && (err.code==='needs_reauth' || err.code==='not_connected');
    return el('div',{class:'error-note'+(critical?' crit':'')}, el('div', null, text));
  }
  function loadingRow(text){
    return el('div',{class:'empty-note', style:{display:'flex', alignItems:'center', gap:'8px'}}, el('span',{class:'spinner'}), text);
  }

  /* ---------------- run selection ---------------- */
  function addActivity(activity){
    var id = String(activity.id);
    if (appState.selected.some(function(r){ return String(r.id)===id; })) return;
    if (appState.selected.length >= 10){ showToast('You can compare up to 10 runs at a time.'); return; }
    appState.selected = appState.selected.concat([{
      id: id,
      name: activity.name || ('Activity ' + id),
      sport_type: activity.sport_type || 'Run',
      start_local: activity.start_local || null,
      summary: activity.summary || {}
    }]);
    shareState.url = null;
    syncActivityCache();
    render();
  }
  function removeActivity(id){
    id = String(id);
    appState.selected = appState.selected.filter(function(r){ return String(r.id)!==id; });
    shareState.url = null;
    syncActivityCache();
    render();
  }
  async function addByManualInput(){
    var raw = ui.manualInput.trim();
    var id = extractActivityId(raw);
    if (!id && !APP_LINK_RE.test(raw)){
      showToast('Enter a valid Strava activity link or ID.');
      return;
    }
    if (!auth.authenticated){ showToast('Connect Strava first.'); return; }
    ui.manualLoading = true; render();
    try {
      if (!id){
        var resolved = await api('/api/resolve-link?url=' + encodeURIComponent(raw));
        id = resolved.id;
      }
      if (appState.selected.some(function(r){ return String(r.id)===id; })){
        showToast('That run is already added.');
        return;
      }
      var found = await api('/api/activities/' + encodeURIComponent(id));
      if (!isRunType(found.sport_type)){
        showToast('That’s a ' + found.sport_type + ', not a run — this tool only compares runs.');
        return;
      }
      addActivity(found);
      ui.manualInput = '';
    } catch(e){
      if (e.code === 'forbidden'){
        showToast('That activity isn’t visible to your connected Strava account — it needs to be yours (or shared with you).');
      } else if (!id){
        showToast('Couldn’t resolve that share link — try the strava.com/activities/... link instead.');
      } else {
        showToast('Couldn’t find that activity — check the link or ID.');
      }
    } finally {
      ui.manualLoading = false; render();
    }
  }

  /* ---------------- data fetching ---------------- */
  function ensureLiveEntry(id){
    id = String(id);
    if (activityCache.has(id)) return activityCache.get(id);
    var entry = {
      streamsLoading:true, streams:null, streamsErr:null,
      perfLoading:true, perf:null, perfErr:null,
      weatherLoading:true, weather:null, weatherErr:null
    };
    activityCache.set(id, entry);
    api('/api/activities/' + encodeURIComponent(id) + '/streams').then(function(streams){
      entry.streams = streams; entry.streamsErr = null;
    }).catch(function(e){
      entry.streamsErr = e;
    }).finally(function(){ entry.streamsLoading = false; render(); });
    api('/api/activities/' + encodeURIComponent(id) + '/performance').then(function(perf){
      entry.perf = perf; entry.perfErr = null;
    }).catch(function(e){
      entry.perfErr = e;
    }).finally(function(){ entry.perfLoading = false; render(); });
    api('/api/activities/' + encodeURIComponent(id) + '/weather').then(function(weather){
      entry.weather = weather; entry.weatherErr = null;
    }).catch(function(e){
      entry.weatherErr = e;
    }).finally(function(){ entry.weatherLoading = false; render(); });
    return entry;
  }
  function syncActivityCache(){
    var wantIds = {};
    appState.selected.forEach(function(r){ if (!r.snapshotId) wantIds[String(r.id)] = true; });
    activityCache.forEach(function(entry, id){ if (!wantIds[id]) activityCache.delete(id); });
    appState.selected.forEach(function(r){
      if (r.snapshotId) return; // data already resolved, came from a snapshot
      ensureLiveEntry(r.id);
    });
  }

  async function loadShareIds(ids){
    try {
      var res = await api('/api/snapshots?ids=' + ids.map(encodeURIComponent).join(','));
      var byId = {}; (res.snapshots||[]).forEach(function(s){ byId[s.id] = s; });
      var resolved = ids.map(function(id){ return byId[id]; }).filter(Boolean);
      if (!resolved.length){
        showToast('That shared comparison link doesn’t exist (or was mistyped).');
        return;
      }
      if (resolved.length < ids.length){
        showToast('One or more runs in this shared link couldn’t be found.');
      }
      appState.selected = resolved.map(function(s){
        return {
          id: s.activity_id, name: s.name, sport_type: s.sport_type, start_local: s.start_local,
          summary: s.summary, snapshotId: s.id
        };
      });
      resolved.forEach(function(s){
        activityCache.set(String(s.activity_id), { streamsLoading:false, streams:s.streams, streamsErr:null, perfLoading:false, perf:s.perf, perfErr:null });
      });
      render();
    } catch(e){
      showToast('Couldn’t load that shared comparison.');
    }
  }

  async function buildShareLink(){
    if (appState.selected.length < 2) return;
    shareState.building = true; render();
    try {
      var ids = [];
      for (var i=0;i<appState.selected.length;i++){
        var r = appState.selected[i];
        if (r.snapshotId){ ids.push(r.snapshotId); continue; }
        if (!auth.authenticated){ showToast('Connect Strava to share your own runs.'); shareState.building=false; render(); return; }
        var entry = activityCache.get(String(r.id));
        if (!entry || !entry.streams || entry.streamsErr){ showToast('Still loading ' + r.name + ' — try again in a moment.'); shareState.building=false; render(); return; }
        var res = await api('/api/snapshots', { method:'POST', body: JSON.stringify({
          activity_id: r.id, name: r.name, sport_type: r.sport_type, start_local: r.start_local,
          summary: r.summary, perf: entry.perf, streams: entry.streams
        })});
        r.snapshotId = res.id;
        ids.push(res.id);
      }
      shareState.url = location.origin + '/s/' + ids.join(',');
    } catch(e){
      showToast((e && e.message) || 'Couldn’t create a share link.');
    } finally {
      shareState.building = false; render();
    }
  }
  function copyShareLink(){
    if (!shareState.url) return;
    navigator.clipboard && navigator.clipboard.writeText(shareState.url).then(function(){
      showToast('Link copied.');
    }).catch(function(){ showToast('Couldn’t copy automatically — select and copy the link manually.'); });
  }

  /* ---------------- auth ---------------- */
  async function loadRecent(){
    recent.loading = true; render();
    try {
      var res = await api('/api/activities?per_page=' + ACTIVITIES_PER_PAGE);
      recent.activities = res.activities || [];
      recent.page = 1;
      recent.exhausted = !res.has_more;
      recent.error = null;
    } catch(e){
      recent.error = e;
    } finally {
      recent.loading = false; render();
    }
  }
  // Background page loads (the auto-scan-while-filtering chain, and the
  // manual "Load older runs" button) refresh only the .activity-list node
  // in place rather than the global render(). Two reasons: (1) this can
  // fire from *inside* an in-progress render() call (buildPickerCard
  // triggers the first scan step synchronously while building the list),
  // and calling the global render() reentrantly there clears root and
  // appends a second whole shell before the outer call reaches its own
  // root.appendChild — producing duplicated DOM. (2) even outside that,
  // rebuilding the whole page on a background fetch tears down the
  // search/month/year/slider controls, snapping shut any native <select>
  // dropdown the user has open at that exact moment.
  function refreshListInPlace(){
    var list = document.querySelector('.activity-list');
    if (list) renderActivityList(list);
  }
  async function loadMoreActivities(){
    if (recent.loadingMore || recent.exhausted) return;
    recent.loadingMore = true; recent.scanBlocked = false; refreshListInPlace();
    try {
      var res = await api('/api/activities?per_page=' + ACTIVITIES_PER_PAGE + '&page=' + (recent.page + 1));
      var got = res.activities || [];
      recent.activities = recent.activities.concat(got);
      recent.page = recent.page + 1;
      recent.exhausted = !res.has_more || got.length === 0;
      recent.error = null;
    } catch(e){
      // A fetch failure isn't the same as reaching the real end of
      // history — pause the auto-loop (scanBlocked) rather than marking
      // exhausted, so a "Retry" can pick back up instead of the picker
      // silently believing it already checked everything.
      recent.error = e;
      recent.scanBlocked = true;
    } finally {
      recent.loadingMore = false; refreshListInPlace();
    }
  }
  async function init(){
    render();
    try {
      var me = await api('/api/me');
      auth.authenticated = !!me.authenticated;
      auth.athlete = me.athlete || null;
    } catch(e){
      auth.authenticated = false;
    }
    auth.checked = true;
    render();
    if (auth.authenticated) loadRecent();
    if (pendingShareIds){
      await loadShareIds(pendingShareIds);
      pendingShareIds = null;
    } else {
      syncActivityCache();
    }
    var params = new URLSearchParams(location.search);
    var authErr = params.get('auth_error');
    if (authErr){
      showToast('Connecting to Strava didn’t work (' + authErr + '). Try again.');
      history.replaceState(null, '', location.pathname);
    }
  }
  function logout(){
    api('/auth/logout', { method:'POST' }).catch(function(){}).finally(function(){
      window.location.href = '/';
    });
  }

  /* ---------------- chart data (unchanged logic from the original app) ---------------- */
  function pointsForKind(kind, r){
    var s = r.streams;
    if (!s) return [];
    var dist = s.distance, alt = s.altitude, hr = s.heart_rate, vel = s.velocity_smooth;
    var pts = [], n, i;
    if (kind==='elevation'){
      if (!dist || !alt) return [];
      n = Math.min(dist.length, alt.length);
      for (i=0;i<n;i++) pts.push({x:dist[i]/1000, y:alt[i]});
      return pts;
    }
    if (kind==='hr'){
      if (!dist || !hr) return [];
      n = Math.min(dist.length, hr.length);
      for (i=0;i<n;i++) if (hr[i]>0) pts.push({x:dist[i]/1000, y:hr[i]});
      return pts;
    }
    if (!dist || !vel) return [];
    n = Math.min(dist.length, vel.length);
    for (i=0;i<n;i++){
      if (vel[i] > 0.4){
        var paceMin = (1000/vel[i])/60;
        if (paceMin < 20) pts.push({x:dist[i]/1000, y:paceMin});
      }
    }
    return pts;
  }
  function hasHr(r){ return pointsForKind('hr', r).length>0; }

  function interpAtDistance(dist, time, target){
    var n = dist.length;
    if (target <= dist[0]) return time[0];
    if (target >= dist[n-1]) return time[n-1];
    for (var i=1;i<n;i++){
      if (dist[i] >= target){
        var d0=dist[i-1], d1=dist[i], t0=time[i-1], t1=time[i];
        var frac = d1>d0 ? (target-d0)/(d1-d0) : 0;
        return t0 + frac*(t1-t0);
      }
    }
    return time[n-1];
  }
  function computeSplits(r, stepM){
    var s = r.streams;
    if (!s || !s.distance || !s.time || !s.distance.length) return [];
    var dist = s.distance, rawTime = s.time, hr = s.heart_rate, movingFlags = s.moving;
    var n = dist.length;

    var usesMovingTime = !!(movingFlags && movingFlags.length === n);
    var time;
    if (usesMovingTime){
      time = new Array(n);
      time[0] = rawTime[0] - rawTime[0];
      for (var idx=1; idx<n; idx++){
        var dt = rawTime[idx] - rawTime[idx-1];
        var moved = movingFlags[idx];
        time[idx] = time[idx-1] + (moved ? dt : 0);
      }
    } else {
      time = rawTime;
    }

    var total = dist[n-1];
    var splits = [];
    var segStartDist = 0, segStartTime = time[0];
    var boundary = stepM;
    while (segStartDist < total - 1e-6){
      var endDist = Math.min(boundary, total);
      var segDist = endDist - segStartDist;
      if (segDist < 30 && splits.length>0) break;
      var endTime = interpAtDistance(dist, time, endDist);
      var hrSum=0, hrCount=0;
      if (hr){
        for (var k=0;k<n;k++){
          if (dist[k] >= segStartDist-0.001 && dist[k] <= endDist+0.001 && hr[k]>0){ hrSum+=hr[k]; hrCount++; }
        }
      }
      var segTime = endTime - segStartTime;
      splits.push({
        index: splits.length+1,
        distanceM: segDist,
        partial: (stepM - segDist) > 1,
        paceMin: segDist>0 ? (segTime/60)/(segDist/1000) : null,
        avgHr: hrCount ? (hrSum/hrCount) : null
      });
      segStartDist = endDist;
      segStartTime = endTime;
      boundary += stepM;
      if (splits.length > 100) break;
    }
    splits.usesMovingTime = usesMovingTime;
    return splits;
  }

  function buildSeriesForKind(kind, runs){
    var all=[], series=[], errors=[], pending=0;
    runs.forEach(function(r){
      var color = 'var(--s' + (r.colorSlot%8) + ')';
      if (r.streamsErr){
        errors.push(r.streamsErr);
        all.push({label:r.name, color:color, disabled:true});
        return;
      }
      if (r.streamsLoading || !r.streams){
        pending++;
        all.push({label:r.name, color:color, disabled:true});
        return;
      }
      var pts = pointsForKind(kind, r);
      if (!pts.length){
        all.push({label:r.name, color:color, disabled:true});
        return;
      }
      all.push({label:r.name, color:color, disabled:false});
      series.push({id:r.id, label:r.name, color:color, points:pts});
    });
    var yFmt, emptyMessage;
    if (kind==='pace'){ yFmt = fmtPaceMin; emptyMessage = 'No pace data available for these runs yet.'; }
    else if (kind==='elevation'){ yFmt = function(v){ return Math.round(v)+' m'; }; emptyMessage = 'No elevation data available for these runs yet.'; }
    else { yFmt = function(v){ return Math.round(v)+' bpm'; }; emptyMessage = 'None of these runs have heart-rate data recorded.'; }
    var notes = [];
    if (pending>0) notes.push('Loading ' + pending + ' more run' + (pending>1?'s':'') + '…');
    if (kind==='hr'){
      var missing = runs.filter(function(r){ return r.streams && !r.streamsErr && !hasHr(r); }).map(function(r){ return r.name; });
      if (missing.length) notes.push('No heart-rate data for: ' + missing.join(', ') + '.');
    }
    return { all:all, series:series, errors:errors, pending:pending, yFmt:yFmt, emptyMessage:emptyMessage, notes:notes,
      loading: series.length===0 && pending>0 && errors.length===0 };
  }

  /* ---------------- svg line chart ---------------- */
  function lineChartSvg(opts){
    var series = opts.series, yInvert = !!opts.yInvert, yFmt = opts.yFmt || function(v){ return String(Math.round(v*100)/100); };
    var width=960, height=280;
    var marginLeft=54, marginRight=18, marginTop=14, marginBottom=34;
    var plotW = width-marginLeft-marginRight, plotH = height-marginTop-marginBottom;
    var allX=[], allY=[];
    series.forEach(function(s){ s.points.forEach(function(p){ allX.push(p.x); allY.push(p.y); }); });
    var xMax = allX.length ? Math.max.apply(null, allX) : 1; if (xMax<=0) xMax=1;
    var xMin = 0;
    var yMin = allY.length ? Math.min.apply(null, allY) : 0;
    var yMaxV = allY.length ? Math.max.apply(null, allY) : 1;
    if (yMin===yMaxV){ yMin -= 1; yMaxV += 1; }
    var padY = (yMaxV-yMin)*0.12 || 1;
    yMin -= padY; yMaxV += padY;

    function xScale(x){ return marginLeft + (xMax>xMin ? (x-xMin)/(xMax-xMin) : 0) * plotW; }
    function yScale(y){
      return yInvert
        ? marginTop + (y-yMin)/(yMaxV-yMin) * plotH
        : marginTop + plotH - (y-yMin)/(yMaxV-yMin) * plotH;
    }

    var svgNode = svgEl('svg', {class:'chart-svg', viewBox:'0 0 '+width+' '+height, role:'img', 'aria-label':'Comparison chart'});

    var grid = svgEl('g',{class:'grid'});
    var yStep = niceStep(yMaxV-yMin, 4);
    var g0 = Math.ceil(yMin/yStep)*yStep;
    for (var v=g0; v<=yMaxV; v+=yStep){
      var gy = yScale(v);
      grid.appendChild(svgEl('line',{x1:marginLeft, x2:width-marginRight, y1:gy, y2:gy, stroke:'var(--grid)', 'stroke-width':1}));
      grid.appendChild(svgEl('text',{x:marginLeft-8, y:gy+4, 'text-anchor':'end', class:'axis-label'}, yFmt(v)));
    }
    svgNode.appendChild(grid);

    var xAxis = svgEl('g',{class:'x-axis'});
    var xDecimals = xMax>=10 ? 0 : 1;
    var xTicksN = 5;
    for (var i=0;i<=xTicksN;i++){
      var xv = xMin + (xMax-xMin)*i/xTicksN;
      var sx = xScale(xv);
      var anchor = i===0 ? 'start' : (i===xTicksN ? 'end' : 'middle');
      xAxis.appendChild(svgEl('text',{x:sx, y:height-10, 'text-anchor':anchor, class:'axis-label'}, xv.toFixed(xDecimals)+' km'));
    }
    svgNode.appendChild(xAxis);
    svgNode.appendChild(svgEl('line',{x1:marginLeft, x2:width-marginRight, y1:marginTop+plotH, y2:marginTop+plotH, stroke:'var(--axis)', 'stroke-width':1}));

    var seriesLayer = svgEl('g',{class:'series-layer'});
    series.forEach(function(s){
      if (!s.points.length) return;
      var d = s.points.map(function(p,idx){ return (idx===0?'M':'L') + xScale(p.x).toFixed(2)+','+yScale(p.y).toFixed(2); }).join(' ');
      seriesLayer.appendChild(svgEl('path',{d:d, fill:'none', stroke:s.color, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round'}));
      var last = s.points[s.points.length-1];
      var lx=xScale(last.x), ly=yScale(last.y);
      seriesLayer.appendChild(svgEl('circle',{cx:lx, cy:ly, r:6, fill:'var(--surface)'}));
      seriesLayer.appendChild(svgEl('circle',{cx:lx, cy:ly, r:4, fill:s.color}));
    });
    svgNode.appendChild(seriesLayer);

    var crosshair = svgEl('line',{class:'crosshair', x1:marginLeft, x2:marginLeft, y1:marginTop, y2:marginTop+plotH, stroke:'var(--axis)', 'stroke-width':1, opacity:0});
    svgNode.appendChild(crosshair);
    var hoverDots = svgEl('g',{class:'hover-dots'});
    svgNode.appendChild(hoverDots);
    var hitRect = svgEl('rect',{class:'hit-rect', x:marginLeft, y:marginTop, width:plotW, height:plotH, fill:'transparent'});
    svgNode.appendChild(hitRect);

    return { svgNode:svgNode, xScale:xScale, yScale:yScale, marginLeft:marginLeft, marginRight:marginRight,
      marginTop:marginTop, plotH:plotH, width:width, height:height, xMin:xMin, xMax:xMax, series:series,
      crosshair:crosshair, hoverDots:hoverDots, hitRect:hitRect };
  }

  function attachHover(container, built, yFmt){
    var tooltip = el('div',{class:'tooltip'});
    container.appendChild(tooltip);
    function move(evt){
      var rect = built.svgNode.getBoundingClientRect();
      if (!rect.width) return;
      var scaleX = built.width / rect.width;
      var clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      var clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
      var svgX = (clientX - rect.left) * scaleX;
      svgX = Math.min(Math.max(svgX, built.marginLeft), built.width-built.marginRight);
      var dataX = built.xMin + (svgX-built.marginLeft)/(built.width-built.marginLeft-built.marginRight)*(built.xMax-built.xMin);

      built.crosshair.setAttribute('x1', svgX); built.crosshair.setAttribute('x2', svgX); built.crosshair.setAttribute('opacity','1');
      built.hoverDots.innerHTML = '';
      tooltip.innerHTML = '';
      var xDecimals = built.xMax>=10 ? 1 : 2;
      tooltip.appendChild(el('div',{class:'tooltip-x'}, dataX.toFixed(xDecimals)+' km'));
      built.series.forEach(function(s){
        if (!s.points.length) return;
        var nearest=s.points[0], bd=Math.abs(s.points[0].x-dataX);
        s.points.forEach(function(p){ var d=Math.abs(p.x-dataX); if (d<bd){ bd=d; nearest=p; } });
        var cx=built.xScale(nearest.x), cy=built.yScale(nearest.y);
        built.hoverDots.appendChild(svgEl('circle',{cx:cx, cy:cy, r:5.5, fill:'var(--surface)'}));
        built.hoverDots.appendChild(svgEl('circle',{cx:cx, cy:cy, r:3.5, fill:s.color}));
        tooltip.appendChild(el('div',{class:'tooltip-row'},
          el('span',{class:'tooltip-key', style:{background:s.color}}),
          el('span',{class:'tooltip-name'}, s.label),
          el('span',{class:'tooltip-val'}, yFmt ? yFmt(nearest.y) : String(Math.round(nearest.y*10)/10))
        ));
      });
      var cRect = container.getBoundingClientRect();
      var px = clientX-cRect.left, py = clientY-cRect.top;
      var left = px+14, top = py-10;
      var ttW=210, ttH=32+built.series.length*20;
      if (left+ttW>cRect.width) left = px-ttW-14;
      if (left<0) left=4;
      if (top+ttH>cRect.height) top = cRect.height-ttH-4;
      if (top<0) top=4;
      tooltip.style.left=left+'px'; tooltip.style.top=top+'px';
      tooltip.style.opacity='1'; tooltip.style.transform='translate(0,0)';
    }
    function leave(){
      built.crosshair.setAttribute('opacity','0');
      built.hoverDots.innerHTML = '';
      tooltip.style.opacity='0';
      tooltip.style.transform='translate(-9999px,-9999px)';
    }
    built.hitRect.addEventListener('pointermove', move);
    built.hitRect.addEventListener('pointerdown', move);
    built.hitRect.addEventListener('pointerleave', leave);
  }

  /* ---------------- stat table ---------------- */
  function buildStatsCard(runs){
    var card = el('div',{class:'card'});
    card.appendChild(el('div',{class:'chart-head'}, el('h2',{class:'chart-title'},'Overview'), el('div',{class:'chart-sub'}, runs.length+' runs')));
    var wrap = el('div',{class:'table-scroll'});
    var table = el('table',{class:'stat-table'});
    var thead = el('thead');
    var headRow = el('tr', null, el('th', null, 'Metric'));
    runs.forEach(function(r){
      headRow.appendChild(el('th', null, el('div',{class:'th-run'},
        el('div',{class:'run-label'}, el('span',{class:'swatch', style:{background:'var(--s'+(r.colorSlot%8)+')'}}), r.name),
        el('div',{class:'run-date'}, relDate(r.start_local))
      )));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    var rowsDef = [
      {label:'Distance', get:function(r){ return r.summary.distance; }, fmt:fmtKm},
      {label:'Moving time', get:function(r){ return r.summary.moving_time; }, fmt:fmtDuration},
      {label:'Avg pace', get:function(r){ return paceMinutesFromSpeed(r.summary.avg_speed); }, fmt:fmtPaceMin, lower:true, highlight:true},
      {label:'Elevation gain', get:function(r){ return r.summary.elevation_gain; }, fmt:function(v){ return v==null?'—':Math.round(v)+' m'; }},
      {label:'Avg heart rate', get:function(r){ return (r.perf && r.perf.average_heartrate) || null; }, fmt:function(v){ return v?Math.round(v)+' bpm':'—'; }},
      {label:'Max heart rate', get:function(r){ return (r.perf && r.perf.max_heartrate) || null; }, fmt:function(v){ return v?Math.round(v)+' bpm':'—'; }},
      {label:'Calories', get:function(r){ return (r.perf && r.perf.calories) || r.summary.total_calories || null; }, fmt:function(v){ return v?Math.round(v):'—'; }},
      {label:'Relative effort', get:function(r){ return (r.summary.relative_effort!=null) ? r.summary.relative_effort : null; }, fmt:function(v){ return v!=null?v:'—'; }},
      {label:'Weather', get:function(r){ return r.weather || null; }, fmt:fmtWeather}
    ];
    rowsDef.forEach(function(def){
      var vals = runs.map(def.get);
      var numeric = vals.filter(function(v){ return typeof v==='number' && !isNaN(v); });
      var best = (def.highlight && numeric.length>1) ? (def.lower ? Math.min.apply(null,numeric) : Math.max.apply(null,numeric)) : null;
      var tr = el('tr', null, el('td', null, def.label));
      vals.forEach(function(v){
        var isBest = best!=null && typeof v==='number' && v===best;
        tr.appendChild(el('td',{class: isBest ? 'best-cell' : null}, def.fmt(v)));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  /* ---------------- splits table ---------------- */
  function buildSplitsCard(runs){
    var card = el('div',{class:'card'});
    card.appendChild(el('div',{class:'chart-head'}, el('h2',{class:'chart-title'},'Splits'), el('div',{class:'chart-sub'},'Pace (excluding stopped time) and average heart rate per kilometer.')));

    var pending = runs.filter(function(r){ return r.streamsLoading; }).length;
    var errored = runs.filter(function(r){ return r.streamsErr; });
    var splitsByRun = runs.map(function(r){ return { r:r, splits: (r.streams && !r.streamsErr) ? computeSplits(r, 1000) : [] }; });
    var maxSplits = splitsByRun.reduce(function(m,x){ return Math.max(m, x.splits.length); }, 0);

    if (maxSplits===0){
      if (pending>0){ card.appendChild(loadingRow('Loading splits…')); }
      else {
        card.appendChild(el('div',{class:'empty-note'}, 'No split data available for these runs yet.'));
        errored.forEach(function(r){ card.appendChild(errorNote(r.streamsErr)); });
      }
      return card;
    }

    var wrap = el('div',{class:'table-scroll'});
    var table = el('table',{class:'stat-table splits-table'});
    var thead = el('thead');
    var headRow = el('tr', null, el('th', null, 'Split'));
    runs.forEach(function(r){
      headRow.appendChild(el('th', null, el('div',{class:'th-run'},
        el('div',{class:'run-label'}, el('span',{class:'swatch', style:{background:'var(--s'+(r.colorSlot%8)+')'}}), r.name)
      )));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    var anyPartialAtAll = false;
    for (var i=0;i<maxSplits;i++){
      var rowPaces = splitsByRun.map(function(x){ return x.splits[i] ? x.splits[i].paceMin : null; });
      var numericPaces = rowPaces.filter(function(v){ return typeof v==='number' && v!=null; });
      var bestPace = numericPaces.length>1 ? Math.min.apply(null, numericPaces) : null;
      var tr = el('tr', null, el('td', null, 'Km '+(i+1)));
      splitsByRun.forEach(function(x){
        var sp = x.splits[i];
        if (!sp){ tr.appendChild(el('td', null, '—')); return; }
        if (sp.partial) anyPartialAtAll = true;
        var isBest = bestPace!=null && sp.paceMin===bestPace;
        tr.appendChild(el('td', null, el('div',{class:'split-cell'},
          el('span',{class:'split-pace'+(isBest?' best':'')}, fmtPaceMin(sp.paceMin)+(sp.partial?' *':'')),
          el('span',{class:'split-hr'}, sp.avgHr ? Math.round(sp.avgHr)+' bpm' : '—')
        )));
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    if (anyPartialAtAll) card.appendChild(el('div',{class:'chart-note'}, '* partial split.'));
    var noMovingData = splitsByRun.filter(function(x){ return x.splits.length && !x.splits.usesMovingTime; }).map(function(x){ return x.r.name; });
    if (noMovingData.length) card.appendChild(el('div',{class:'chart-note'}, 'Includes stopped time for: ' + noMovingData.join(', ') + ' (no moving-time data recorded).'));
    if (pending>0) card.appendChild(el('div',{class:'chart-note'}, 'Loading '+pending+' more run'+(pending>1?'s':'')+'…'));
    errored.forEach(function(r){ card.appendChild(errorNote(r.streamsErr)); });
    return card;
  }

  /* ---------------- chart card ---------------- */
  function buildChartCard(title, sub, kind, runs){
    var card = el('div',{class:'card chart-card'});
    card.appendChild(el('div',{class:'chart-head'}, el('h2',{class:'chart-title'},title), el('div',{class:'chart-sub'}, sub)));
    var info = buildSeriesForKind(kind, runs);

    var legend = el('div',{class:'legend'});
    info.all.forEach(function(s){
      legend.appendChild(el('div',{class:'legend-item'+(s.disabled?' muted':'')},
        el('span',{class:'legend-key', style:{background:s.color}}),
        el('span', null, s.label)
      ));
    });
    card.appendChild(legend);

    var chartWrap = el('div',{class:'chart-wrap'});
    if (info.loading){
      chartWrap.appendChild(loadingRow('Loading '+title.toLowerCase()+'…'));
    } else if (info.series.length){
      var built = lineChartSvg({series:info.series, yInvert: kind==='pace', yFmt: info.yFmt});
      chartWrap.appendChild(built.svgNode);
      attachHover(chartWrap, built, info.yFmt);
    } else {
      chartWrap.appendChild(el('div',{class:'empty-note'}, info.emptyMessage));
    }
    card.appendChild(chartWrap);
    info.notes.forEach(function(n){ card.appendChild(el('div',{class:'chart-note'}, n)); });
    info.errors.forEach(function(e){ card.appendChild(errorNote(e)); });
    return card;
  }

  /* ---------------- rail: picker & selection ---------------- */
  function activityRow(a){
    var already = appState.selected.some(function(r){ return String(r.id)===String(a.id); });
    var pace = fmtPaceFromSpeed(a.summary ? a.summary.avg_speed : null);
    return el('div',{class:'activity-row'},
      el('div',{class:'activity-main'},
        el('div',{class:'activity-name'}, a.name || ('Activity '+a.id)),
        el('div',{class:'activity-meta'}, relDate(a.start_local)+' · '+fmtKm(a.summary?a.summary.distance:null)+' · '+pace)
      ),
      el('button',{class:'add-btn'+(already?' add-btn-active':''), type:'button', title: already?'Remove from comparison':'Add to comparison', onclick:function(){ already ? removeActivity(a.id) : addActivity(a); }}, already?'✓':'+')
    );
  }
  function distanceFilterActive(){ return ui.distMin > 0 || ui.distMax < DIST_SLIDER_MAX; }
  function monthFilterActive(){ return !!ui.monthNum || !!ui.year; }
  function filtersActive(){ return !!ui.search || monthFilterActive() || distanceFilterActive(); }
  function distLabel(minV, maxV){
    var maxTxt = maxV >= DIST_SLIDER_MAX ? (DIST_SLIDER_MAX.toFixed(0) + '+ km') : (maxV.toFixed(1) + ' km');
    return minV.toFixed(1) + ' km – ' + maxTxt;
  }
  function passesMonth(a){
    if (!monthFilterActive()) return true;
    if (!a.start_local) return false;
    if (ui.year && a.start_local.slice(0,4) !== ui.year) return false;
    if (ui.monthNum && a.start_local.slice(5,7) !== ui.monthNum) return false;
    return true;
  }
  function passesDistance(a){
    if (!distanceFilterActive()) return true;
    var km = (a.summary && a.summary.distance != null) ? a.summary.distance/1000 : null;
    if (km == null) return false;
    if (km < ui.distMin - 1e-9) return false;
    if (ui.distMax < DIST_SLIDER_MAX && km > ui.distMax + 1e-9) return false;
    return true;
  }
  // Builds (or refreshes) just the activity list into an existing
  // container node — used both for the initial build inside
  // buildPickerCard() and for scoped background refreshes via
  // refreshListInPlace(), which must never touch sibling DOM (the
  // search/month/year/slider controls) or call the global render().
  //
  // Reentrancy guard: kicking off a scan step below can synchronously
  // reach loadMoreActivities() -> refreshListInPlace() -> back into this
  // same function on the same list node (once it's already attached to
  // the document, which is true for every scan iteration after the
  // first). Without this guard, that nested call appends its own note
  // and the outer call — oblivious that list already got a fresh child —
  // appends a second one right after, producing the duplicated
  // "searching further back" rows. The outer (already in-progress) call
  // always finishes and reflects the latest state correctly, so the
  // nested attempt is safe to just skip.
  var listRenderBusy = false;
  function renderActivityList(list){
    if (listRenderBusy) return;
    listRenderBusy = true;
    try {
      renderActivityListInner(list);
    } finally {
      listRenderBusy = false;
    }
  }
  function renderActivityListInner(list){
    list.innerHTML = '';
    if (recent.error) list.appendChild(errorNote(recent.error));
    if (recent.activities.length || !recent.loading){
      var runs = recent.activities.filter(function(a){ return isRunType(a.sport_type); });
      var filtered = runs.filter(function(a){
        if (ui.search && a.name && a.name.toLowerCase().indexOf(ui.search.toLowerCase())===-1) return false;
        if (!passesMonth(a)) return false;
        if (!passesDistance(a)) return false;
        return true;
      });
      var active = filtersActive();
      // Whenever a filter is active, keep loading further pages until the
      // account's real history is exhausted — not just until the first
      // match turns up — so e.g. selecting "Half" surfaces every half
      // marathon ever run, not just the most recent one. Once exhausted,
      // everything is cached in recent.activities, so later filter
      // changes are instant with no further requests.
      if (active && !recent.exhausted && !recent.loadingMore && !recent.scanBlocked){
        loadMoreActivities();
      }
      if (!filtered.length){
        if (active && recent.loadingMore){
          list.appendChild(el('div',{class:'empty-note scan-spinner-row'}, el('span',{class:'spinner'})));
        } else {
          var note = !active ? 'No runs found in your recent activities.'
            : recent.scanBlocked ? 'Couldn’t reach Strava while searching further back.'
            : recent.exhausted ? 'No runs match these filters anywhere in your Strava history.'
            : 'No runs match these filters in your last ' + recent.activities.length + ' activities.';
          list.appendChild(el('div',{class:'empty-note'}, note));
        }
      }
      filtered.slice(0,80).forEach(function(a){ list.appendChild(activityRow(a)); });
      if (active && filtered.length){
        if (recent.loadingMore){
          list.appendChild(el('div',{class:'scan-status-row'}, el('span',{class:'spinner'}), 'Still searching your full history for more matches…'));
        } else if (recent.exhausted){
          list.appendChild(el('div',{class:'scan-status-row'}, 'Found ' + filtered.length + (filtered.length===1?' match':' matches') + ' across your full Strava history.'));
        }
      }
      if (recent.scanBlocked){
        list.appendChild(el('button',{class:'btn', type:'button', onclick:function(){
          recent.scanBlocked = false; recent.error = null; loadMoreActivities();
        }}, 'Retry'));
      }
      if (!active && !recent.exhausted){
        list.appendChild(el('button',{class:'btn load-more-btn', type:'button', disabled:recent.loadingMore, onclick:loadMoreActivities},
          recent.loadingMore ? el('span',{class:'spinner'}) : 'Load older runs'));
      }
    } else {
      list.appendChild(loadingRow('Loading your recent runs…'));
    }
  }
  function buildPickerCard(){
    var card = el('div',{class:'card'});
    card.appendChild(el('div',{class:'card-title'}, 'Add a run'));

    if (!auth.authenticated){
      card.appendChild(el('div',{class:'empty-note'}, 'Connect Strava to browse and add your own runs.'));
      return card;
    }

    var searchRow = el('div',{class:'search-row'},
      el('input',{class:'text-input', id:'search-input', type:'search', placeholder:'Search your recent runs', value:ui.search, oninput:function(e){
        var pos = e.target.selectionStart;
        ui.search = e.target.value;
        render();
        var again = $('search-input');
        if (again){ again.focus(); try{ again.setSelectionRange(pos,pos); }catch(err){} }
      }})
    );
    card.appendChild(searchRow);

    var thisYear = new Date().getFullYear();
    var monthSelect = el('select',{class:'select-input', onchange:function(e){ ui.monthNum = e.target.value; render(); }},
      el('option',{value:''}, 'Month'),
      MONTH_NAMES.map(function(name, idx){
        var val = pad(idx+1);
        return el('option',{value:val, selected: ui.monthNum===val}, name);
      })
    );
    var yearSelect = el('select',{class:'select-input', onchange:function(e){ ui.year = e.target.value; render(); }},
      el('option',{value:''}, 'Year'),
      Array.from({length:21}, function(_, i){ return String(thisYear - i); }).map(function(y){
        return el('option',{value:y, selected: ui.year===y}, y);
      })
    );
    var distLabelEl = el('span',{class:'dist-label'}, distLabel(ui.distMin, ui.distMax));
    var minSlider = el('input',{class:'range-min', type:'range', min:0, max:DIST_SLIDER_MAX, step:0.5, value:ui.distMin,
      oninput:function(e){
        var v = Math.min(parseFloat(e.target.value), ui.distMax);
        e.target.value = v;
        distLabelEl.textContent = distLabel(v, ui.distMax);
      },
      onchange:function(e){ ui.distMin = Math.min(parseFloat(e.target.value), ui.distMax); render(); }
    });
    var maxSlider = el('input',{class:'range-max', type:'range', min:0, max:DIST_SLIDER_MAX, step:0.5, value:ui.distMax,
      oninput:function(e){
        var v = Math.max(parseFloat(e.target.value), ui.distMin);
        e.target.value = v;
        distLabelEl.textContent = distLabel(ui.distMin, v);
      },
      onchange:function(e){ ui.distMax = Math.max(parseFloat(e.target.value), ui.distMin); render(); }
    });
    var presetsRow = el('div',{class:'dist-presets'},
      DIST_PRESETS.map(function(p){
        var active = Math.abs(ui.distMin-p.min)<1e-9 && Math.abs(ui.distMax-p.max)<1e-9;
        return el('button',{class:'chip'+(active?' chip-active':''), type:'button', onclick:function(){
          ui.distMin = p.min; ui.distMax = p.max; render();
        }}, p.label);
      })
    );
    var clearBtn = el('button',{class:'chip chip-sm', type:'button', disabled: !(monthFilterActive() || distanceFilterActive()), onclick:function(){
      ui.monthNum = ''; ui.year = ''; ui.distMin = 0; ui.distMax = DIST_SLIDER_MAX; render();
    }}, 'Clear');
    var filtersRow = el('div',{class:'filters-row'},
      el('div',{class:'filters-header'},
        el('span',{class:'filter-label'}, 'Filters'),
        clearBtn
      ),
      el('div',{class:'filter-group'},
        el('label',{class:'filter-label'}, 'Month'),
        el('div',{class:'month-year-row'},
          el('div',{class:'select-wrap'}, monthSelect),
          el('div',{class:'select-wrap'}, yearSelect)
        )
      ),
      el('div',{class:'filter-group filter-group-dist'},
        el('label',{class:'filter-label'}, 'Distance', distLabelEl),
        presetsRow,
        el('div',{class:'dual-range'}, minSlider, maxSlider)
      )
    );
    card.appendChild(filtersRow);

    var list = el('div',{class:'activity-list'});
    card.appendChild(list);
    renderActivityList(list);

    var manualRow = el('div',{class:'manual-add'},
      el('input',{class:'text-input', id:'manual-input', type:'text', placeholder:'Or paste a Strava activity link / ID (yours)', value:ui.manualInput, oninput:function(e){
        var pos = e.target.selectionStart;
        ui.manualInput = e.target.value;
        var again = $('manual-input');
        if (again){ again.focus(); try{ again.setSelectionRange(pos,pos); }catch(err){} }
      }, onkeydown:function(e){ if (e.key==='Enter'){ e.preventDefault(); addByManualInput(); } }}),
      el('button',{class:'btn', disabled:ui.manualLoading, onclick:addByManualInput}, ui.manualLoading ? el('span',{class:'spinner'}) : 'Add')
    );
    card.appendChild(manualRow);
    return card;
  }
  function buildSelectionCard(){
    var card = el('div',{class:'card'});
    card.appendChild(el('div',{class:'card-title'}, 'Comparing ('+appState.selected.length+')'));
    if (!appState.selected.length){
      card.appendChild(el('div',{class:'empty-note'}, 'Add two or more runs to start comparing.'));
      return card;
    }
    var list = el('div',{class:'selection-list'});
    appState.selected.forEach(function(r, idx){
      list.appendChild(el('div',{class:'selection-chip'},
        el('span',{class:'swatch', style:{background:'var(--s'+(idx%8)+')'}}),
        el('div',{class:'selection-main'},
          el('div',{class:'selection-name'}, r.name),
          el('div',{class:'selection-meta'}, relDate(r.start_local)+' · '+fmtKm(r.summary.distance)+(r.snapshotId?' · shared':''))
        ),
        el('button',{class:'remove-btn', type:'button', title:'Remove', onclick:function(){ removeActivity(r.id); }}, '×')
      ));
    });
    card.appendChild(list);
    if (appState.selected.length >= 2){
      card.appendChild(el('div',{class:'share-row'},
        el('button',{class:'btn btn-primary', disabled:shareState.building, onclick:buildShareLink},
          shareState.building ? el('span',{class:'spinner'}) : 'Share this comparison')
      ));
      if (shareState.url){
        card.appendChild(el('div',{class:'share-box'},
          el('p', null, 'Anyone with this link can see this comparison — they don’t need Strava or an account to view it.'),
          el('div',{class:'share-link-row'},
            el('input',{class:'share-link-input', readonly:true, value:shareState.url, onclick:function(e){ e.target.select(); }}),
            el('button',{class:'btn', onclick:copyShareLink}, 'Copy')
          )
        ));
      }
    }
    return card;
  }

  /* ---------------- main area ---------------- */
  function buildConnectState(){
    return el('div',{class:'connect-state'},
      el('h2', null, 'Connect your Strava to get started'),
      el('p', null, 'Log in with your own Strava account to pick runs and compare them. Nothing is posted back to Strava, and only you can see your own data unless you choose to share a comparison link.'),
      el('a',{class:'strava-btn', href:'/auth/strava/login'}, 'Connect with Strava')
    );
  }
  function buildEmptyState(){
    var n = appState.selected.length;
    var card = el('div',{class:'empty-state'});
    card.appendChild(el('h2', null, n===1 ? 'Add one more run' : 'Pick two or more runs'));
    card.appendChild(el('p', null, n===1
      ? 'You’ve got one — add at least one more from the list on the left to see a comparison.'
      : 'Choose runs from the list on the left, or paste a Strava activity link, to compare pace, elevation, and heart rate.'));
    return card;
  }
  function buildMain(){
    var main = el('div',{class:'main'});
    if (appState.selected.length < 2){
      if (!auth.checked){ main.appendChild(loadingRow('Loading…')); return main; }
      if (!auth.authenticated && !appState.selected.length){ main.appendChild(buildConnectState()); return main; }
      main.appendChild(buildEmptyState());
      return main;
    }
    var runs = appState.selected.map(function(r, idx){
      var entry = (r.snapshotId ? activityCache.get(String(r.id)) : activityCache.get(String(r.id))) || {};
      var merged = { colorSlot: idx };
      for (var k in r) merged[k]=r[k];
      for (var k2 in entry) merged[k2]=entry[k2];
      return merged;
    });
    main.appendChild(buildStatsCard(runs));
    main.appendChild(buildSplitsCard(runs));
    main.appendChild(buildChartCard('Pace', 'Minutes per kilometer over distance — faster sits higher.', 'pace', runs));
    main.appendChild(buildChartCard('Elevation', 'Altitude over distance.', 'elevation', runs));
    main.appendChild(buildChartCard('Heart rate', 'Beats per minute over distance.', 'hr', runs));
    return main;
  }

  /* ---------------- header ---------------- */
  function buildHeaderActions(){
    var wrap = el('div',{class:'header-actions'});
    if (!auth.checked){
      wrap.appendChild(el('div',{class:'status-pill'}, el('span',{class:'status-dot'}), 'Loading…'));
      return wrap;
    }
    if (auth.authenticated){
      var name = (auth.athlete && auth.athlete.first_name) ? auth.athlete.first_name : 'athlete';
      wrap.appendChild(el('div',{class:'status-pill'}, el('span',{class:'status-dot ok'}), 'Connected as ' + name));
      wrap.appendChild(el('button',{class:'btn btn-ghost', onclick:logout}, 'Log out'));
    } else {
      wrap.appendChild(el('a',{class:'strava-btn', href:'/auth/strava/login'}, 'Connect with Strava'));
    }
    return wrap;
  }
  function buildHeader(){
    var header = el('div',{class:'header'});
    var brand = el('div',{class:'brand'});
    brand.appendChild(el('h1', null, 'Run Comparer 🐢 🐰'));
    var sub = 'Compare two or more runs from Strava — pace, splits, elevation, and heart rate side by side.';
    if (auth.authenticated && auth.athlete && auth.athlete.first_name){
      sub = 'Hi ' + auth.athlete.first_name + ' — pick any two or more runs below to line them up.';
    } else if (pendingShareIds === null && appState.selected.length && !auth.authenticated){
      sub = 'Viewing a shared comparison. Connect your own Strava to add a run of your own.';
    }
    brand.appendChild(el('p', null, sub));
    header.appendChild(brand);
    header.appendChild(buildHeaderActions());
    return header;
  }

  /* ---------------- render ---------------- */
  function render(){
    var prevList = document.querySelector('.activity-list');
    var scrollTop = prevList ? prevList.scrollTop : 0;
    var root = $('root');
    root.innerHTML = '';
    var shell = el('div',{class:'shell'});
    shell.appendChild(buildHeader());
    var layout = el('div',{class:'layout'});
    var rail = el('div',{class:'rail'});
    rail.appendChild(buildPickerCard());
    rail.appendChild(buildSelectionCard());
    layout.appendChild(rail);
    layout.appendChild(buildMain());
    shell.appendChild(layout);
    root.appendChild(shell);
    var toastStack = buildToastStack();
    if (toastStack) root.appendChild(toastStack);
    var newList = document.querySelector('.activity-list');
    if (newList) newList.scrollTop = scrollTop;
  }

  init();
})();
