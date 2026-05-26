import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Archive,
  Brain,
  Clock,
  Download,
  Filter,
  Moon,
  RefreshCcw,
  Search,
  Shield,
  SlidersHorizontal,
  Sun
} from "lucide-react";
import "./styles.css";

const emptyFilters = {
  q: "",
  provider: "",
  cwd: "",
  type: "",
  from: "",
  to: "",
  sort: "time",
  order: "desc"
};

const filterKeys = Object.keys(emptyFilters);
const validSorts = new Set(["time", "events", "provider"]);
const validOrders = new Set(["asc", "desc"]);

function filtersFromSearch(search) {
  const params = new URLSearchParams(search);
  const next = { ...emptyFilters };
  for (const key of filterKeys) {
    const value = params.get(key);
    if (value != null) next[key] = value;
  }
  if (!validSorts.has(next.sort)) next.sort = emptyFilters.sort;
  if (!validOrders.has(next.order)) next.order = emptyFilters.order;
  return next;
}

function qs(params) {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (filterKeys.includes(key) && value !== "" && value != null) out.set(key, value);
  }
  return out.toString();
}

async function api(path, fallback) {
  try {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (error) {
    console.warn("Tracebase API failed", path, error);
    return fallback;
  }
}

function fmt(value) {
  if (!value) return "none";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function sessionTime(session) {
  return session.endedAt || session.updatedAt || session.startedAt;
}

function filenameFromDisposition(value) {
  const match = String(value || "").match(/filename="([^"]+)"/);
  return match ? match[1] : "tracebase-export.zip";
}

function downloadBlob(blob, filename) {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initialTheme() {
  const stored = localStorage.getItem("tracebase-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function App() {
  const [filters, setFilters] = useState(() => filtersFromSearch(location.search));
  const [theme, setTheme] = useState(initialTheme);
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [events, setEvents] = useState([]);
  const [spans, setSpans] = useState([]);
  const [summary, setSummary] = useState(null);
  const [summaryRunners, setSummaryRunners] = useState([]);
  const [active, setActive] = useState("");
  const [rawUnlocked, setRawUnlocked] = useState(false);
  const [summaryRunner, setSummaryRunner] = useState("codex");
  const [busy, setBusy] = useState(false);
  const [lastLoaded, setLastLoaded] = useState(null);
  const loadingRef = useRef(false);
  const filtersRef = useRef(filters);
  const activeRef = useRef(active);

  const providers = useMemo(() => (stats?.byProvider || []).map((row) => row.provider).filter(Boolean), [stats]);
  const types = useMemo(() => (stats?.byType || []).map((row) => row.type).filter(Boolean), [stats]);

  useEffect(() => {
    localStorage.setItem("tracebase-theme", theme);
  }, [theme]);

  useEffect(() => {
    filtersRef.current = filters;
    activeRef.current = active;
  }, [filters, active]);

  async function load(nextFilters = filtersRef.current, nextActive = activeRef.current) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setBusy(true);
    try {
      const query = qs(nextFilters);
      history.replaceState(null, "", query ? `?${query}` : location.pathname);
      const sessionQuery = qs({ ...nextFilters, limit: 200 });
      const [nextStats, nextSessions] = await Promise.all([
        api("/api/stats", null),
        api(`/api/sessions?${sessionQuery}`, [])
      ]);
      const selected = nextSessions.some((session) => session.id === nextActive)
        ? nextActive
        : nextSessions[0]?.id || "";
      const eventQuery = qs({ ...nextFilters, sessionId: selected, limit: 150 });
      const [nextEvents, nextTraces, nextSummary] = await Promise.all([
        selected ? api(`/api/events?${eventQuery}`, []) : [],
        selected ? api(`/api/traces?sessionId=${encodeURIComponent(selected)}&limit=1`, []) : [],
        selected ? api(`/api/summaries/session/${encodeURIComponent(selected)}`, null) : null
      ]);
      const traceId = nextTraces[0]?.id;
      const nextSpans = traceId ? await api(`/api/spans?traceId=${encodeURIComponent(traceId)}&limit=250`, []) : [];
      setStats(nextStats);
      setSessions(nextSessions);
      setActive(selected);
      activeRef.current = selected;
      setEvents(nextEvents);
      setSpans(nextSpans);
      setSummary(nextSummary?.summary ? nextSummary : null);
      setLastLoaded(new Date());
    } finally {
      loadingRef.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
    api("/api/summary-runners", { runners: [] }).then((result) => {
      const runners = result.runners || [];
      setSummaryRunners(runners);
      const firstAvailable = runners.find((runner) => runner.available);
      if (firstAvailable) setSummaryRunner(firstAvailable.runner);
    });
    const timer = setInterval(() => load(filtersRef.current, activeRef.current), 60000);
    return () => clearInterval(timer);
  }, []);

  function updateFilter(key, value) {
    if (!filterKeys.includes(key)) return;
    setFilters((current) => {
      const next = { ...current, [key]: value };
      filtersRef.current = next;
      return next;
    });
  }

  async function summarize() {
    if (!active) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/summaries/session/${encodeURIComponent(active)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runner: summaryRunner })
      });
      const row = await res.json();
      if (!res.ok) throw new Error(row.error || `${res.status} ${res.statusText}`);
      setSummary(row.error ? { summary: row.error } : row);
    } catch (error) {
      setSummary({ summary: `Summary failed: ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function downloadExport(params, raw = false) {
    const query = qs({ ...params, raw: raw ? "1" : "" });
    setBusy(true);
    try {
      const res = await fetch(`/api/export?${query}`, {
        headers: raw ? { "x-tracebase-raw-export": "1" } : {}
      });
      if (!res.ok) throw new Error(await res.text());
      downloadBlob(await res.blob(), filenameFromDisposition(res.headers.get("content-disposition")));
    } catch (error) {
      setSummary({ summary: `Export failed: ${error.message}` });
    } finally {
      setBusy(false);
    }
  }

  async function exportTrace(raw = false) {
    return downloadExport({ ...filters, sessionId: active }, raw);
  }

  async function exportFiltered() {
    return downloadExport(filters, false);
  }

  const selectedRunner = summaryRunners.find((runner) => runner.runner === summaryRunner);
  const summaryUnavailable = selectedRunner?.available === false;
  const summarizeTitle = summaryUnavailable
    ? `${selectedRunner.label} was not found on this machine`
    : `Proxy this session packet to the local ${selectedRunner?.label || summaryRunner} process`;

  return (
    <div className="shell" data-theme={theme}>
      <header className="topbar">
        <div className="brand">
          <Activity size={22} />
          <div>
            <strong>Tracebase</strong>
            <span>local agent trace console</span>
          </div>
        </div>
        <div className="searchbox">
          <Search size={16} />
          <input value={filters.q} onChange={(e) => updateFilter("q", e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search sessions, prompts, tools, files" />
        </div>
        <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")} className="iconButton" title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button onClick={() => load()} className="iconButton" title="Refresh" aria-label="Refresh"><RefreshCcw size={16} /></button>
      </header>

      <section className="toolbar">
        <label><Filter size={14} /> Provider<select value={filters.provider} onChange={(e) => updateFilter("provider", e.target.value)}><option value="">All</option>{providers.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Type<select value={filters.type} onChange={(e) => updateFilter("type", e.target.value)}><option value="">All</option>{types.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label>CWD<input value={filters.cwd} onChange={(e) => updateFilter("cwd", e.target.value)} placeholder="/repo/path" /></label>
        <label>From<input type="datetime-local" value={filters.from} onChange={(e) => updateFilter("from", e.target.value)} /></label>
        <label>To<input type="datetime-local" value={filters.to} onChange={(e) => updateFilter("to", e.target.value)} /></label>
        <label><SlidersHorizontal size={14} /> Sort<select value={filters.sort} onChange={(e) => updateFilter("sort", e.target.value)}><option value="time">Time</option><option value="events">Events</option><option value="provider">Provider</option></select></label>
        <label>Order<select value={filters.order} onChange={(e) => updateFilter("order", e.target.value)}><option value="desc">Newest</option><option value="asc">Oldest</option></select></label>
        <button onClick={() => load()}>Apply</button>
      </section>

      <main className="grid">
        <aside className="sessions">
          <div className="panelTitle"><Clock size={15} /> Sessions <span>{sessions.length}</span></div>
          {sessions.map((session) => (
            <button key={session.id} className={`session ${session.id === active ? "active" : ""}`} onClick={() => load(filters, session.id)}>
              <span>{session.provider}</span>
              <strong>{session.id}</strong>
              <small>{session.cwd || session.project || session.sourcePath || "no cwd"}</small>
              <small>Last {fmt(sessionTime(session))} · {session.eventCount || 0} events</small>
            </button>
          ))}
        </aside>

        <section className="workspace">
          <div className="stats">
            <div><strong>{stats?.eventCount ?? 0}</strong><span>events</span></div>
            <div><strong>{stats?.sessionCount ?? 0}</strong><span>sessions</span></div>
            <div><strong>{stats?.spanCount ?? 0}</strong><span>spans</span></div>
            <div><strong>{fmt(stats?.latestEventAt)}</strong><span>latest</span></div>
            <div className="secure"><Shield size={15} /> local encrypted store</div>
          </div>

          <div className="actions">
            <label className="runner">Runner<select value={summaryRunner} onChange={(e) => setSummaryRunner(e.target.value)}>{(summaryRunners.length ? summaryRunners : [{ runner: "codex", label: "Codex CLI" }, { runner: "claude", label: "Claude CLI" }]).map((runner) => <option key={runner.runner} value={runner.runner}>{runner.label}{runner.available === false ? " unavailable" : ""}</option>)}</select></label>
            <button onClick={summarize} disabled={!active || busy || summaryUnavailable} title={summarizeTitle}><Brain size={16} /> Summarize</button>
            <span className={selectedRunner?.available === false ? "runnerState missing" : "runnerState"}>{selectedRunner ? (selectedRunner.available ? `local ${selectedRunner.runner}` : `${selectedRunner.runner} missing`) : "local CLI"}</span>
            <button onClick={() => exportTrace(false)} disabled={!active || busy}><Download size={16} /> Export session</button>
            <button onClick={exportFiltered}><Download size={16} /> Export filtered</button>
            <label className="unlock"><input type="checkbox" checked={rawUnlocked} onChange={(e) => setRawUnlocked(e.target.checked)} /> unlock raw export</label>
            <button disabled={!active || !rawUnlocked || busy} onClick={() => exportTrace(true)}><Archive size={16} /> Export raw zip</button>
            <span>{busy ? "Loading..." : lastLoaded ? `Updated ${lastLoaded.toLocaleTimeString()}` : ""}</span>
          </div>

          <div className="content">
            <section className="summary">
              <h2>Session Summary</h2>
              <pre>{summary?.summary || "No summary yet. Generate one with Codex CLI or Claude CLI from this machine."}</pre>
            </section>
            <section className="trace">
              <h2>Trace Tree</h2>
              <div className="spanList">{spans.map((span) => <div key={span.id} className="spanRow"><b>{span.spanType}</b><span>{span.name}</span><small>{fmt(span.startTime)}</small></div>)}</div>
            </section>
          </div>

          <section className="events">
            <h2>Events</h2>
            {events.map((event) => (
              <article key={event.id}>
                <div><b>{event.type}</b><span>{event.provider}</span><time>{fmt(event.timestamp)}</time></div>
                <p>{event.summary}</p>
                <pre>{event.searchText}</pre>
              </article>
            ))}
          </section>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
