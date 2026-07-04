/* ════════════════════════════════════════════════════════════════════
 * budget-abroad/notion.js
 * Live Notion reads for the year-abroad budget pages (Dashboard,
 * Forecast Planner, Biweekly Cockpit). Ported from finances.html.
 *
 * Exposes window.BudgetAbroad — the .dc.html component scripts call these
 * from componentDidMount() and setState() with the results.
 * ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var PROXY_URL  = '/api/notion';
  var WORKER_URL = 'https://notion-budget-manager.eamiller1981.workers.dev';

  // Notion database ids (no dashes)
  var FORECAST_DB = '392627ee81db80c9af9bf27e7de0f185'; // Abroad - Forecast
  var BUDGET_RUN_DB = '311627ee81db80b8ae51c5b7c8ed83bb'; // 💸 Budget Run
  var ACCOUNTS_DB = '779dccf0265a475ebe784612b5d8e2eb';   // 🪣 Accounts
  var ENGINE_DB = '40dfe0c1b236407ab13e805b418f5d9d';     // 💱 Current Budget Engine

  /* ---- transport (ported from finances.html notionFetch) ---- */
  function notionFetch(path, method, body) {
    var isVercel = window.location.hostname.slice(-10) === 'vercel.app';
    var request = isVercel ? {
      url: PROXY_URL,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: path, method: method, body: body })
      }
    } : {
      url: WORKER_URL + '/notion' + path,
      options: { method: method, headers: { 'Content-Type': 'application/json' } }
    };
    if (!isVercel && body !== undefined && body !== null) {
      request.options.body = JSON.stringify(body);
    }
    return fetch(request.url, request.options).then(function (r) {
      return r.text().then(function (text) {
        try { return JSON.parse(text); }
        catch (err) { throw new Error('Notion request returned non-JSON (HTTP ' + r.status + ').'); }
      });
    });
  }

  /* ---- property readers (ported / extended) ---- */
  function notionPropNum(prop) {
    if (!prop) return null;
    if (typeof prop.number === 'number') return prop.number;
    if (prop.formula) {
      if (typeof prop.formula.number === 'number') return prop.formula.number;
      if (typeof prop.formula.string === 'string') {
        var f = parseFloat(prop.formula.string.replace(/[$,]/g, ''));
        if (!isNaN(f)) return f;
      }
    }
    if (prop.rollup) {
      if (typeof prop.rollup.number === 'number') return prop.rollup.number;
      if (Array.isArray(prop.rollup.array)) {
        return prop.rollup.array.reduce(function (sum, item) {
          if (item.type === 'number' && typeof item.number === 'number') return sum + item.number;
          if (item.type === 'formula' && item.formula && typeof item.formula.number === 'number') return sum + item.formula.number;
          return sum;
        }, 0);
      }
    }
    return null;
  }
  function num(prop) { var v = notionPropNum(prop); return typeof v === 'number' ? v : 0; }
  function propText(prop) {
    if (!prop) return '';
    var arr = prop.title || prop.rich_text;
    if (Array.isArray(arr)) return arr.map(function (t) { return t.plain_text; }).join('');
    if (prop.select && prop.select.name) return prop.select.name;
    if (prop.formula && typeof prop.formula.string === 'string') return prop.formula.string;
    return '';
  }
  function propDate(prop) {
    if (prop && prop.date && prop.date.start) return prop.date.start;
    return null;
  }
  function propChecked(prop) { return !!(prop && prop.checkbox); }

  /* ---- paginated query ---- */
  function queryAll(dbId, body) {
    body = body || {};
    var out = [];
    function page(cursor) {
      var b = Object.assign({ page_size: 100 }, body);
      if (cursor) b.start_cursor = cursor;
      return notionFetch('/databases/' + dbId + '/query', 'POST', b).then(function (data) {
        if (data && data.object === 'error') throw new Error(data.message);
        out = out.concat(data.results || []);
        if (data.has_more && data.next_cursor) return page(data.next_cursor);
        return out;
      });
    }
    return page(null);
  }

  function parseISO(s) {
    if (!s) return null;
    // handle YYYY-MM-DD as local date to avoid TZ drift
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /* ════════════════════════════════════════════════════════════════
   * loadForecastBase() — the shared planned-envelope reader.
   * Reads Abroad - Forecast, orders by Start, and computes the cross-row
   * cumulatives Notion cannot express:
   *   Balance Forward[n] = USAA Buffer[n-1]
   *   rmdr = (Income + Balance Forward) - Total Payday Allocations
   *   sav/emg/buf = rmdr * 0.40 / 0.40 / 0.20
   * Returns an ordered array of period rows.
   * ════════════════════════════════════════════════════════════════ */
  function loadForecastBase() {
    return queryAll(FORECAST_DB, {
      filter: { property: 'Period', title: { is_not_empty: true } },
      sorts: [{ property: 'Start', direction: 'ascending' }]
    }).then(function (results) {
      var rows = results.map(function (pg) {
        var p = pg.properties || {};
        var billsDom = num(p['Bills (Domestic)']);
        var billsAbr = num(p['Bills (Abroad)']);
        var lizCoh = num(p['Liz COH']);
        var spending = num(p['Spending Money']);
        var travelCash = num(p['Travel Cash']);
        var mattCoh = num(p['Matt COH']);
        var lodging = num(p['Lodging']);
        var flights = num(p['Car Rentals & Flights']);
        var loganCoh = num(p['Logan COH']);
        var logan = num(p['Logan']);
        var momPapa = num(p['Mom & Papa']);
        // Within-row TPA is correct in Notion; read the formula directly.
        var tpa = num(p['Total Payday Allocations']);
        if (!tpa) {
          tpa = billsDom + lizCoh + mattCoh + loganCoh + num(p['Cashapp']) +
                billsAbr + spending + travelCash + lodging + flights + momPapa + logan;
        }
        return {
          period: propText(p['Period']),
          loc: propText(p['Location']),
          leg: propText(p['Transition']),
          income: num(p['Income']),
          storedBalFwd: num(p['Balance Forward']),
          bills: billsDom + billsAbr,
          daily: lizCoh + spending + travelCash,
          travel: mattCoh + lodging + flights,
          family: loganCoh + logan + momPapa,
          familyLogan: logan,        // Forecast "Logan" column (period)
          familyMomPapa: momPapa,    // Forecast "Mom & Papa" column (period)
          tpa: tpa,
          start: parseISO(propDate(p['Start'])),
          end: parseISO(propDate(p['End']))
        };
      });
      // cross-row cumulative pass
      var balFwd = rows.length ? rows[0].storedBalFwd || 0 : 0;
      rows.forEach(function (r, i) {
        if (i > 0) balFwd = rows[i - 1].buf;
        r.balFwd = balFwd;
        var totalIncome = r.income + balFwd;
        r.rmdr = totalIncome - r.tpa;
        r.sav = r.rmdr * 0.40;
        r.emg = r.rmdr * 0.40;
        r.buf = r.rmdr * 0.20;
      });
      return rows;
    });
  }

  /* ════════════════════════════════════════════════════════════════
   * loadActuals(base) — elapsed Budget Run rows, aligned to forecast
   * periods by Paydate. Returns { indexInBase: {bills,daily,travel,family,sav,emg} }.
   * Daily actual = Altitude *9722 balance + 8568 Schwab Spend.
   * Travel actual = Venture *0074 balance. Family = 6374 + 3536.
   * Savings = 7397, Emergency = 0741. Only rows with recorded data are kept.
   * ════════════════════════════════════════════════════════════════ */
  function loadActuals(base) {
    return queryAll(BUDGET_RUN_DB, {
      sorts: [{ property: 'Paydate', direction: 'ascending' }]
    }).then(function (results) {
      // map each run to nearest forecast start (within 3 days)
      var actuals = {};
      results.forEach(function (pg) {
        var p = pg.properties || {};
        var pd = parseISO(propDate(p['Paydate']));
        if (!pd) return;
        var idx = -1, bestDiff = 4 * 864e5;
        for (var i = 0; i < base.length; i++) {
          if (!base[i].start) continue;
          var diff = Math.abs(base[i].start.getTime() - pd.getTime());
          if (diff < bestDiff) { bestDiff = diff; idx = i; }
        }
        if (idx < 0) return;
        var billsLive = notionPropNum(p['Less Bills (Live)']);
        if (billsLive == null) billsLive = notionPropNum(p['Less Bills']);
        var daily = num(p['9722 Altitude Connect']) + num(p['8568 Schwab Spend']);
        var travel = num(p['0074 Venture']);
        var family = num(p['6374 Logan']) + num(p['3536 Mom and Papa']);
        var sav = num(p['7397 Savings']);
        var emg = num(p['0741 Special Svgs']);
        var recorded = (billsLive || 0) + daily + travel + family + sav + emg;
        if (recorded <= 0.005) return; // nothing recorded yet
        actuals[idx] = {
          bills: billsLive || 0, daily: daily, travel: travel,
          family: family, sav: sav, emg: emg
        };
      });
      return actuals;
    });
  }

  /* ════════════════════════════════════════════════════════════════
   * loadCurrentRun() — the current Budget Run row for the Cockpit.
   * ════════════════════════════════════════════════════════════════ */
  function loadCurrentRun() {
    return queryAll(BUDGET_RUN_DB, {
      filter: { property: 'Current Run', checkbox: { equals: true } },
      sorts: [{ property: 'Paydate', direction: 'descending' }]
    }).then(function (results) {
      if (!results.length) return null;
      var pg = results[0];
      var p = pg.properties || {};
      var run = {
        pageId: pg.id,
        paydate: propDate(p['Paydate']),
        balancesPending: propChecked(p['Balances Pending']),
        totalAssets: notionPropNum(p['Total Account Balance']),
        billsLive: (function () {
          var v = notionPropNum(p['Less Bills (Live)']);
          return v == null ? num(p['Less Bills']) : v;
        })(),
        bank: {
          '7419': num(p['7419 Main']),
          '7397': num(p['7397 Savings']),
          '0741': num(p['0741 Special Svgs']),
          '9176': num(p['9176 Liz COH']),
          '0458': num(p['0458 Matt COH']),
          '7889': num(p['7889 Logan COH']),
          '8568': num(p['8568 Schwab']),
          '9168': num(p['9168 Liz COH Svgs']),
          '0466': num(p['0466 Matt COH Svgs']),
          '3195': num(p['3195 Logan COH Svgs'])
        },
        cards: {
          '0074': num(p['0074 Venture']),
          '9722': num(p['9722 Altitude Connect']),
          '1375': num(p['1375 USAA Credit']),
          '9379': num(p['9379 Ulta']),
          '3611': num(p['3611 Prime Visa'])
        },
        schwabSpend: num(p['8568 Schwab Spend']),
        family: {
          '6374': num(p['6374 Logan']),
          '3536': num(p['3536 Mom and Papa'])
        }
      };
      // "Bills due today" comes from the Current Budget Engine formula
      // "Bills Due Today" (Σ Reserve Needed Today across related Bills, live
      // today()→Period End), NOT the run's Less Bills (Live) reserve.
      return loadEngineBillsDueToday().then(function (bdt) {
        run.billsDueToday = (bdt == null ? run.billsLive : bdt);
        return run;
      });
    });
  }

  /* Read "Bills Due Today" from the Current Budget Engine. There is a single
   * settings row ("Bills + Debts"); its Bills Due Today formula is live
   * (today()→Period End) independent of which run it links to, so we read the
   * first row directly rather than matching by the run relation (a freshly
   * created run isn't linked to the engine row yet). Returns null if unread. */
  function loadEngineBillsDueToday() {
    return queryAll(ENGINE_DB, {}).then(function (results) {
      for (var i = 0; i < results.length; i++) {
        var v = notionPropNum((results[i].properties || {})['Bills Due Today']);
        if (v != null) return v;
      }
      return null;
    }).catch(function () { return null; });
  }

  /* ════════════════════════════════════════════════════════════════
   * loadBillsDue() — bills due from today through this period's end.
   * The per-bill formula "Reserve Needed Today (Bills only)" returns the
   * bill's Amount when today→Period End overlaps its due window (and it's
   * unpaid), else 0. That column rolls up to the run's "Less Bills (Live)"
   * reserve, so filtering reserve>0 yields exactly the bills that make up
   * that number. Returns [{merchant, amount, next}] sorted by next date.
   * ════════════════════════════════════════════════════════════════ */
  var BILLS_DB = 'dda95f92df7445fab2681ddc330e2b46'; // 📉 Bills
  function loadBillsDue() {
    return queryAll(BILLS_DB, {
      filter: { property: 'Paid', checkbox: { equals: false } }
    }).then(function (results) {
      var rows = results.map(function (pg) {
        var p = pg.properties || {};
        var reserve = num(p['Reserve Needed Today (Bills only)']);
        return {
          merchant: propText(p['Merchant']).replace(/\s+/g, ' ').trim(),
          amount: reserve,           // = bill Amount when in-window; ties to Less Bills (Live)
          next: propDate(p['Next Occurrence'])
        };
      }).filter(function (b) { return b.amount > 0.005; });
      rows.sort(function (a, b) {
        var da = a.next ? parseISO(a.next).getTime() : Infinity;
        var db = b.next ? parseISO(b.next).getTime() : Infinity;
        return da - db;
      });
      return rows;
    });
  }

  /* ---- 40/40/20 from Accounts Percent (best-effort; falls back to defaults) ---- */
  function loadAllocPercents() {
    return queryAll(ACCOUNTS_DB, {}).then(function (results) {
      var map = {};
      results.forEach(function (pg) {
        var p = pg.properties || {};
        var name = propText(p['Name'] || p['Account'] || p['Title']);
        var pct = notionPropNum(p['Percent']);
        // key by trailing 4-digit mask found in the name
        var m = /(\d{4})/.exec(name);
        if (m && pct != null) map[m[1]] = pct;
      });
      return {
        savings: (map['7397'] != null ? map['7397'] : 0.40) * 100,
        emergency: (map['0741'] != null ? map['0741'] : 0.40) * 100,
        buffer: (map['7419'] != null ? map['7419'] : 0.20) * 100
      };
    }).catch(function () {
      return { savings: 40, emergency: 40, buffer: 20 };
    });
  }

  /* ---- Cockpit write path (Commit + Run flow) ---- */
  function demoteCurrentRuns() {
    return queryAll(BUDGET_RUN_DB, {
      filter: { property: 'Current Run', checkbox: { equals: true } }
    }).then(function (results) {
      return results.reduce(function (chain, pg) {
        return chain.then(function () {
          return notionFetch('/pages/' + pg.id, 'PATCH', {
            properties: { 'Current Run': { checkbox: false } }
          });
        });
      }, Promise.resolve());
    });
  }
  function createPendingRun(paydateVal) {
    var reqId = 'req_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    return demoteCurrentRuns().then(function () {
      return notionFetch('/pages', 'POST', {
        parent: { database_id: BUDGET_RUN_DB },
        properties: {
          'Current Run': { checkbox: true },
          'Balances Pending': { checkbox: true },
          'Balance Request ID': { rich_text: [{ text: { content: reqId } }] },
          'Paydate': { date: { start: paydateVal } },
          'Today': { date: { start: new Date().toISOString().split('T')[0] } }
        }
      });
    }).then(function (pg) {
      if (pg && pg.object === 'error') throw new Error(pg.message);
      return { pageId: pg.id, requestId: reqId };
    });
  }
  function pollBalances(pageId, onTick) {
    var attempts = 40, waitMs = 3000;
    function step(n) {
      return notionFetch('/pages/' + pageId, 'GET').then(function (pg) {
        if (pg && pg.object === 'error') throw new Error(pg.message);
        var pending = propChecked((pg.properties || {})['Balances Pending']);
        if (onTick) onTick(n, pending);
        if (!pending) return pg;
        if (n >= attempts) return null; // timed out
        return new Promise(function (res) { setTimeout(res, waitMs); }).then(function () { return step(n + 1); });
      });
    }
    return step(0);
  }
  function commitRun(pageId, props) {
    return notionFetch('/pages/' + pageId, 'PATCH', { properties: props }).then(function (pg) {
      if (pg && pg.object === 'error') throw new Error(pg.message);
      return pg;
    });
  }

  window.BudgetAbroad = {
    notionFetch: notionFetch,
    notionPropNum: notionPropNum,
    loadForecastBase: loadForecastBase,
    loadActuals: loadActuals,
    loadCurrentRun: loadCurrentRun,
    loadBillsDue: loadBillsDue,
    loadAllocPercents: loadAllocPercents,
    createPendingRun: createPendingRun,
    pollBalances: pollBalances,
    commitRun: commitRun,
    ids: { FORECAST_DB: FORECAST_DB, BUDGET_RUN_DB: BUDGET_RUN_DB, ACCOUNTS_DB: ACCOUNTS_DB }
  };
})();
