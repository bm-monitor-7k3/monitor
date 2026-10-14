// Stock check on the phone: the PC dashboard's check (dip-buy, trend and breakout rules) redone here from the
// daily candles each bot run saves (app-markets.json on the branch app-data), with a live price from Finnhub
// (US stocks, crypto) or an estimate from a matching US fund (indices, metals, oil). Read-only.
let MK = null, MKload = null, SQ = '', SCUR = null;
const SBOX = document.createElement('div');
const f2 = n => n == null ? '–' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 5 : 2 });
const fhKey = () => store.get('fhkey', '');

async function loadMarkets(force) {
  if (MKload && !force) return MKload;
  MKload = (async () => {
    try {
      const r = await gh('/contents/app-markets.json?ref=app-data', { headers: { 'Accept': 'application/vnd.github.raw+json' } });
      if (r.status === 404) throw new Error('no stock data yet: it appears after the next bot run');
      if (!r.ok) throw new Error('GitHub said ' + r.status);
      MK = await r.json();
      try { const c = await caches.open('markets'); await c.put('markets', new Response(JSON.stringify(MK))); } catch (e) {}
    } catch (e) {
      if (!MK) { try { const c = await caches.open('markets'); const x = await c.match('markets'); if (x) MK = await x.json(); } catch (_) {} }
      if (!MK) { MKload = null; throw e; }
    }
    return MK;
  })();
  return MKload;
}

async function liveQuote(m) {
  const k = fhKey(), sym = m.fh || m.proxy;
  if (!k || !sym) return null;
  const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + encodeURIComponent(k));
  if (r.status === 401 || r.status === 403) throw new Error('Finnhub rejected the key (' + r.status + ')');
  if (r.status === 429) throw new Error('Finnhub limit reached: try again in a minute');
  if (!r.ok) throw new Error('Finnhub said ' + r.status);
  const q = await r.json();
  return q && q.c > 0 ? q : null;
}

// --- the same maths as the bots (strategy.js) ---
function rsiLast(v, p) {
  if (v.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i] - v[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  for (let i = p + 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atrLast(c, p) {
  if (c.length < p + 1) return null;
  const tr = i => Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  let a = 0;
  for (let i = 1; i <= p; i++) a += tr(i);
  a /= p;
  for (let i = p + 1; i < c.length; i++) a = (a * (p - 1) + tr(i)) / p;
  return a;
}
const dayOf = (ms, crypto) => crypto ? Math.floor(ms / 864e5) : Date.parse(new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })) / 864e5;

// completed daily candles + today's (forming) candle at the best price we have
function priceRows(m, q) {
  const rows = m.d.map(r => ({ ts: r[0] * 864e5, high: r[1], low: r[2], close: r[3] }));
  let forming = m.f ? { ts: m.f.t * 864e5, high: m.f.h, low: m.f.l, close: m.px } : null;
  let px = m.px, src = 'price at the last bot run', at = Date.parse(MK.at), live = false;
  const crypto = m.kind === 'Crypto';
  if (q && q.t * 1000 > at) {
    const qt = q.t * 1000;
    if (m.proxy) {
      if (m.proxyAt) { px = m.px * q.c / m.proxyAt; src = 'estimate: last bot-run price moved like ' + m.proxy + ' (live fund price)'; at = qt; live = true; }
      if (forming) forming = { ...forming, close: px, high: Math.max(forming.high, px), low: Math.min(forming.low, px) };
    } else {
      const qd = dayOf(qt, crypto), hi = crypto ? Math.max(q.c, q.o || q.c) : (q.h || q.c), lo = crypto ? Math.min(q.c, q.o || q.c) : (q.l || q.c);
      if (forming && qd === forming.ts / 864e5) forming = { ...forming, close: q.c, high: Math.max(forming.high, q.c, crypto ? 0 : hi), low: Math.min(forming.low, q.c, crypto ? Infinity : lo) };
      else if (qd > (forming ? forming.ts : rows.at(-1).ts) / 864e5) {
        if (forming) rows.push({ ...forming, close: q.pc || forming.close });
        forming = { ts: qd * 864e5, high: hi, low: lo, close: q.c };
      }
      px = q.c; src = 'live price (Finnhub)'; at = qt; live = true;
    }
  }
  return { rows, forming, px, src, at, live, q };
}

function checkMarket(m, q) {
  const eurusd = MK.eurusd, cv = m.cv || 1;
  const P = priceRows(m, q), px = P.px, done = P.rows, rows = P.forming ? done.concat([P.forming]) : done.slice();
  const forming = !!P.forming;
  const toUSD = v => v == null ? null : v * cv, toEUR = v => v == null || !eurusd ? null : v * cv / eurusd;
  const c = rows.map(r => r.close), n = c.length;
  const sma = k => c.length >= k ? c.slice(-k).reduce((a, b) => a + b, 0) / k : null;
  const ema = (seed, k) => {
    const o = Array(n).fill(null); if (!seed) return o;
    const a = 2 / (k + 1); let e = seed[1];
    if (seed[0] < 0) { for (let i = 0; i < n; i++) { e = c[i] * a + e * (1 - a); o[i] = e; } }
    else { o[seed[0]] = e; for (let i = seed[0] + 1; i < n; i++) { e = c[i] * a + e * (1 - a); o[i] = e; } }
    return o;
  };
  const e50 = ema(m.e50, 50), e200 = ema(m.e200, 200);
  const sma200 = sma(200), sma5 = sma(5), atr = atrLast(rows, 14), atrPct = atr ? atr / px * 100 : null;
  const rsi2 = rsiLast(c, 2);
  // the close that would give RSI(2) < 10 today: Wilder averages up to yesterday, then solve for today's drop
  const dc = done.map(r => r.close); let g = 0, l = 0;
  for (let i = 1; i <= 2 && i < dc.length; i++) { const d = dc[i] - dc[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= 2; l /= 2;
  for (let i = 3; i < dc.length; i++) { const d = dc[i] - dc[i - 1]; g = (g + Math.max(d, 0)) / 2; l = (l + Math.max(-d, 0)) / 2; }
  const dipClose = dc.at(-1) - Math.max(0, 9 * g - l);
  const dn = forming ? done : done.slice(); // completed days (like the PC)
  const high55 = Math.max(...dn.slice(-56, -1).map(r => r.high)), low20 = Math.min(...dn.slice(-21, -1).map(r => r.low));
  const yr = rows.slice(-252), hi52 = Math.max(...yr.map(r => r.high)), lo52 = Math.min(...yr.map(r => r.low));
  const chg = k => n > k ? (px / c[n - 1 - k] - 1) * 100 : null;
  let crossDays = null; if (e200[n - 1] != null) { const up = e50[n - 1] > e200[n - 1]; for (let i = n - 2; i >= 0 && e200[i] != null; i--) if ((e50[i] > e200[i]) !== up) { crossDays = n - 1 - i; break; } }
  const isStock = m.kind === 'Stocks', isCrypto = m.kind === 'Crypto';
  const r4 = v => v == null ? null : Number(v.toFixed(4));
  const lv = (label, v, note) => ({ label, local: r4(v), usd: r4(toUSD(v)), eur: r4(toEUR(v)), note });
  const rules = [];
  {
    const up = sma200 != null && px > sma200, sharp = rsi2 != null && rsi2 < 10, moves = !isStock || (atrPct || 0) >= 2.5;
    const r = { key: 'dip', name: 'Dip-buy swing (our bots A, B, D)', levels: [] };
    if (isCrypto) { r.status = 'NOT FOR CRYPTO'; r.tone = 'mute'; r.text = 'Dip-buying crypto lost money in our tests (the broker charges 1% to buy and 1% to sell). For coins, use the trend rules below (bots E and C).'; }
    else if (sma200 == null) { r.status = 'NO DATA'; r.tone = 'mute'; r.text = 'Needs 200 days of history.'; }
    else if (!up) { r.status = 'NO BUY'; r.tone = 'bad'; r.text = 'Downtrend: the price is below its 200-day average. The rule only buys dips in uptrends.'; r.levels.push(lv('Back in an uptrend above (200-day average)', sma200)); }
    else if (sharp && moves) {
      r.status = 'BUY SIGNAL'; r.tone = 'good';
      r.text = 'Sharp dip in an uptrend (RSI(2) ' + rsi2.toFixed(0) + '). The bots place a buy order 0.5 × the normal daily move below the price, valid until tomorrow’s close, and sell on the first daily close above the 5-day average or after 10 trading days.';
      r.levels.push(lv('Buy if it dips to (limit)', px - 0.5 * atr, (0.5 * atr / px * 100).toFixed(1) + '% below the price: limit order, valid until tomorrow’s close'), lv('Stop-loss', px - 3.5 * atr, (3.5 * atr / px * 100).toFixed(1) + '% below the price'), lv('Sell on a daily close above (5-day average, today)', sma5, 'moves every day'));
    } else if (sharp && !moves) { r.status = 'SKIP'; r.tone = 'warn'; r.text = 'Dip signal, but the stock moves only ' + atrPct.toFixed(1) + '% a day: too calm for the bounce to beat trading costs (the bots need 2.5%+).'; }
    else { r.status = 'WAIT'; r.tone = 'mute'; r.text = 'Uptrend, but no sharp dip yet (RSI(2) ' + rsi2.toFixed(0) + ', needs below 10).' + (moves ? '' : ' It also moves only ' + atrPct.toFixed(1) + '% a day, under the bots’ 2.5% minimum.'); r.levels.push(lv('Dip signal if today closes below', dipClose)); }
    r.tested = m.tested ? null : 'Tested on US-listed stocks, US indices and gold; this market wasn’t in the tests.';
    rules.push(r);
  }
  if (e200[n - 1] != null) {
    const up = e50[n - 1] > e200[n - 1];
    rules.push({ key: 'trend', name: 'Trend: 50-day vs 200-day average' + (isCrypto ? ' (our bot E)' : ''), status: up ? 'UPTREND' : 'DOWNTREND', tone: up ? 'good' : 'bad',
      text: (up ? 'The 50-day average is above the 200-day (golden cross).' : 'The 50-day average is below the 200-day (death cross).') + (crossDays != null ? ' Changed ' + crossDays + ' trading days ago.' : '') + (isCrypto ? (up ? ' Bot E holds coins in this state.' : ' Bot E stays out.') : ' Slow signal: for the big picture, not timing.'),
      levels: [lv('50-day average', e50[n - 1]), lv('200-day average', e200[n - 1])], tested: isCrypto ? null : 'Tested as a trading rule on crypto; for stocks it’s context only.' });
  }
  {
    const brk = px > high55, broke = px < low20;
    rules.push({ key: 'breakout', name: 'Breakout: 55-day high / 20-day low' + (isCrypto ? ' (our bot C)' : ''), status: brk ? 'BREAKOUT' : broke ? 'BREAKDOWN' : 'INSIDE RANGE', tone: brk ? 'good' : broke ? 'bad' : 'mute',
      text: brk ? 'Above its highest price of the last 55 days: a new uptrend move.' : broke ? 'Below its lowest price of the last 20 days: trend followers sell here.' : 'Between its 55-day high and 20-day low.',
      levels: [lv('Buy signal above (55-day high)', high55), lv('Sell signal below (20-day low)', low20)], tested: isCrypto ? null : 'Tested as a trading rule on crypto (lost money on stocks after costs); context only.' });
  }
  const earnDays = m.earn ? Math.round((Date.parse(m.earn) - Date.parse(new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }))) / 864e5) : null;
  const trendR = rules.find(r => r.key === 'trend'), brkR = rules.find(r => r.key === 'breakout');
  const verdict = isCrypto
    ? (trendR && trendR.status === 'UPTREND'
      ? { text: 'Uptrend: bot E would hold it' + (brkR.status === 'BREAKOUT' ? ', and it’s breaking out: bot C would buy' : brkR.status === 'BREAKDOWN' ? ', but it broke its 20-day low: bot C would sell' : ''), tone: brkR.status === 'BREAKDOWN' ? 'warn' : 'good' }
      : { text: 'Downtrend: bot E stays out' + (brkR.status === 'BREAKOUT' ? ', though it’s breaking out: bot C would buy' : ''), tone: brkR.status === 'BREAKOUT' ? 'warn' : 'bad' })
    : rules[0].status === 'BUY SIGNAL' ? (earnDays != null && earnDays >= 0 && earnDays <= 14 ? { text: 'Dip-buy signal, but earnings within 14 days: the bots would skip it', tone: 'warn' } : { text: 'Dip-buy signal today', tone: 'good' })
    : rules[0].status === 'NO BUY' ? { text: 'Downtrend: no buy by our rules', tone: 'bad' } : rules[0].status === 'SKIP' ? { text: 'Too calm for our dip-buy rule', tone: 'warn' } : { text: 'No signal now: wait', tone: 'mute' };
  const prevClose = forming ? done.at(-1).close : done.at(-2) && done.at(-2).close;
  return {
    market: m, P, rules, verdict,
    price: { ...lv('Price', px), eurusd, forming, lastClose: done.at(-1) ? new Date(done.at(-1).ts).toISOString().slice(0, 10) : null, dayChangePct: prevClose ? (px / prevClose - 1) * 100 : null, spreadPct: m.bid && m.ask ? (m.ask - m.bid) / m.px * 100 : null },
    stats: { rsi2, atrPct, chg1m: chg(21), chg3m: chg(63), chg1y: chg(252), hi52: lv('52-week high', hi52), lo52: lv('52-week low', lo52) },
    earnings: m.earn ? { date: m.earn, days: earnDays } : null,
    chart: rows.slice(-130).map((r, i, arr) => { const k = n - arr.length + i; return { t: r.ts, c: r.close, e50: e50[k], s200: k >= 199 ? c.slice(k - 199, k + 1).reduce((a, b) => a + b, 0) / 200 : null }; }),
  };
}

// --- page ---
function twoCur(l) { if (!l) return '–'; return '<b>' + (l.usd == null ? '–' : '$' + f2(l.usd)) + '</b> <span class="mute">' + (l.eur == null ? '–' : '€' + f2(l.eur)) + '</span>'; }
function findMarkets(q) {
  const s = q.trim().toLowerCase(); if (!s || !MK) return [];
  const score = m => { const keys = [m.name, m.sym].concat(m.alias || []).map(x => String(x).toLowerCase());
    return keys.some(k => k === s) ? 0 : keys.some(k => k.startsWith(s)) ? 1 : keys.some(k => k.includes(s)) ? 2 : 9; };
  return MK.markets.map(m => [score(m), m]).filter(x => x[0] < 9).sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, 8).map(x => x[1]);
}
function mountStock() {
  if (!SBOX.innerHTML) {
    SBOX.className = 'card';
    SBOX.innerHTML = '<h2>Stock check <span id="sage"></span></h2><form id="sform" class="pad" style="display:flex;gap:8px;padding-bottom:10px"><input id="sq" type="search" placeholder="Symbol or name, e.g. NVDA, Apple, Gold, Bitcoin" autocomplete="off" aria-label="Symbol or name"><button class="btn primary" type="submit">Check</button></form><div id="smatch" class="cands"></div><div id="sres"></div>';
    SBOX.querySelector('#sform').onsubmit = e => { e.preventDefault(); const q = $('sq').value.trim(); if (!q) return; const f = findMarkets(q); if (f.length) stockOpen(f[0]); else noMatch(q); };
    SBOX.querySelector('#sq').oninput = () => showMatches($('sq').value);
    SBOX.querySelector('#smatch').onclick = e => { const b = e.target.closest('[data-mid]'); if (b) { const m = MK.markets.find(x => String(x.id) === b.dataset.mid); if (m) stockOpen(m); } };
    SBOX.querySelector('#sres').onclick = e => { const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'watch') tradeDispatch('watch|' + cleanv(b.dataset.q), 'Added to the list');
      if (b.dataset.act === 'unwatch') tradeDispatch('unwatch|' + b.dataset.id, 'Removed from the list');
      if (b.dataset.act === 'again' && SCUR) stockOpen(SCUR); };
  }
  const home = $('home'); if (home.firstChild !== SBOX) home.prepend(SBOX);
  liveFixed();
  loadMarkets().then(() => { $('sage').textContent = 'data ' + ago(MK.at) + ' · ' + MK.markets.length + ' markets'; if (SCUR) { const m = MK.markets.find(x => x.id === SCUR.id); if (m && m !== SCUR) stockOpen(m, true); } })
    .catch(e => { $('sage').textContent = ''; if (!$('sres').innerHTML) $('sres').innerHTML = '<div class="empty">Stock check: ' + esc(e.message) + '</div>'; });
}
function showMatches(q) {
  const f = findMarkets(q), box = $('smatch');
  box.innerHTML = q.trim() && f.length && !(f.length === 1 && SCUR === f[0]) ? f.map(m => '<button type="button" data-mid="' + m.id + '">' + esc(m.sym) + ' <span class="mute">' + esc(m.name) + '</span></button>').join('') : '';
}
function noMatch(q) {
  $('smatch').innerHTML = '';
  $('sres').innerHTML = '<div class="empty">' + (MK ? '“' + esc(q) + '” isn’t in the phone list (' + MK.markets.length + ' markets: the bots’ markets, your trades and the ones you added).' : 'Stock data not loaded yet.') + '</div>' +
    (MK ? '<div class="pad" style="padding-top:0;text-align:center"><button class="btn" data-act="watch" data-q="' + esc(q) + '">+ Add “' + esc(q) + '” to the list</button><div class="mute" style="font-size:12px;margin-top:6px">Looked up by the next bot run: it shows here after about 3 minutes.</div></div>' : '');
}
async function stockOpen(m, quiet) {
  SCUR = m; $('smatch').innerHTML = ''; $('sq').value = m.name;
  const res = $('sres');
  if (!quiet) res.innerHTML = '<div class="empty">Checking ' + esc(m.name) + '…</div>';
  let q = null, qerr = '';
  try { q = await liveQuote(m); } catch (e) { qerr = e.message; }
  if (SCUR !== m) return;
  let d; try { d = checkMarket(m, q); } catch (e) { res.innerHTML = '<div class="empty">Could not check: ' + esc(e.message) + '</div>'; return; }
  renderStock(d, qerr);
}
function renderStock(d, qerr) {
  const m = d.market, p = d.price, s = d.stats, P = d.P, res = $('sres');
  const pc = v => v == null ? '–' : '<span class="' + (v > 0 ? 'good' : v < 0 ? 'bad' : 'mute') + '">' + (v > 0 ? '+' : '') + v.toFixed(1) + '%</span>';
  // where the price comes from, and why (shown under the price)
  const when = t => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const botRun = '<b>Price from the last bot run</b> (' + esc(when(P.at)) + ', ' + esc(ago(P.at)) + ')';
  let fresh;
  if (P.live) fresh = '<span class="good">●</span> <b class="good">' + (m.proxy ? 'Live estimate' : 'Live from Finnhub') + '</b> · ' + esc(ago(P.at)) + (m.proxy ? '<br>last bot-run price moved like the fund ' + esc(m.proxy) + ' (live from Finnhub)' : '');
  else if (qerr) fresh = botRun + '<br><span class="warn">' + esc(qerr) + '</span>';
  else if (!(m.fh || m.proxy)) fresh = botRun + '<br>no live source for this market on the free Finnhub plan';
  else if (!fhKey()) fresh = botRun + '<br>for live prices: ⚙ › Live prices (Finnhub key)';
  else if (P.q) fresh = botRun + '<br>Finnhub’s last price: ' + esc(m.proxy || '') + ' $' + f2(P.q.c) + ' from ' + esc(when(P.q.t * 1000)) + ': ' + (m.kind === 'Crypto' ? 'older than the bot run' : 'the US market is closed (live prices 15:30–22:00 German time), so the bot run’s pre-market price is newer');
  else fresh = botRun + '<br>Finnhub had no price for ' + esc(m.fh || m.proxy);
  let h = '<div class="shead"><div style="min-width:0;flex:1"><div class="sname">' + esc(m.name) + '</div><div class="mute" style="font-size:12.5px">' + esc(m.sym) + (m.exchange ? ' · ' + esc(m.exchange) : '') + ' · ' + esc(m.kind) + '</div></div>' +
    '<div style="text-align:right"><div class="sprice num">' + twoCur(p) + '</div><div class="mute" style="font-size:12px">' + (p.dayChangePct != null ? 'today ' + pc(p.dayChangePct) + ' · ' : '') + '1 € = $' + (p.eurusd ? p.eurusd.toFixed(4) : '–') + '</div></div></div>';
  h += '<div style="display:flex;gap:10px;align-items:center;font-size:12.5px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--card2)"><div style="flex:1;min-width:0">' + fresh + '</div><button class="btn" data-act="again" style="padding:4px 10px;font-size:13px" title="Get the price again">⟳</button></div>';
  h += '<div class="verdict ' + d.verdict.tone + '">' + esc(d.verdict.text) + (m.kind === 'Stocks' && m.us ? '<span class="vnote"> · the bots decide on the price at 15:45 New York (21:45 German time); during the day this can still change</span>' : '') + (!p.forming ? '<span class="vnote"> · market closed today: based on the last close (' + esc(p.lastClose) + ')</span>' : '') + '</div>';
  h += '<div class="rulegrid">' + d.rules.map(r => '<div class="rule"><div class="rh"><b>' + esc(r.name) + '</b><span class="pill ' + r.tone + '">' + esc(r.status) + '</span></div><div class="rt">' + esc(r.text) + '</div>' +
    (r.levels.length ? '<table class="lvl">' + r.levels.map(l => '<tr><td>' + esc(l.label) + (l.note ? ' <span class="mute">(' + esc(l.note) + ')</span>' : '') + '</td><td class="num">' + twoCur(l) + '</td></tr>').join('') + '</table>' : '') +
    (r.tested ? '<div class="mute" style="font-size:11.5px">' + esc(r.tested) + '</div>' : '') + '</div>').join('') + '</div>';
  const facts = [['RSI(2) · 2-day strength', s.rsi2 == null ? '–' : s.rsi2.toFixed(0) + ' · <span class="' + (s.rsi2 < 10 ? 'good' : s.rsi2 > 90 ? 'bad' : 'mute') + '">' + (s.rsi2 < 10 ? 'sharp dip' : s.rsi2 < 30 ? 'falling' : s.rsi2 <= 70 ? 'normal' : s.rsi2 <= 90 ? 'rising' : 'sharp rise') + '</span>'], ['Normal daily move', s.atrPct == null ? '–' : s.atrPct.toFixed(1) + '%'], ['1 month', pc(s.chg1m)], ['3 months', pc(s.chg3m)], ['1 year', pc(s.chg1y)], ['52-week range', '$' + f2(s.lo52.usd) + ' – $' + f2(s.hi52.usd) + '<br><span class="mute" style="font-weight:400">€' + f2(s.lo52.eur) + ' – €' + f2(s.hi52.eur) + '</span>']];
  if (d.earnings) facts.push(['Next earnings', esc(d.earnings.date) + (d.earnings.days >= 0 ? ' <span class="' + (d.earnings.days <= 14 ? 'warn' : 'mute') + '">(in ' + d.earnings.days + ' days' + (d.earnings.days <= 14 ? ': the bots avoid new trades' : '') + ')</span>' : '')]);
  h += '<div class="sfacts">' + facts.map(f => '<div><span>' + f[0] + '</span><b class="num">' + f[1] + '</b></div>').join('') + '</div>';
  h += stockChart(d, res.clientWidth - 32);
  if (m.watched) h += '<div style="text-align:right"><button class="btn" data-act="unwatch" data-id="' + m.id + '" style="font-size:12px;padding:4px 10px">Remove from the list</button></div>';
  h += '<div class="mute" style="font-size:11.5px">Outputs of our tested rules, not investment advice. Daily candles from the bots’ broker (saved at each bot run); live prices can differ slightly from the broker’s.</div>';
  res.innerHTML = '<div class="sres">' + h + '</div>';
  bindStockHover(d);
}
let SGEO = null;
function stockChart(d, W) {
  const pts = d.chart || []; if (pts.length < 5) return '';
  W = Math.max(280, W || 340); const H = 170, pad = { l: 48, r: 8, t: 10, b: 20 };
  const r0 = d.rules[0], buy = r0.status === 'BUY SIGNAL' ? r0.levels : [];
  const vals = pts.flatMap(p => [p.c, p.e50, p.s200]).filter(v => v != null).concat(buy.map(l => l.local).filter(v => v != null));
  let lo = Math.min(...vals), hi = Math.max(...vals); const pv = (hi - lo) * .08 || 1; lo -= pv; hi += pv;
  const x = i => pad.l + i / (pts.length - 1) * (W - pad.l - pad.r), y = v => pad.t + (hi - v) / (hi - lo) * (H - pad.t - pad.b);
  SGEO = { pts, W, pad, x, y };
  const path = k => { let s = '', on = false; pts.forEach((p, i) => { if (p[k] == null) { on = false; return; } s += (on ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(p[k]).toFixed(1); on = true; }); return s; };
  const ax = v => Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : f2(v);
  let g = ''; for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3; g += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:var(--line)"/><text x="' + (pad.l - 5) + '" y="' + (y(v) + 4) + '" text-anchor="end" style="fill:var(--mute)" font-size="10">' + ax(v) + '</text>'; }
  g += '<path d="' + path('s200') + '" fill="none" style="stroke:var(--mute)" stroke-width="1.5" stroke-dasharray="5 4"/><path d="' + path('e50') + '" fill="none" style="stroke:var(--botC)" stroke-width="1.5"/><path d="' + path('c') + '" fill="none" style="stroke:var(--accent)" stroke-width="2"/>';
  for (const [name, col] of [['Buy if it dips to (limit)', 'var(--good)'], ['Stop-loss', 'var(--bad)']]) { const l = buy.find(z => z.label.indexOf(name) === 0); if (l && l.local != null) g += '<line x1="' + pad.l + '" x2="' + (W - pad.r) + '" y1="' + y(l.local) + '" y2="' + y(l.local) + '" style="stroke:' + col + '" stroke-dasharray="3 3"/><text x="' + (W - pad.r) + '" y="' + (y(l.local) - 4) + '" text-anchor="end" style="fill:' + col + '" font-size="10">' + (name.indexOf('Stop') === 0 ? 'stop' : 'buy limit') + '</text>'; }
  const fd = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  g += '<text x="' + pad.l + '" y="' + (H - 5) + '" style="fill:var(--mute)" font-size="10">' + fd(pts[0].t) + '</text><text x="' + (W - pad.r) + '" y="' + (H - 5) + '" text-anchor="end" style="fill:var(--mute)" font-size="10">' + fd(pts.at(-1).t) + '</text>';
  g += '<g id="shov" style="display:none"><line id="shl" y1="' + pad.t + '" y2="' + (H - pad.b) + '" style="stroke:var(--mute)"/><circle id="shc" r="4.5" style="fill:var(--accent);stroke:var(--card)" stroke-width="2"/><circle id="she" r="3.5" style="fill:var(--botC);stroke:var(--card)" stroke-width="1.5"/><circle id="shs" r="3.5" style="fill:var(--mute);stroke:var(--card)" stroke-width="1.5"/></g>';
  return '<div style="position:relative"><svg id="ssvg" viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:' + H + 'px;display:block;touch-action:pan-y">' + g + '</svg><div class="tip" id="stip"></div><div class="slegend"><span><i style="background:var(--accent)"></i>price</span><span><i style="background:var(--botC)"></i>50-day average</span><span><i class="dash"></i>200-day average</span></div></div>';
}
function bindStockHover(d) {
  const svg = $('ssvg'); if (!svg || !SGEO) return;
  const { pts, W, pad, x, y } = SGEO, tip = $('stip'), g = $('shov'), cv = d.market.cv || 1, fx = d.price.eurusd;
  const both = v => v == null ? '–' : '<b>$' + f2(v * cv) + '</b> <span class="mute">€' + (fx ? f2(v * cv / fx) : '–') + '</span>';
  const show = cx => {
    const rc = svg.getBoundingClientRect(), mx = (cx - rc.left) * W / rc.width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((mx - pad.l) / (W - pad.l - pad.r) * (pts.length - 1)))), q = pts[i];
    g.style.display = ''; $('shl').setAttribute('x1', x(i)); $('shl').setAttribute('x2', x(i));
    $('shc').setAttribute('cx', x(i)); $('shc').setAttribute('cy', y(q.c));
    for (const [id, k] of [['she', 'e50'], ['shs', 's200']]) { const el = $(id); if (q[k] == null) el.style.display = 'none'; else { el.style.display = ''; el.setAttribute('cx', x(i)); el.setAttribute('cy', y(q[k])); } }
    const prev = i > 0 ? pts[i - 1].c : null, ch = prev ? (q.c / prev - 1) * 100 : null;
    tip.innerHTML = '<div class="mute" style="margin-bottom:3px">' + new Date(q.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) + (i === pts.length - 1 && d.price.forming ? ' (today)' : '') + '</div>' +
      '<div class="tr" style="--c:var(--accent)"><span style="display:flex;gap:6px;align-items:center"><i></i>Close</span><span class="num">' + both(q.c) + (ch != null ? ' <span class="' + (ch > 0 ? 'good' : ch < 0 ? 'bad' : 'mute') + '">' + (ch > 0 ? '+' : '') + ch.toFixed(1) + '%</span>' : '') + '</span></div>' +
      (q.e50 != null ? '<div class="tr" style="--c:var(--botC)"><span style="display:flex;gap:6px;align-items:center"><i></i>50-day</span><span class="num">' + both(q.e50) + '</span></div>' : '') +
      (q.s200 != null ? '<div class="tr" style="--c:var(--mute)"><span style="display:flex;gap:6px;align-items:center"><i></i>200-day</span><span class="num">' + both(q.s200) + '</span></div>' : '');
    tip.style.display = 'block';
    const left = x(i) * rc.width / W; tip.style.left = Math.max(4, Math.min(left + 14, rc.width - tip.offsetWidth - 4)) + 'px'; tip.style.top = '6px';
  };
  const hide = () => { tip.style.display = 'none'; g.style.display = 'none'; };
  svg.onpointermove = e => show(e.clientX); svg.onpointerdown = e => show(e.clientX); svg.onpointerleave = hide;
}

// Live prices for the fixed buy levels in Today's signals (Finnhub; at most once a minute per market)
const fxCache = {};
async function liveFixed() {
  if (!fhKey() || !DATA || !DATA.scan) return;
  try { await loadMarkets(); } catch (e) { return; }
  const fx = DATA.scan.eurusd, p2 = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const el of document.querySelectorAll('[data-fx]')) {
    const m = MK.markets.find(x => x.name === el.dataset.fx); if (!m || !(m.fh || (m.proxy && m.proxyAt))) continue;
    let c = fxCache[m.id];
    if (!c || Date.now() - c.at > 60000) { try { c = { at: Date.now(), q: await liveQuote(m) }; } catch (e) { return; } fxCache[m.id] = c; }
    const q = c.q; if (!q || q.t * 1000 <= Date.parse(DATA.scan.at)) continue;
    let price = q.c, low = el.dataset.low === '' ? null : Number(el.dataset.low);
    if (m.proxy) price = m.px * q.c / m.proxyAt; // estimate from the matching fund
    else if (q.l && dayOf(q.t * 1000, m.kind === 'Crypto') > Date.parse(el.dataset.day) / 864e5) low = low == null ? q.l : Math.min(low, q.l);
    const st = fixedStatus({ trigger: Number(el.dataset.trig) }, price, low), se = el.querySelector('[data-fxst]'), ne = el.querySelector('[data-fxnow]');
    if (se) { se.className = st[0]; se.textContent = st[1]; }
    if (ne) ne.innerHTML = '<b>$' + p2(price) + '</b> <span class="mute">€' + (fx ? p2(price / fx) : '–') + '</span> <span class="good">● ' + (m.proxy ? 'est.' : 'live') + '</span>';
  }
}
setInterval(() => { if (document.visibilityState === 'visible' && current() === 'home') liveFixed(); }, 60000);

// Finnhub key in Settings (stored only on this phone)
const renderSettingsBase = renderSettings;
renderSettings = function (msg) {
  renderSettingsBase(msg);
  const card = document.createElement('div'); card.className = 'card pad';
  card.innerHTML = '<b>Live prices (Finnhub key)</b><div class="mute" style="font-size:13px">Optional. Stored only on this phone; used for live prices in Stock check (US stocks and crypto live; indices, gold and oil estimated from a matching US fund). Free key: finnhub.io › Dashboard › API key (the same one the bots use).</div>' +
    '<label for="fhk">Finnhub key</label><input id="fhk" type="password" placeholder="' + (fhKey() ? 'saved: leave empty to keep it' : 'paste your key') + '" autocapitalize="off" autocomplete="off">' +
    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"><button class="btn primary" id="fhsave">Save</button>' + (fhKey() ? '<button class="btn" id="fhdel">Forget</button>' : '') + '</div>';
  const st = $('settings'); st.insertBefore(card, st.children[2] || null);
  $('fhsave').onclick = () => { const v = $('fhk').value.trim(); if (v) { store.set('fhkey', v); toast('Finnhub key saved on this phone'); renderSettings(); } };
  if ($('fhdel')) $('fhdel').onclick = () => { store.del('fhkey'); renderSettings('Finnhub key removed from this phone.'); };
};
const loadBase = load;
// fresh stock data with every new bot run (or a manual refresh)
load = async function (manual) {
  await loadBase(manual);
  const stale = MK && DATA && Date.parse(DATA.generatedAt) - Date.parse(MK.at) > 5 * 60000;
  if ((manual || stale) && token()) loadMarkets(true).then(() => { if (current() === 'home') mountStock(); }).catch(() => {});
};
if (current() === 'home' && token()) mountStock(); else if (current() === 'settings') renderSettings();
