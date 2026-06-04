"use strict";

/* ============================================================
   Founder Extractor — single-pass (X profile -> LLM fields)

   For each X handle: open x.com/<handle>, scrape the bio/posts/links
   (+ meta description), optionally fall back to a DuckDuckGo search if
   the profile is empty (X login wall), then ask the LLM to fill the
   founder fields. "unknown" is a normal, expected answer.

   NOTE: X blocks logged-out automated views, so many profiles may
   render little. The DuckDuckGo fallback + meta tags are best-effort.
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PORT = parseInt(process.env.PORT || "8080", 10);
const ACCESS_CODE = process.env.ACCESS_CODE || "";
const DATA_DIR = fs.existsSync("/workspace") ? "/workspace" : __dirname;
const RESULTS_FILE = path.join(DATA_DIR, "founder_results.json");
const JOB_FILE = path.join(DATA_DIR, "founder_job.json");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Default search query templates. Placeholders: {name} {handle} {website}
const DEFAULT_QUERIES = [
  '"{name}" founders {website}',
  '"{name}" founder CEO CTO background linkedin',
  '{name} funding raised OR acquired OR "shut down" OR failed',
];

const SYS = `You extract STARTUP FOUNDER data from text scraped from an X (Twitter) profile (bio, posts, links) and possibly web-search snippets. The handle may belong to the COMPANY rather than a person.

Use ONLY the provided text. If the text does not support a field, output "unknown" (or null). Do NOT guess, do NOT infer from the name alone, and NEVER fabricate. Prefer "unknown" over a guess.

Return ONLY this JSON object:
{
  "founder_name": "identified founder name(s) from the text, or unknown",
  "num_founders": 1 | 2 | 3 | null,
  "is_technical": true | false | null,
  "prior_startups": "0" | "1" | "2+" | "unknown",
  "prior_exit": true | false | null,
  "background": "engineer" | "designer" | "marketer" | "sales" | "domain_expert" | "student" | "unknown",
  "full_time": true | false | null,
  "team_size": number 1-50 | null,
  "bootstrapped_vs_funded": "bootstrapped" | "funded" | "unknown",
  "failure_reason": "no_pmf" | "ran_out_of_money" | "cofounder_issues" | "no_distribution" | "competition" | "burnout" | "market_too_small" | "unknown",
  "notes": "<=15 words: evidence used, or note if the handle is the company not a person"
}

Definitions:
- is_technical: true if the person builds/codes or has an engineering background per the text.
- prior_exit: true ONLY if the text mentions selling/acquisition of a previous company.
- full_time: false if it is described as a side project; true if full commitment.
- failure_reason: fill ONLY if the text says the startup failed/shut down; otherwise "unknown".
- If the handle is clearly the company, still fill company-level fields you can (team_size, bootstrapped_vs_funded) and mark person-specific fields "unknown".`;

/* ---------------- state ---------------- */
let RESULTS = loadJson(RESULTS_FILE, {});
let JOB = loadJson(JOB_FILE, { handles: [] });
let CFG = null;
let running = false;
let stopRequested = false;
let stopController = null;
let _rlLast = 0;

/* ---------------- utils ---------------- */
function loadJson(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function saveResults() { try { fs.writeFileSync(RESULTS_FILE, JSON.stringify(RESULTS)); } catch {} }
function saveJob() { try { fs.writeFileSync(JOB_FILE, JSON.stringify(JOB)); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normHandle(line) {
  let s = String(line || "").trim();
  if (!s || s.startsWith("#")) return null;
  // accept full URLs, @handle, or bare handle
  const m = s.match(/(?:x\.com|twitter\.com)\/(@?[A-Za-z0-9_]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "").replace(/\/.*$/, "");
  if (!/^[A-Za-z0-9_]{1,30}$/.test(s)) return null;
  return s;
}
function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const x of arr) { const h = normHandle(x); if (h && !seen.has(h.toLowerCase())) { seen.add(h.toLowerCase()); out.push(h); } }
  return out;
}
// Accept lines that are either a bare handle, or "name, website, handle" (comma or tab separated).
// We detect the handle as the field that looks like an x.com handle/URL; the rest map to name/website.
function parseRecords(lines) {
  const seen = new Set(), out = [];
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line || line.startsWith("#")) continue;
    const cols = line.split(/\t|,/).map((s) => s.trim()).filter(Boolean);
    let handle = null, website = "", name = "";
    // Prefer a column that is explicitly an X handle: starts with @, or is an x.com/twitter.com URL.
    for (const c of cols) {
      if ((/^@/.test(c) || /(?:x\.com|twitter\.com)\//i.test(c))) { const h = normHandle(c); if (h) { handle = h; break; } }
    }
    // If none explicit, and there is only ONE column, treat it as the handle (bare-handle input).
    if (!handle && cols.length === 1) handle = normHandle(cols[0]);
    // Still none? fall back to the first handle-shaped column.
    if (!handle) { for (const c of cols) { const h = normHandle(c); if (h) { handle = h; break; } } }
    if (!handle) continue;
    // website = a column with a dot/URL (but not the chosen handle's source); name = a remaining non-URL column
    for (const c of cols) {
      const ch = normHandle(c);
      if ((/^@/.test(c) || /(?:x\.com|twitter\.com)\//i.test(c)) && ch === handle) continue;
      if (/^https?:\/\//i.test(c) || /\.[a-z]{2,}($|\/)/i.test(c)) { if (!website) website = c; }
      else if (c.toLowerCase() !== handle.toLowerCase() && !name) name = c;
    }
    if (seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, name, website });
  }
  return out;
}

/* ---------------- rate limiter ---------------- */
async function rateGate() {
  const rpm = (CFG && parseInt(CFG.rpm, 10)) || 0;
  if (!rpm) return;
  const minGap = Math.ceil(60000 / rpm);
  const now = Date.now();
  let wait = Math.max(0, _rlLast + minGap - now);
  _rlLast = Math.max(now, _rlLast + minGap);
  while (wait > 0 && !stopRequested) { const s = Math.min(250, wait); await sleep(s); wait -= s; }
}

/* ---------------- LLM ---------------- */
async function llmChat(messages, useJsonMode, attempt, noFast) {
  attempt = attempt || 1;
  await rateGate();
  const body = { model: CFG.model, messages, temperature: 0, max_tokens: 700 };
  if (useJsonMode) body.response_format = { type: "json_object" };
  if (!noFast) {
    const want = CFG.reasoningEffort && CFG.reasoningEffort !== "none" ? CFG.reasoningEffort : null;
    if (CFG.fast) {
      const on = !!want;
      body.chat_template_kwargs = { thinking: on, enable_thinking: on };
      if (want) body.chat_template_kwargs.reasoning_effort = want;
      body.include_reasoning = false;
    } else if (want) {
      body.chat_template_kwargs = { thinking: true, enable_thinking: true, reasoning_effort: want };
    }
    if (want) body.reasoning_effort = want;
  }
  if (stopRequested) throw new Error("stopped");
  let res;
  try {
    res = await fetch(CFG.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + CFG.apiKey },
      body: JSON.stringify(body),
      signal: stopController ? stopController.signal : undefined,
    });
  } catch (e) {
    if (stopRequested) throw new Error("stopped");
    if (attempt <= 4) { await sleep(1500 * attempt); return llmChat(messages, useJsonMode, attempt + 1, noFast); }
    throw e;
  }
  if (!res.ok) {
    const t = (await res.text()).slice(0, 200);
    if (stopRequested) throw new Error("stopped");
    if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
      const ra = parseInt(res.headers.get("retry-after") || "0", 10);
      await sleep(ra > 0 ? ra * 1000 : Math.min(30000, 2000 * Math.pow(2, attempt - 1)));
      return llmChat(messages, useJsonMode, attempt + 1, noFast);
    }
    if ((CFG.fast || CFG.reasoningEffort) && !noFast && /chat_template_kwargs|enable_thinking|include_reasoning|reasoning_effort|unexpected|unknown|unsupported|invalid|400/i.test(t)) {
      return llmChat(messages, useJsonMode, attempt, true);
    }
    if (useJsonMode && /response_format|json|400|unsupported|invalid/i.test(t)) {
      return llmChat(messages, false, attempt, noFast);
    }
    throw new Error(res.status + ": " + t);
  }
  const data = await res.json();
  return String(data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "{}");
}
function parseJson(raw) {
  let c = String(raw).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(c); } catch {}
  const i = c.indexOf("{"), j = c.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(c.slice(i, j + 1)); } catch {} }
  return null;
}

/* ---------------- scraping ---------------- */
async function fetchProfile(browser, url) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
    await page.waitForTimeout(2200);
    const d = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : "";
      const metas = {};
      document.querySelectorAll("meta").forEach((m) => {
        const k = (m.getAttribute("property") || m.getAttribute("name") || "");
        if (/description|title|og:/i.test(k) && m.content) metas[k] = m.content;
      });
      const links = [...new Set([...document.querySelectorAll("a[href]")].map((a) => a.href)
        .filter((h) => /^https?:/.test(h) && !/x\.com|twitter\.com/i.test(h)))].slice(0, 30);
      return { t, metas, links, title: document.title };
    });
    return { text: (d.t || "").slice(0, 6000), metas: d.metas || {}, links: d.links || [], title: d.title || "", finalUrl: page.url() };
  } finally { await ctx.close().catch(() => {}); }
}
async function searxng(query) {
  // Query local SearXNG JSON API. Returns { text, urls }.
  const base = (CFG.searxngUrl || "http://localhost:8890").replace(/\/+$/, "");
  const u = base + "/search?q=" + encodeURIComponent(query) + "&format=json";
  try {
    const r = await fetch(u, { signal: stopController ? stopController.signal : undefined });
    if (!r.ok) return { text: "", urls: [] };
    const j = await r.json();
    const top = (j.results || []).slice(0, 8);
    const rows = top.map((x) => "- " + (x.title || "").trim() + " — " + (x.content || "").trim() + " (" + (x.url || "").trim() + ")");
    const urls = top.slice(0, 5).map((x) => (x.url || "").trim()).filter(Boolean);
    return { text: rows.join("\n"), urls };
  } catch { return { text: "", urls: [] }; }
}

// Open an article URL and scrape its readable text (for full story/interview pages).
const SKIP_FETCH = /linkedin\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|youtube\.com|\.pdf($|\?)/i;
async function fetchArticle(browser, articleUrl) {
  if (!articleUrl || SKIP_FETCH.test(articleUrl)) return "";
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
    await page.waitForTimeout(700);
    // Prefer the main article text; fall back to body.
    const txt = await page.evaluate(() => {
      const pick = document.querySelector("article") || document.querySelector("main") || document.body;
      return pick ? pick.innerText : "";
    });
    return (txt || "").replace(/\n{3,}/g, "\n\n").slice(0, 4000);
  } catch { return ""; } finally { await ctx.close().catch(() => {}); }
}

// Visit the company website, find an About/Story/Team/Founders page, scrape its text.
async function fetchAboutPage(browser, website) {
  let site = String(website).trim();
  if (!/^https?:\/\//i.test(site)) site = "https://" + site;
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    // If the given URL already points at an about/story path, just read it.
    const direct = /\/(about|story|team|founders|company|our-story|mission)/i.test(site);
    if (!direct) {
      await page.goto(site, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
      await page.waitForTimeout(900);
      const link = await page.evaluate(() => {
        const want = /(our[\s-]?story|about[\s-]?us|about|story|team|founders|company|mission|who[\s-]?we[\s-]?are)/i;
        const as = [...document.querySelectorAll("a[href]")];
        // prefer story/about, then team/founders
        const score = (s) => /our[\s-]?story|story/i.test(s) ? 4 : /about/i.test(s) ? 3 : /founders|team/i.test(s) ? 2 : /company|mission|who/i.test(s) ? 1 : 0;
        let best = null, bestScore = 0;
        for (const a of as) {
          const tt = (a.textContent || "") + " " + (a.getAttribute("href") || "");
          if (!want.test(tt)) continue;
          const sc = score(tt);
          if (sc > bestScore) { bestScore = sc; best = a.href; }
        }
        return best;
      });
      if (link) { await page.goto(link, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs }); await page.waitForTimeout(700); }
    } else {
      await page.goto(site, { waitUntil: "domcontentloaded", timeout: CFG.timeoutMs });
      await page.waitForTimeout(900);
    }
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : "").slice(0, 4500));
    return { text: txt || "", url: page.url() };
  } catch { return { text: "", url: "" }; } finally { await ctx.close().catch(() => {}); }
}

/* ---------------- per-handle pipeline ---------------- */
const FIELDS = ["handle","founder_name","num_founders","is_technical","prior_startups","prior_exit",
  "background","full_time","team_size","bootstrapped_vs_funded","failure_reason","source","sources","notes","status"];

function blankRow(handle, status, notes) {
  const r = { handle }; FIELDS.forEach((f) => { if (!(f in r)) r[f] = ""; });
  r.status = status; r.notes = notes || ""; return r;
}

function finalizeRow(handle, o, source, sources) {
  const g = (k, d) => (o && o[k] != null ? o[k] : d);
  return {
    handle,
    founder_name: g("founder_name", "unknown"),
    num_founders: g("num_founders", ""),
    is_technical: typeof g("is_technical", null) === "boolean" ? o.is_technical : "",
    prior_startups: g("prior_startups", "unknown"),
    prior_exit: typeof g("prior_exit", null) === "boolean" ? o.prior_exit : "",
    background: g("background", "unknown"),
    full_time: typeof g("full_time", null) === "boolean" ? o.full_time : "",
    team_size: g("team_size", ""),
    bootstrapped_vs_funded: g("bootstrapped_vs_funded", "unknown"),
    failure_reason: g("failure_reason", "unknown"),
    source: source,
    sources: (sources || []).join(" ; "),
    notes: g("notes", ""),
    status: "ok",
  };
}

// Fill a query template: {name} -> name (or handle if no name), {handle}, {website}
function renderQuery(tpl, name, handle, website) {
  const subj = name || handle || "";
  return String(tpl)
    .replace(/\{name\}/gi, subj)
    .replace(/\{handle\}/gi, handle || "")
    .replace(/\{website\}/gi, website || "")
    .replace(/\s+/g, " ").trim();
}

async function processHandle(browser, rec) {
  // rec may be a bare handle string or { handle, name, website }
  const handle = typeof rec === "string" ? rec : rec.handle;
  const name = (typeof rec === "object" && rec.name) ? rec.name : "";
  const website = (typeof rec === "object" && rec.website) ? rec.website : "";
  const url = "https://x.com/" + handle;

  // Nothing meaningful to search with -> don't waste a query.
  if (!name && !website && !handle) return blankRow(handle, "empty", "no name/website/handle to search");

  const parts = [];
  let source = [];
  const srcUrls = [];

  // 1) SEARCH FIRST via SearXNG, using the configurable query templates.
  const candidateUrls = [];
  if (CFG.useSearch) {
    const tpls = (CFG.queries && CFG.queries.length) ? CFG.queries : DEFAULT_QUERIES;
    let qi = 0;
    for (const tpl of tpls) {
      if (stopRequested) break;
      const q = renderQuery(tpl, name, handle, website);
      if (!q) continue;
      const r = await searxng(q);
      if (r.text && r.text.length > 40) {
        parts.push("WEB SEARCH [" + q + "]:\n" + r.text);
        srcUrls.push(...r.urls);
        candidateUrls.push(...r.urls);
        if (!source.includes("search")) source.push("search");
      }
      qi++;
      if (qi < tpls.length) await sleep(CFG.searchDelayMs || 1200); // pace between queries
    }
  }
  if (stopRequested) return blankRow(handle, "stopped", "stopped");

  // 1b) Open the top few story/article URLs and read their FULL text (richer than snippets).
  const nFetch = Math.max(0, Math.min(5, parseInt(CFG.fetchArticles, 10) || 0));
  if (nFetch > 0 && candidateUrls.length) {
    const seen = new Set();
    const toFetch = [];
    for (const cu of candidateUrls) {
      if (SKIP_FETCH.test(cu)) continue;
      const key = cu.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key); toFetch.push(cu);
      if (toFetch.length >= nFetch) break;
    }
    for (const au of toFetch) {
      if (stopRequested) break;
      const art = await fetchArticle(browser, au);
      if (art && art.replace(/\s/g, "").length > 200) {
        parts.push("ARTICLE (" + au + "):\n" + art);
        if (!source.includes("article")) source.push("article");
        // already in srcUrls via candidateUrls
      }
    }
  }
  if (stopRequested) return blankRow(handle, "stopped", "stopped");

  // 2) Company About/Story page (when a website is given and the option is on).
  if (CFG.fetchAbout && website) {
    const ab = await fetchAboutPage(browser, website);
    if (ab.text && ab.text.replace(/\s/g, "").length > 80) {
      parts.push("COMPANY ABOUT/STORY PAGE (" + ab.url + "):\n" + ab.text);
      if (ab.url) srcUrls.push(ab.url);
      if (!source.includes("about_page")) source.push("about_page");
    }
  }
  if (stopRequested) return blankRow(handle, "stopped", "stopped");

  // 3) Try the X profile as corroboration (often login-walled; best-effort).
  try {
    const prof = await fetchProfile(browser, url);
    const ptxt = (prof.text || "").replace(/\s/g, "");
    if (ptxt.length > 30 || Object.keys(prof.metas).length) {
      parts.push("X PROFILE: " + url + "\nTITLE: " + prof.title +
        "\nBIO / META: " + Object.values(prof.metas).join(" | ") +
        "\nLINKS: " + prof.links.join(", ") +
        "\nVISIBLE TEXT:\n" + prof.text.slice(0, 3000));
      source.push("x_profile");
      srcUrls.push(url);
    }
  } catch {}
  if (stopRequested) return blankRow(handle, "stopped", "stopped");

  let blob = (website ? "STARTUP WEBSITE: " + website + "\n" : "") +
    (name ? "STARTUP NAME: " + name + "\n" : "") + parts.join("\n\n");

  const sources = [...new Set(srcUrls)].slice(0, 12);

  if (blob.replace(/\s/g, "").length < 120) {
    return blankRow(handle, "empty", "no usable info from search/about/profile");
  }
  try {
    const raw = await llmChat([{ role: "system", content: SYS }, { role: "user", content: blob.slice(0, 13000) }], true);
    const o = parseJson(raw);
    if (!o) { const b = blankRow(handle, "unknown", "could not parse model output"); b.sources = sources.join(" ; "); return b; }
    return finalizeRow(handle, o, source.join("+") || "none", sources);
  } catch (e) {
    const m = String(e && e.message ? e.message : e);
    if (stopRequested || /stopped|abort/i.test(m)) return blankRow(handle, "stopped", "stopped");
    const b = blankRow(handle, "error", m.slice(0, 90)); b.sources = sources.join(" ; "); return b;
  }
}

/* ---------------- job runner ---------------- */
async function runJob(records) {
  running = true; stopRequested = false; stopController = new AbortController();
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
    let i = 0;
    const worker = async () => {
      while (i < records.length && !stopRequested) {
        const rec = records[i++];
        const r = await processHandle(browser, rec);
        if (r.status === "stopped") continue;
        RESULTS[rec.handle] = r; saveResults();
      }
    };
    const n = Math.max(1, Math.min(6, parseInt(CFG.concurrency, 10) || 2));
    await Promise.all(Array.from({ length: n }, worker));
  } catch (e) { console.error("Job error:", e); }
  finally {
    if (browser) await browser.close().catch(() => {});
    running = false;
    console.log("Job finished. Processed:", Object.keys(RESULTS).length);
  }
}

/* ---------------- HTTP ---------------- */
function authOK(req) { if (!ACCESS_CODE) return true; return (req.headers["x-access-code"] || "") === ACCESS_CODE; }
function send(res, c, t, b) { res.writeHead(c, { "Content-Type": t, "Cache-Control": "no-store" }); res.end(b); }
function sendJson(res, c, o) { send(res, c, "application/json", JSON.stringify(o)); }
function readBody(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); }); }
function counts() {
  const v = Object.values(RESULTS);
  return { processed: v.length, ok: v.filter((r) => r.status === "ok").length,
    empty: v.filter((r) => r.status === "empty").length, errors: v.filter((r) => r.status === "error").length };
}
function csvCell(v) { if (v === null || v === undefined) return ""; const s = String(v).replace(/"/g, '""'); return /[",\n]/.test(s) ? '"' + s + '"' : s; }
function buildCsv() {
  const rows = [FIELDS];
  for (const r of Object.values(RESULTS)) rows.push(FIELDS.map((f) => r[f]));
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  if (p === "/" || p === "/index.html") return send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
  if (p.startsWith("/api/") && !authOK(req)) return sendJson(res, 401, { error: "bad access code" });

  if (p === "/api/status" && req.method === "GET") {
    const recent = Object.values(RESULTS).slice(-150).reverse();
    return sendJson(res, 200, { running, total: JOB.handles.length, ...counts(), recent, needCode: !!ACCESS_CODE, savedHandles: JOB.handles.join("\n") });
  }
  if (p === "/api/start" && req.method === "POST") {
    if (running) return sendJson(res, 409, { error: "already running" });
    const b = await readBody(req);
    if (!b.apiKey) return sendJson(res, 400, { error: "missing apiKey" });
    let records = parseRecords(Array.isArray(b.handles) ? b.handles : String(b.handles || "").split(/\r?\n/));
    if (!records.length) return sendJson(res, 400, { error: "no handles" });
    CFG = {
      apiKey: b.apiKey, model: b.model || "deepseek-ai/deepseek-v4-flash",
      endpoint: b.endpoint || "https://integrate.api.nvidia.com/v1/chat/completions",
      concurrency: b.concurrency || 2, timeoutMs: (parseInt(b.timeout, 10) || 20) * 1000,
      rpm: Math.max(0, parseInt(b.rpm, 10) || 0),
      fast: b.fast !== false,
      reasoningEffort: ["low","medium","high","none"].includes(String(b.reasoningEffort)) ? String(b.reasoningEffort) : "",
      useSearch: b.useSearch !== false,
      searxngUrl: (b.searxngUrl && String(b.searxngUrl).trim()) || "http://localhost:8890",
      searchDelayMs: 1200,
      fetchAbout: b.fetchAbout !== false,
      fetchArticles: Math.max(0, Math.min(5, parseInt(b.fetchArticles, 10) || 0)),
      queries: (Array.isArray(b.queries) ? b.queries : String(b.queries || "").split(/\r?\n/))
        .map((s) => String(s).trim()).filter(Boolean).slice(0, 6),
    };
    JOB = { handles: records.map((r) => r.handle) }; saveJob();
    let todo = records;
    if (b.resume !== false) todo = records.filter((r) => !(RESULTS[r.handle] && RESULTS[r.handle].status !== "error" && RESULTS[r.handle].status !== "empty"));
    if (!todo.length) return sendJson(res, 200, { ok: true, note: "nothing to do (all done)" });
    runJob(todo);
    return sendJson(res, 200, { ok: true, queued: todo.length });
  }
  if (p === "/api/stop" && req.method === "POST") { stopRequested = true; try { if (stopController) stopController.abort(); } catch {} return sendJson(res, 200, { ok: true }); }
  if (p === "/api/clear" && req.method === "POST") { if (running) return sendJson(res, 409, { error: "stop first" }); RESULTS = {}; saveResults(); return sendJson(res, 200, { ok: true }); }
  if (p === "/api/download" && req.method === "GET") {
    if (ACCESS_CODE && u.searchParams.get("code") !== ACCESS_CODE) return sendJson(res, 401, { error: "bad access code" });
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="founder_results.csv"' });
    return res.end(buildCsv());
  }
  send(res, 404, "text/plain", "not found");
});
server.listen(PORT, "0.0.0.0", () => {
  console.log("============================================");
  console.log(" Founder Extractor ready on port " + PORT);
  console.log(" Data dir: " + DATA_DIR + " | Access: " + (ACCESS_CODE ? "ON" : "off"));
  console.log("============================================");
});

/* ---------------- web page ---------------- */
const PAGE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Founder Extractor</title>
<style>
:root{--bg:#0f1216;--panel:#161b22;--panel2:#1c232c;--line:#2b3440;--ink:#e6edf3;--muted:#8b98a8;--accent:#5db0f0;--accentd:#3d7fb8;--green:#7bbf6a;--red:#d9695a;--gray:#6b7685;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,rgba(93,176,240,.07),transparent 60%),var(--bg);color:var(--ink);font-family:var(--mono);font-size:13px;line-height:1.45}
.wrap{max-width:1240px;margin:0 auto;padding:22px 26px 80px}
header{display:flex;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:22px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
h1{font-size:15px;letter-spacing:2px;text-transform:uppercase;margin:0;font-weight:700}
.sub{color:var(--muted);font-size:11px;letter-spacing:1px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);padding:16px}
.panel h2{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin:0 0 14px;font-weight:700}
label{display:block;color:var(--muted);font-size:11px;letter-spacing:1px;margin:12px 0 5px;text-transform:uppercase}label:first-of-type{margin-top:0}
input,select,textarea{width:100%;background:var(--panel2);color:var(--ink);border:1px solid var(--line);padding:9px 10px;font-family:var(--mono);font-size:13px;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accentd)}
textarea{resize:vertical;min-height:220px;white-space:pre;overflow-x:auto}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.checks{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.checks label{display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;color:var(--ink);margin:0;font-size:12px}.checks input{width:auto}
.actions{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button{font-family:var(--mono);font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;border:1px solid var(--line);background:var(--panel2);color:var(--ink);cursor:pointer}
button:hover:not(:disabled){border-color:var(--accentd);color:#fff}button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--accent);color:#0a0f14;border-color:var(--accent);font-weight:700}button.primary:hover:not(:disabled){background:#7cc1f5}
button.danger{color:var(--red);border-color:#5a3530}button.ghost{background:transparent}
.status{display:flex;align-items:center;gap:18px;margin:22px 0 12px;border:1px solid var(--line);background:var(--panel);padding:12px 16px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column}.stat .n{font-size:18px;font-weight:700}.stat .l{font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.n.ok{color:var(--green)}.n.err{color:var(--red)}.n.empty{color:var(--gray)}.n.run{color:var(--accent)}
.barwrap{flex:1;min-width:160px;height:8px;background:var(--panel2);border:1px solid var(--line);overflow:hidden}.barfill{height:100%;width:0;background:linear-gradient(90deg,var(--accentd),var(--accent));transition:width .3s}
table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11.5px}
thead th{position:sticky;top:0;background:var(--panel2);color:var(--accent);text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);font-size:9.5px;letter-spacing:.5px;text-transform:uppercase}
tbody td{padding:6px 8px;border-bottom:1px solid #20272f;vertical-align:top;white-space:nowrap}tbody tr:hover{background:#161d25}
td.h{color:var(--accent)}td.notes{color:var(--muted);max-width:200px;white-space:normal}
.bt{color:var(--green)}.bf{color:var(--gray)}
.tablewrap{max-height:55vh;overflow:auto;border:1px solid var(--line);margin-top:8px}
.hint{color:var(--muted);font-size:11px;margin-top:6px}.empty{color:var(--muted);padding:26px;text-align:center}
.warn{background:#241a14;border:1px solid #5a4530;color:#e8b87a;padding:10px 12px;font-size:11.5px;margin-bottom:16px}
</style></head><body><div class="wrap">
<header><span class="dot"></span><h1>Founder Extractor</h1><span class="sub">// X profile -> LLM fields</span></header>
<div class="warn">Searches the web (via your SearXNG) for each startup, then also checks the X profile if reachable, and the LLM fills what it can. Fields with no public info come back "unknown" — that's expected, especially prior_exit / failure_reason.</div>
<div class="grid">
 <div class="panel"><h2>Configuration</h2>
  <label>API Key</label><input type="password" id="apiKey" placeholder="nvapi-... or sk-..." autocomplete="off"/>
  <div id="codeWrap" style="display:none"><label>Access Code</label><input type="password" id="code"/></div>
  <label>Model string</label><input type="text" id="model" value="deepseek-ai/deepseek-v4-flash"/>
  <label>Endpoint</label><input type="text" id="endpoint" value="https://integrate.api.nvidia.com/v1/chat/completions"/>
  <label>SearXNG URL</label><input type="text" id="searxngUrl" value="http://localhost:8890"/>
  <div class="row3"><div><label>Handles at once</label><input type="text" id="concurrency" value="2"/></div><div><label>Page timeout (s)</label><input type="text" id="timeout" value="20"/></div><div><label>Rate (calls/min)</label><input type="text" id="rpm" value="40"/></div></div>
  <div class="row2"><div><label>Reasoning effort</label><select id="reasoningEffort"><option value="">provider default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="none">none</option></select></div><div><label>Open top N articles (full text)</label><select id="fetchArticles"><option value="0">0 — snippets only (fastest)</option><option value="2" selected>2 — read top 2 articles</option><option value="3">3</option><option value="4">4</option></select></div></div>
  <div class="checks">
   <label><input type="checkbox" id="fast" checked/> Fast mode (no thinking)</label>
   <label><input type="checkbox" id="useSearch" checked/> Web search (SearXNG) — search first for each startup</label>
   <label><input type="checkbox" id="fetchAbout" checked/> Read company About/Story page (when a website is given)</label>
   <label><input type="checkbox" id="resume" checked/> Resume — skip handles already done</label>
  </div>
  <label>Search queries — one per line. Placeholders: {name} {handle} {website}</label>
  <textarea id="queries" style="min-height:90px" placeholder='"{name}" founders {website}'>"{name}" founders {website}
"{name}" founder CEO CTO background linkedin
{name} funding raised OR acquired OR "shut down" OR failed</textarea>
 </div>
 <div class="panel"><h2>Startups — one per line</h2><label>Paste handle, or "name, website, handle" (comma/tab separated)</label>
  <textarea id="handles" placeholder="Stripe, stripe.com, @stripe&#10;naval&#10;Levels.io, levels.io, https://x.com/levelsio"></textarea>
  <p class="hint"><span id="cnt">0</span> handles detected.</p>
 </div>
</div>
<div class="actions"><button class="primary" id="startBtn">▶ Start</button><button class="danger" id="stopBtn" disabled>■ Stop</button><button class="ghost" id="dlBtn">⬇ Download CSV</button><button class="ghost" id="clearBtn">✕ Clear</button></div>
<div class="status">
 <div class="stat"><span class="n" id="sTotal">0</span><span class="l">Total</span></div>
 <div class="stat"><span class="n ok" id="sOk">0</span><span class="l">Got data</span></div>
 <div class="stat"><span class="n empty" id="sEmpty">0</span><span class="l">Empty</span></div>
 <div class="stat"><span class="n err" id="sErr">0</span><span class="l">Errors</span></div>
 <div class="stat"><span class="n run" id="sRun">idle</span><span class="l">State</span></div>
 <div class="barwrap"><div class="barfill" id="bar"></div></div>
 <div class="stat"><span class="n" id="sPct">0%</span><span class="l">Progress</span></div>
</div>
<div class="tablewrap"><table><thead><tr>
<th>Handle</th><th>Founder</th><th>#</th><th>Tech</th><th>Prior</th><th>Exit</th><th>Background</th><th>FT</th><th>Team</th><th>Funding</th><th>Fail reason</th><th>Src</th><th>Sources</th><th>Notes</th>
</tr></thead><tbody id="tbody"><tr><td colspan="14" class="empty">No results yet. Add your key, paste handles, hit Start.</td></tr></tbody></table></div>
</div>
<script>
const $=(id)=>document.getElementById(id);
function code(){return $("code")?$("code").value.trim():""}
function headers(){const h={"Content-Type":"application/json"};const c=code();if(c)h["x-access-code"]=c;return h}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function bool(v){return v===true?'<span class="bt">true</span>':v===false?'<span class="bf">false</span>':'<span class="bf">—</span>'}
function dash(v){return (v===""||v==null)?"—":esc(String(v))}
function cnt(){$("cnt").textContent=$("handles").value.split(/\\r?\\n/).map(s=>s.trim()).filter(Boolean).length}
$("handles").addEventListener("input",cnt);
async function start(){
 if(!$("apiKey").value.trim()){alert("Enter your API key.");return}
 const body={apiKey:$("apiKey").value.trim(),model:$("model").value.trim(),endpoint:$("endpoint").value.trim(),
  concurrency:$("concurrency").value,timeout:$("timeout").value,rpm:$("rpm").value,reasoningEffort:$("reasoningEffort").value,searxngUrl:$("searxngUrl").value.trim(),
  fast:$("fast").checked,useSearch:$("useSearch").checked,fetchAbout:$("fetchAbout").checked,fetchArticles:$("fetchArticles").value,queries:$("queries").value.split(/\\r?\\n/),resume:$("resume").checked,handles:$("handles").value.split(/\\r?\\n/)};
 const r=await fetch("/api/start",{method:"POST",headers:headers(),body:JSON.stringify(body)});
 const j=await r.json(); if(!r.ok){alert("Could not start: "+(j.error||r.status));return} if(j.note)alert(j.note);
}
async function stop(){await fetch("/api/stop",{method:"POST",headers:headers()})}
async function clearAll(){if(!confirm("Clear all results?"))return;const r=await fetch("/api/clear",{method:"POST",headers:headers()});if(!r.ok){const j=await r.json();alert(j.error||"failed")}}
function dl(){const c=code();window.location="/api/download"+(c?"?code="+encodeURIComponent(c):"")}
$("startBtn").onclick=start;$("stopBtn").onclick=stop;$("clearBtn").onclick=clearAll;$("dlBtn").onclick=dl;
let first=true;
async function poll(){
 try{
  const r=await fetch("/api/status",{headers:headers()});
  if(r.status===401){$("codeWrap").style.display="block";return}
  const s=await r.json();
  if(s.needCode)$("codeWrap").style.display="block";
  if(first&&s.savedHandles&&!$("handles").value.trim()){$("handles").value=s.savedHandles;cnt()}
  first=false;
  $("sTotal").textContent=s.total;$("sOk").textContent=s.ok;$("sEmpty").textContent=s.empty;$("sErr").textContent=s.errors;
  $("sRun").textContent=s.running?"RUN":"idle";$("sRun").className="n "+(s.running?"run":"");
  const pct=s.total?Math.round(s.processed/s.total*100):0;$("sPct").textContent=pct+"%";$("bar").style.width=pct+"%";
  $("startBtn").disabled=s.running;$("stopBtn").disabled=!s.running;
  const tb=$("tbody");
  if(!s.recent||!s.recent.length){if(!tb.querySelector(".empty"))tb.innerHTML='<tr><td colspan="14" class="empty">No results yet.</td></tr>';}
  else{tb.innerHTML=s.recent.map(x=>'<tr><td class="h">@'+esc(x.handle)+'</td><td>'+dash(x.founder_name)+'</td><td>'+dash(x.num_founders)+'</td><td>'+bool(x.is_technical)+'</td><td>'+dash(x.prior_startups)+'</td><td>'+bool(x.prior_exit)+'</td><td>'+dash(x.background)+'</td><td>'+bool(x.full_time)+'</td><td>'+dash(x.team_size)+'</td><td>'+dash(x.bootstrapped_vs_funded)+'</td><td>'+dash(x.failure_reason)+'</td><td>'+dash(x.source)+'</td><td class="notes" title="'+esc(x.sources||"")+'">'+esc((x.sources||"").split(" ; ").filter(Boolean).length+" link(s)")+'</td><td class="notes">'+esc(x.notes||"")+'</td></tr>').join("")}
 }catch(e){}
}
setInterval(poll,1800);poll();
</script></body></html>`;
