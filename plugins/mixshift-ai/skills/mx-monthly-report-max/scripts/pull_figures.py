#!/usr/bin/env python3
"""
Pull the standard call-brief figure battery for one Seller Central account.

Every query in here has a trap in it (see references/queries.md). Re-deriving them by
hand each month is how a wrong number reaches a client, so this script owns them.

Usage:
    python3 pull_figures.py --seller-id <SellerID> --as-of <yesterday> --out /tmp/figures.json
    python3 pull_figures.py --seller-id <SellerID> --as-of <yesterday> --brands "Brand A,Brand B"

Writes one JSON with: resolved windows, account ad + retail metrics for all three
periods, dark-day counts, settled-window efficiency check, daily series, segment
splits, ASIN movers, out-of-stock days, Buy Box by ASIN (page-view weighted, month
and last 7 days), and the reconciliation result.

Seller Central only. For Vendor Central read references/queries.md and go by hand:
the ad path is sellermonthmetric and there is no Buy Box or session count.
"""

import argparse
import calendar
import datetime as dt
import json
import os
import shutil
import subprocess
import sys

MARKET_SQL_TIMEOUT_HINT = "narrow the date range if a query times out at 60s"


# ---------------------------------------------------------------- CLI plumbing

def find_cli():
    """Locate the mixshift harness CLI.

    PATH first. Otherwise scan for the bundled cli.js and take the HIGHEST version,
    not the first line: a machine keeps every version it has installed and text order
    is not version order (as text, 0.8.10 sorts before 0.8.9).
    """
    if shutil.which("mixshift"):
        return ["mixshift"]
    env = os.environ.get("MIXSHIFT_CLI")
    if env and os.path.exists(env):
        return ["node", env]
    # The script ships inside the plugin, two levels from the harness: resolve its own
    # sibling FIRST. This also makes the script work on native Windows, where the
    # POSIX find below resolves to DOS find.exe and silently returns nothing.
    here = os.path.dirname(os.path.abspath(__file__))
    sibling = os.path.normpath(os.path.join(here, "..", "..", "..", "harness", "dist", "cli.js"))
    if os.path.exists(sibling):
        return ["node", sibling]
    found = subprocess.run(
        ["find", "/", "-maxdepth", "9", "-type", "f", "-path", "*/harness/dist/cli.js"],
        capture_output=True, text=True,
    ).stdout.split()
    if not found:
        sys.exit("mixshift CLI not found. The plugin ships it inside an ID-named "
                 "plugin folder, so a PATH or npm check will not reveal it.")

    def vkey(path):
        nums = []
        for part in path.split("/"):
            bits = part.replace("-", ".").split(".")
            run = [int(b) for b in bits if b.isdigit()]
            if len(run) >= 2:
                nums = run
        return nums or [0]

    return ["node", max(found, key=vkey)]


CLI = None


def query(sql, label=""):
    """Run one read-only SQL query. Returns the rows list, or raises with the message.

    --inline matters: without it the CLI spills any result over its inline ceiling
    (~500 rows) to a CSV and returns ok WITHOUT a rows key, which a naive reader
    treats as an empty result. An account with a big catalog would then report zero
    movers and zero out-of-stock items: a silent false negative on the exact
    mechanisms the brief leads with. This JSON is machine-consumed, never pasted
    into context, so inline is correct here.
    """
    proc = subprocess.run(
        CLI + ["data", "query", "--sql", sql, "--inline", "--json"],
        capture_output=True, text=True,
    )
    # The CLI prints a telemetry banner and node warnings on first run; find the JSON.
    out = proc.stdout
    start = out.find("{")
    if start < 0:
        raise RuntimeError(f"{label}: no JSON in CLI output. stderr: {proc.stderr[:400]}")
    try:
        payload = json.loads(out[start:])
    except json.JSONDecodeError as e:
        # Malformed/partial CLI output (plausible near the 60s ceiling) must degrade
        # per section like every other failure, not crash the whole battery.
        raise RuntimeError(f"{label}: invalid JSON in CLI output: {e}")
    if payload.get("status") != "ok":
        raise RuntimeError(f"{label}: {payload.get('failure_kind','error')}: "
                           f"{payload.get('message')} ({MARKET_SQL_TIMEOUT_HINT})")
    if "rows" not in payload:
        # Fail loudly rather than returning []: an ok-status payload without rows means
        # the result still spilled to a file (out_path). Never read that as "no data".
        raise RuntimeError(f"{label}: result spilled to a file ({payload.get('out_path', '?')}) "
                           f"instead of returning inline rows; narrow the window or read the file.")
    return payload["rows"]


def f(v):
    return float(v) if v is not None else None


def i(v):
    return int(v) if v is not None else None


# ------------------------------------------------------------------- windows

def resolve_windows(seller_id, as_of):
    """Align windows to the data, not the calendar.

    Business reports load behind ad data. Trim both to the earlier MAX(DateTime),
    then compare equal day counts against the prior month and prior year.
    """
    rows = query(f"""
        SELECT 'retail' src, MAX(DateTime) mx FROM business_reports_dpst_date WHERE SellerID={seller_id}
        UNION ALL
        SELECT 'ads' src, MAX(DateTime) mx FROM campaignmetric WHERE SellerID={seller_id}
    """, "window resolution")
    maxes = {r["src"]: r["mx"] for r in rows}
    if not maxes.get("retail") or not maxes.get("ads"):
        sys.exit(f"No data for SellerID {seller_id}. Confirm the account row: a SellerID "
                 f"with zero rows is usually the wrong twin (VC vs SC), not a bug.")

    def d(s):
        return dt.date.fromisoformat(str(s)[:10])

    end = min(d(maxes["retail"]), d(maxes["ads"]))
    if end > as_of:
        end = as_of

    # Month-completeness is per FIELD, not per table: a final day can land with sales
    # and units but zero sessions (seen live), silently inflating units-per-session by
    # a whole day of numerator. If the end date has sales activity but no sessions
    # while the prior day had both, step back a day (at most twice) and say so.
    trimmed = []
    for _ in range(2):
        rows = query(f"""
            SELECT SUM(Sessions) sess, SUM(UnitsOrdered) units
            FROM business_reports_dpst_date
            WHERE SellerID={seller_id} AND DateTime = '{end}'
        """, "field completeness")
        # Gateway rows serve numerics as strings; coerce before comparing (a raw
        # string-vs-int compare crashed the whole battery on first live contact).
        sess = f(rows[0]["sess"]) if rows and rows[0]["sess"] is not None else None
        units = f(rows[0]["units"]) if rows and rows[0]["units"] is not None else None
        if (units or 0) > 0 and not (sess or 0):
            trimmed.append(str(end))
            end = end - dt.timedelta(days=1)
        else:
            break
    day = end.day

    def clamp(year, month, dom):
        return dt.date(year, month, min(dom, calendar.monthrange(year, month)[1]))

    pm_year, pm_month = (end.year, end.month - 1) if end.month > 1 else (end.year - 1, 12)

    return {
        "data_max_retail": str(maxes["retail"])[:10],
        "data_max_ads": str(maxes["ads"])[:10],
        "trimmed_for_field_completeness": trimmed,
        "day_count": day,
        "current": [str(end.replace(day=1)), str(end)],
        "prior_month": [str(dt.date(pm_year, pm_month, 1)), str(clamp(pm_year, pm_month, day))],
        "prior_year": [str(dt.date(end.year - 1, end.month, 1)),
                       str(clamp(end.year - 1, end.month, day))],
        "settled_current": [str(end.replace(day=1)), str(end - dt.timedelta(days=7))],
        "settled_prior": [str(dt.date(pm_year, pm_month, 1)),
                          str(clamp(pm_year, pm_month, day) - dt.timedelta(days=7))],
        "last7": [str(end - dt.timedelta(days=6)), str(end)],
    }


def period_case(w, col="DateTime"):
    """Mutually exclusive CASE branches. Overlapping ranges make an earlier branch win
    silently and leave a later bucket holding only the remainder, which looks real."""
    c, p, y = w["current"], w["prior_month"], w["prior_year"]
    return (f"CASE WHEN {col} BETWEEN '{c[0]}' AND '{c[1]}' THEN 'A_current' "
            f"WHEN {col} BETWEEN '{p[0]}' AND '{p[1]}' THEN 'B_prior_month' "
            f"WHEN {col} BETWEEN '{y[0]}' AND '{y[1]}' THEN 'C_prior_year' END")


def period_where(w, col="DateTime"):
    c, p, y = w["current"], w["prior_month"], w["prior_year"]
    return (f"({col} BETWEEN '{c[0]}' AND '{c[1]}' OR {col} BETWEEN '{p[0]}' AND '{p[1]}' "
            f"OR {col} BETWEEN '{y[0]}' AND '{y[1]}')")


AD_SALES = ("SUM(CASE WHEN CampaignType='sponsoredProducts' "
            "THEN AttributedSales7day ELSE AttributedSales14day END)")
AD_ORDERS = ("SUM(CASE WHEN CampaignType='sponsoredProducts' "
             "THEN AttributedConversions7day ELSE AttributedConversions14day END)")


# ------------------------------------------------------------------ batteries

def account_ads(sid, w):
    rows = query(f"""
        SELECT {period_case(w)} AS period, ROUND(SUM(Cost),2) ad_spend,
               ROUND({AD_SALES},2) ad_sales, {AD_ORDERS} orders,
               SUM(Clicks) clicks, SUM(Impressions) impressions
        FROM campaignmetric WHERE SellerID={sid} AND {period_where(w)}
        GROUP BY period ORDER BY period
    """, "account ads")
    return {r["period"]: {"ad_spend": f(r["ad_spend"]), "ad_sales": f(r["ad_sales"]),
                          "orders": i(r["orders"]), "clicks": i(r["clicks"]),
                          "impressions": i(r["impressions"])} for r in rows if r["period"]}


def account_retail(sid, w):
    rows = query(f"""
        SELECT {period_case(w)} AS period, MAX(DateTime) last_day,
               ROUND(SUM(SalesAmount),2) ops, SUM(UnitsOrdered) units, SUM(Sessions) sessions,
               SUM(PageViews) page_views,
               ROUND(100*AVG(BuyBoxPercentage),1) buybox_simple,
               ROUND(AVG(AverageOfferCount),1) avg_offer_count
        FROM business_reports_dpst_date WHERE SellerID={sid} AND {period_where(w)}
        GROUP BY period ORDER BY period
    """, "account retail")
    out = {}
    for r in rows:
        if not r["period"]:
            continue
        ops, units, sess = f(r["ops"]), i(r["units"]), i(r["sessions"])
        out[r["period"]] = {
            "ops": ops, "units": units, "sessions": sess,
            "page_views": i(r["page_views"]), "last_day": str(r["last_day"])[:10],
            "buybox_simple_avg": f(r["buybox_simple"]),
            "avg_offer_count_reported": f(r["avg_offer_count"]),
            "asp": round(ops / units, 2) if ops and units else None,
            "units_per_session_pct": round(100 * units / sess, 2) if units and sess else None,
        }
    return out


def dark_days(sid, w):
    """A billing lapse or suspended account puts zeros in the series and silently
    deflates the comparison. Count active days per window so the brief can normalize."""
    out = {}
    for key in ("current", "prior_month", "prior_year"):
        s, e = w[key]
        # List the ACTIVE days and derive the dark ones in Python: a day with no rows
        # at all (the common outage shape) never appears in a GROUP BY, so asking SQL
        # for zero-spend days misses exactly the days that matter.
        arows = query(f"""
            SELECT DATE(DateTime) d FROM campaignmetric
            WHERE SellerID={sid} AND DateTime BETWEEN '{s}' AND '{e}'
            GROUP BY d HAVING SUM(Cost) > 0
        """, f"dark days {key}")
        active_dates = {str(r["d"])[:10] for r in arows}
        cal = (dt.date.fromisoformat(e) - dt.date.fromisoformat(s)).days + 1
        all_dates = [str(dt.date.fromisoformat(s) + dt.timedelta(days=k)) for k in range(cal)]
        zeros = [d for d in all_dates if d not in active_dates]
        active = len(active_dates)
        out[key] = {"calendar_days": cal, "active_ad_days": active,
                    "zero_spend_days": zeros,
                    "normalization_factor": round(cal / active, 4) if active else None}
    return out


def settled_check(sid, w, brands):
    """Sponsored Products attributes on a 7 day window, so the last week of a
    month-to-date pull is still filling in. Verify every efficiency claim here."""
    sc, sp = w["settled_current"], w["settled_prior"]
    seg = brand_case(brands, "CampaignName") if brands else "'ALL'"
    rows = query(f"""
        SELECT {seg} AS segment,
               CASE WHEN DateTime BETWEEN '{sc[0]}' AND '{sc[1]}' THEN 'A_current_settled'
                    ELSE 'B_prior_settled' END AS period,
               ROUND(SUM(Cost),2) spend, ROUND({AD_SALES},2) ad_sales
        FROM campaignmetric WHERE SellerID={sid}
          AND (DateTime BETWEEN '{sc[0]}' AND '{sc[1]}'
            OR DateTime BETWEEN '{sp[0]}' AND '{sp[1]}')
        GROUP BY segment, period ORDER BY segment, period
    """, "settled check")
    out = {}
    for r in rows:
        sp_, sa = f(r["spend"]), f(r["ad_sales"])
        out.setdefault(r["segment"], {})[r["period"]] = {
            "spend": sp_, "ad_sales": sa,
            "acos": round(100 * sp_ / sa, 1) if sp_ and sa else None}
    return {"windows": {"current": sc, "prior": sp}, "by_segment": out}


def daily_series(sid, w):
    s, e = w["current"]
    rows = query(f"""
        SELECT DATE(DateTime) d, ROUND(SalesAmount,0) ops, UnitsOrdered units,
               Sessions sessions, ROUND(AverageOfferCount,0) offers
        FROM business_reports_dpst_date WHERE SellerID={sid}
          AND DateTime BETWEEN '{s}' AND '{e}' ORDER BY d
    """, "daily series")
    series = [{"date": str(r["d"])[:10], "ops": f(r["ops"]), "units": i(r["units"]),
               "sessions": i(r["sessions"]), "offers": f(r["offers"])} for r in rows]
    vals = [x["ops"] for x in series if x["ops"] is not None]
    pace = {}
    if len(vals) >= 14:
        first7, last7 = sum(vals[:7]) / 7, sum(vals[-7:]) / 7
        end = dt.date.fromisoformat(series[-1]["date"])
        remaining = calendar.monthrange(end.year, end.month)[1] - end.day
        pace = {
            "first_7_day_avg": round(first7),
            "last_7_day_avg": round(last7),
            "change_pct": round(100 * (last7 - first7) / first7, 1) if first7 else None,
            "days_remaining": remaining,
            # Arithmetic, not a forecast. The brief must say so.
            "run_rate_close_arithmetic": round(sum(vals) + remaining * last7),
        }
    return {"series": series, "pace": pace}


def sql_lit(s):
    """Escape a value for a single-quoted MySQL string literal. Backslash FIRST:
    MySQL's default mode treats backslash as an escape, so doubling quotes alone
    leaves a trailing-backslash value able to break out of the literal. Brand names
    can arrive from meeting notes, so treat them as hostile."""
    return s.replace("\\", "\\\\").replace("'", "''")


def like_frag(s):
    """sql_lit plus LIKE wildcard escaping, so a literal % or _ in a brand name
    matches itself instead of anything."""
    return sql_lit(s).replace("%", "\\%").replace("_", "\\_")


def brand_case(brands, col="CampaignName"):
    """Prefer campaign name for the paid split: the campaign dimension table often has
    null Brand or missing rows, which silently drops spend into an unmapped bucket."""
    if not brands:
        return "'ALL'"
    whens = " ".join(
        f"WHEN {col} LIKE '%{like_frag(b)}%' THEN '{sql_lit(b)}'"
        for b in brands)
    return f"CASE {whens} ELSE 'OTHER' END"


def segment_ads(sid, w, brands):
    if not brands:
        return {}
    rows = query(f"""
        SELECT {brand_case(brands)} AS segment, {period_case(w)} AS period,
               ROUND(SUM(Cost),2) spend, ROUND({AD_SALES},2) ad_sales,
               {AD_ORDERS} orders, SUM(Clicks) clicks
        FROM campaignmetric WHERE SellerID={sid} AND {period_where(w)}
        GROUP BY segment, period ORDER BY segment, period
    """, "segment ads")
    out = {}
    for r in rows:
        if not r["period"]:
            continue
        sp_, sa = f(r["spend"]), f(r["ad_sales"])
        out.setdefault(r["segment"], {})[r["period"]] = {
            "spend": sp_, "ad_sales": sa, "orders": i(r["orders"]), "clicks": i(r["clicks"]),
            "acos": round(100 * sp_ / sa, 1) if sp_ and sa else None}
    return out


BRAND_LOOKUP = ("COALESCE((SELECT i.Brand FROM mws_items i "
                "WHERE i.ASIN=t.ChildAsin AND i.SellerID={sid} LIMIT 1),'(unmapped)')")
NICK_LOOKUP = ("(SELECT COALESCE(NULLIF(i.ItemNickname,''), i.ItemName) FROM mws_items i "
               "WHERE i.ASIN=t.ChildAsin AND i.SellerID={sid} LIMIT 1)")


def segment_retail(sid, w):
    """Correlated subquery for the brand, never JOIN mws_items: it holds several rows
    per ASIN, so a join multiplies rows and the sums come back 2x to 3x."""
    c, p = w["current"], w["prior_month"]
    rows = query(f"""
        SELECT {BRAND_LOOKUP.format(sid=sid)} AS segment,
          ROUND(SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.Amount ELSE 0 END),0) cur_ops,
          ROUND(SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.Amount ELSE 0 END),0) pri_ops,
          SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.UnitsOrdered ELSE 0 END) cur_units,
          SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.UnitsOrdered ELSE 0 END) pri_units,
          SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.Sessions ELSE 0 END) cur_sess,
          SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.Sessions ELSE 0 END) pri_sess,
          SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.PageViews ELSE 0 END) cur_pv,
          SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.PageViews ELSE 0 END) pri_pv,
          ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)
                 /NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.PageViews ELSE 0 END),0),1) cur_bb_pvw,
          ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)
                 /NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.PageViews ELSE 0 END),0),1) pri_bb_pvw
        FROM business_reports_dpst_sku t
        WHERE t.SellerID={sid}
          AND (t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR t.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
        GROUP BY segment ORDER BY cur_ops DESC
    """, "segment retail")
    return [{k: (f(v) if k.endswith(("_ops", "_bb_pvw")) else i(v)) if k != "segment" else v
             for k, v in r.items()} for r in rows]


def availability_breadth(sid, w):
    """Amazon reports average offer count only at account level. These are the segment
    equivalents: how many items were buyable, and what share of page views reached one.
    They answer the same question as offer count but are not the same metric.
    """
    c, p = w["current"], w["prior_month"]
    counts = query(f"""
        SELECT segment, period, ROUND(AVG(instock),1) avg_instock_items,
               ROUND(AVG(listed),1) avg_listed_items
        FROM (
          SELECT COALESCE((SELECT i.Brand FROM mws_items i
                           WHERE i.ASIN=h.ASIN AND i.SellerID={sid} LIMIT 1),'(unmapped)') segment,
            CASE WHEN h.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN 'A_current' ELSE 'B_prior_month' END period,
            DATE(h.DateTime) d,
            COUNT(DISTINCT CASE WHEN h.FulfillableQuantity > 0 THEN h.ASIN END) instock,
            COUNT(DISTINCT h.ASIN) listed
          FROM mws_inventory_history h WHERE h.SellerID={sid}
            AND (h.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR h.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
          GROUP BY segment, period, d
        ) t GROUP BY segment, period ORDER BY segment, period
    """, "availability counts")

    # Share of page views that landed on something buyable. Usually the single most
    # legible availability number in the whole brief.
    pv = query(f"""
        SELECT segment, period,
          ROUND(100*SUM(CASE WHEN instock=1 THEN pv ELSE 0 END)/NULLIF(SUM(pv),0),1) pct_pv_on_instock,
          SUM(pv) page_views
        FROM (
          SELECT COALESCE((SELECT i.Brand FROM mws_items i
                           WHERE i.ASIN=s.ChildAsin AND i.SellerID={sid} LIMIT 1),'(unmapped)') segment,
            CASE WHEN s.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN 'A_current' ELSE 'B_prior_month' END period,
            s.ChildAsin, DATE(s.DateTime) d, SUM(s.PageViews) pv,
            (SELECT CASE WHEN MAX(h.FulfillableQuantity) > 0 THEN 1 ELSE 0 END
             FROM mws_inventory_history h
             WHERE h.SellerID={sid} AND h.ASIN=s.ChildAsin AND DATE(h.DateTime)=DATE(s.DateTime)) instock
          FROM business_reports_dpst_sku s WHERE s.SellerID={sid}
            AND (s.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR s.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
          GROUP BY segment, period, s.ChildAsin, d
        ) t GROUP BY segment, period ORDER BY segment, period
    """, "page views on in-stock")
    return {"item_counts": counts, "page_view_share": pv}


def movers(sid, w):
    c, p = w["current"], w["prior_month"]
    rows = query(f"""
        SELECT t.ChildAsin asin, MAX(t.Title) title, {NICK_LOOKUP.format(sid=sid)} AS nickname,
          ROUND(SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.Amount ELSE 0 END),0) cur,
          ROUND(SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.Amount ELSE 0 END),0) pri,
          SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.UnitsOrdered ELSE 0 END) cur_units,
          SUM(CASE WHEN t.DateTime BETWEEN '{p[0]}' AND '{p[1]}' THEN t.UnitsOrdered ELSE 0 END) pri_units
        FROM business_reports_dpst_sku t WHERE t.SellerID={sid}
          AND (t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR t.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
        GROUP BY t.ChildAsin ORDER BY (cur-pri) ASC
    """, "movers")
    items = [{"asin": r["asin"], "title": r["title"], "nickname": r["nickname"],
              "cur": f(r["cur"]), "pri": f(r["pri"]),
              "cur_units": i(r["cur_units"]), "pri_units": i(r["pri_units"]),
              "delta": (f(r["cur"]) or 0) - (f(r["pri"]) or 0)} for r in rows]
    return {
        "items": items,
        "gross_declines": round(sum(x["delta"] for x in items if x["delta"] < 0)),
        "gross_gains": round(sum(x["delta"] for x in items if x["delta"] > 0)),
        "net": round(sum(x["delta"] for x in items)),
        "sum_cur": round(sum(x["cur"] or 0 for x in items)),
        "sum_pri": round(sum(x["pri"] or 0 for x in items)),
    }


def oos_days(sid, w):
    """Nested aggregate is required: mws_inventory_history carries several rows per
    ASIN per day, so a flat SUM(CASE ...) counts rows and returns impossible values
    like 200 out-of-stock days in a 25 day month.

    MAX(FulfillableQuantity) per ASIN-day is the definition: sellable somewhere means
    sellable. Ignores inbound and reserved, so it reads as "could not be bought".
    """
    c, p = w["current"], w["prior_month"]
    # Nickname via correlated subquery in the OUTER select, never a JOIN in the inner
    # one: mws_items carries several rows per ASIN, and a JOIN with divergent nickname
    # values splits one ASIN across grouped rows, inflating the stocked-out item count.
    rows = query(f"""
        SELECT COALESCE((SELECT COALESCE(NULLIF(i.ItemNickname,''), i.ItemName)
                         FROM mws_items i WHERE i.ASIN=t.ASIN AND i.SellerID={sid} LIMIT 1),
                        t.ASIN) item, t.ASIN asin,
          SUM(CASE WHEN d BETWEEN '{c[0]}' AND '{c[1]}' THEN zero_day ELSE 0 END) cur_oos,
          SUM(CASE WHEN d BETWEEN '{p[0]}' AND '{p[1]}' THEN zero_day ELSE 0 END) pri_oos
        FROM (
          SELECT h.ASIN, DATE(h.DateTime) d,
            CASE WHEN MAX(h.FulfillableQuantity) <= 0 THEN 1 ELSE 0 END AS zero_day
          FROM mws_inventory_history h
          WHERE h.SellerID={sid}
            AND (h.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR h.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
          GROUP BY h.ASIN, d
        ) t GROUP BY t.ASIN ORDER BY cur_oos DESC
    """, "out of stock days")
    return [{"item": r["item"], "asin": r["asin"],
             "cur_oos_days": i(r["cur_oos"]), "pri_oos_days": i(r["pri_oos"])} for r in rows]


def buybox_by_item(sid, w, min_sales, bb_floor=92.0, bb_drop=5.0):
    """Page-view weighted, and month AND last 7 days.

    The last 7 days column is the one to act on. A monthly average blends a resolved
    problem with the days it was broken: an item that lost the box for two weeks and
    then recovered reads as a persistent 58% problem on a simple month average when it
    is actually fixed. Diagnosing from the month average is how a brief tells a client
    an action item failed when it landed.

    Flags an item when it sits below the floor (month or last 7 days) OR dropped more
    than bb_drop points month over month, so a 99 -> 93 collapse is surfaced even
    though 93 clears the floor. min_sales defaults to the account's median item
    revenue (computed by the caller from the movers rows) so a thin account still
    flags something and a large account does not flag noise.
    """
    c, p, l7 = w["current"], w["prior_month"], w["last7"]

    def pvw(a, b):
        return (f"ROUND(100*SUM(CASE WHEN t.DateTime BETWEEN '{a}' AND '{b}' "
                f"THEN t.BuyBoxPercentage*t.PageViews ELSE 0 END)"
                f"/NULLIF(SUM(CASE WHEN t.DateTime BETWEEN '{a}' AND '{b}' "
                f"THEN t.PageViews ELSE 0 END),0),1)")

    rows = query(f"""
        SELECT {NICK_LOOKUP.format(sid=sid)} AS nickname, t.ChildAsin asin,
          ROUND(SUM(CASE WHEN t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' THEN t.Amount ELSE 0 END),0) cur_sales,
          {pvw(*p)} pri_bb_pvw, {pvw(*c)} cur_bb_pvw, {pvw(*l7)} last7_bb_pvw
        FROM business_reports_dpst_sku t WHERE t.SellerID={sid}
          AND (t.DateTime BETWEEN '{c[0]}' AND '{c[1]}' OR t.DateTime BETWEEN '{p[0]}' AND '{p[1]}')
        GROUP BY t.ChildAsin
        HAVING cur_sales >= {min_sales}
           AND (cur_bb_pvw < {bb_floor} OR last7_bb_pvw < {bb_floor}
                OR (pri_bb_pvw - cur_bb_pvw) >= {bb_drop})
        ORDER BY last7_bb_pvw ASC
    """, "buy box by item")
    out = []
    for r in rows:
        last7 = f(r["last7_bb_pvw"])
        out.append({
            "nickname": r["nickname"], "asin": r["asin"], "cur_sales": f(r["cur_sales"]),
            "pri_bb_pvw": f(r["pri_bb_pvw"]), "cur_bb_pvw": f(r["cur_bb_pvw"]),
            "last7_bb_pvw": last7,
            # No traffic in the last 7 days is not recovery. It usually means the item
            # is out of stock or the listing is suppressed. Do not call it resolved.
            "verdict": ("no_traffic_check_stock" if last7 is None
                        else "still_open" if last7 < 92 else "recovered"),
        })
    return out


def history(sid, months=15):
    start = (dt.date.today().replace(day=1) - dt.timedelta(days=31 * months)).replace(day=1)
    rows = query(f"""
        SELECT DATE_FORMAT(DateTime,'%Y-%m') m, ROUND(SUM(SalesAmount),0) ops,
               SUM(UnitsOrdered) units, SUM(Sessions) sessions, COUNT(*) days
        FROM business_reports_dpst_date WHERE SellerID={sid} AND DateTime >= '{start}'
        GROUP BY m ORDER BY m
    """, "history")
    return [{"month": r["m"], "ops": f(r["ops"]), "units": i(r["units"]),
             "sessions": i(r["sessions"]), "days": i(r["days"])} for r in rows]


# ---------------------------------------------------------------------- main

def main():
    global CLI
    ap = argparse.ArgumentParser(description="Pull the call-brief figure battery (Seller Central).")
    ap.add_argument("--seller-id", type=int, required=True)
    ap.add_argument("--as-of", default=str(dt.date.today()),
                    help="YYYY-MM-DD, defaults to today. Windows still clamp to the data load date.")
    ap.add_argument("--brands", default="",
                    help="Comma separated sub-brand names as they appear in campaign names. "
                         "Without it segment_ads is empty and the split comes from segment_retail only.")
    ap.add_argument("--min-item-sales", type=int, default=None,
                    help="Sales floor for the Buy Box table. Default: the account's median "
                         "item revenue in the current window (reporting.thresholds.sales_floor "
                         "overrides via this flag).")
    ap.add_argument("--buybox-floor", type=float, default=92.0,
                    help="Page-view-weighted Buy Box attention floor, percent (default 92).")
    ap.add_argument("--buybox-drop", type=float, default=5.0,
                    help="MoM drop in weighted Buy Box points that flags an item even above the floor (default 5).")
    ap.add_argument("--out", default="-")
    args = ap.parse_args()

    CLI = find_cli()
    sid = args.seller_id
    brands = [b.strip() for b in args.brands.split(",") if b.strip()]
    w = resolve_windows(sid, dt.date.fromisoformat(args.as_of))

    # One slow table must not cost the whole battery: a 60s gateway timeout on a huge
    # catalog's inventory history is survivable, an empty figures file is not. Each
    # section degrades independently; what failed is recorded, labeled, and printed,
    # and the brief runs on what landed (degrade and label, the skill's own rule).
    failed = {}

    def safe(name, fn, *a, **k):
        try:
            return fn(*a, **k)
        except RuntimeError as e:
            failed[name] = str(e)
            return None

    mov = safe("movers", movers, sid, w)
    floor = args.min_item_sales
    if floor is None:
        # Median item revenue among items that sold this window: the documented
        # default, so thin accounts still flag something and large ones skip noise.
        selling = sorted(x["cur"] for x in (mov or {}).get("items", []) if (x["cur"] or 0) > 0)
        floor = int(selling[len(selling) // 2]) if selling else 0

    result = {
        "seller_id": sid,
        "as_of": args.as_of,
        "windows": w,
        "thresholds_applied": {"sales_floor": floor,
                               "sales_floor_source": ("flag" if args.min_item_sales is not None
                                                      else "median item revenue, current window"),
                               "buybox_floor_pct": args.buybox_floor,
                               "buybox_mom_drop_pts": args.buybox_drop},
        "account_ads": safe("account_ads", account_ads, sid, w),
        "account_retail": safe("account_retail", account_retail, sid, w),
        "dark_days": safe("dark_days", dark_days, sid, w),
        "settled_efficiency_check": safe("settled_efficiency_check", settled_check, sid, w, brands),
        "daily": safe("daily", daily_series, sid, w),
        "segment_ads": safe("segment_ads", segment_ads, sid, w, brands),
        "segment_retail": safe("segment_retail", segment_retail, sid, w),
        "availability_breadth": safe("availability_breadth", availability_breadth, sid, w),
        "movers": mov,
        "oos_days": safe("oos_days", oos_days, sid, w),
        "buybox_by_item": safe("buybox_by_item", buybox_by_item, sid, w, floor, args.buybox_floor, args.buybox_drop),
        "monthly_history": safe("monthly_history", history, sid),
        "sections_failed": failed,
    }
    # Sections that never ran because their inputs failed are labeled, not silent.
    if result["account_ads"] is None or result["account_retail"] is None:
        failed.setdefault("derived_ratios", "skipped: account section missing")
    result["account_ads"] = result["account_ads"] or {}
    result["account_retail"] = result["account_retail"] or {}

    # Derive the ratios and the reconciliation, so the brief never has to.
    for period, ad in result["account_ads"].items():
        rt = result["account_retail"].get(period, {})
        sp_, sa, ops = ad.get("ad_spend"), ad.get("ad_sales"), rt.get("ops")
        ad["acos"] = round(100 * sp_ / sa, 1) if sp_ and sa else None
        ad["tacos"] = round(100 * sp_ / ops, 1) if sp_ and ops else None
        ad["ad_share_of_sales"] = round(100 * sa / ops, 1) if sa and ops else None
        ad["aov"] = round(sa / ad["orders"], 2) if sa and ad.get("orders") else None
        nf = (result["dark_days"] or {}).get(
            {"A_current": "current", "B_prior_month": "prior_month",
             "C_prior_year": "prior_year"}[period], {}).get("normalization_factor")
        if nf and nf != 1 and sp_ and sa:
            ad["ad_spend_normalized"] = round(sp_ * nf, 2)
            ad["ad_sales_normalized"] = round(sa * nf, 2)
            ad["tacos_normalized"] = round(100 * sp_ * nf / ops, 1) if ops else None

    acct_cur = result["account_retail"].get("A_current", {}).get("ops")
    sku_cur = (result["movers"] or {}).get("sum_cur")
    result["reconciliation"] = {
        "account_ops": acct_cur, "sku_sum": sku_cur,
        "gap_pct": round(100 * (sku_cur - acct_cur) / acct_cur, 2) if (acct_cur and sku_cur is not None) else None,
        "note": ("Within about 0.5% is fine. A sum near 2x or 3x means a join multiplied "
                 "rows: use a correlated subquery for the nickname, not JOIN mws_items."),
    }

    text = json.dumps(result, indent=2, default=str)
    if args.out == "-":
        print(text)
    else:
        with open(args.out, "w") as fh:
            fh.write(text)
        print(f"wrote {args.out}")
        rec = result["reconciliation"]
        ao, ss = rec["account_ops"], rec["sku_sum"]
        ao_s = f"${ao:,.0f}" if ao is not None else "n/a"
        ss_s = f"${ss:,.0f}" if ss is not None else "n/a"
        print(f"reconciliation: account {ao_s} vs SKU sum {ss_s} ({rec['gap_pct']}%)")
        for name, why in result["sections_failed"].items():
            print(f"SECTION FAILED (brief runs without it, label the gap): {name}: {why[:140]}")
        dd = result["dark_days"] or {}
        for k, v in dd.items():
            if v["zero_spend_days"]:
                print(f"dark ad days in {k}: {', '.join(v['zero_spend_days'])} "
                      f"(normalize by {v['normalization_factor']})")


if __name__ == "__main__":
    main()
