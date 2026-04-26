"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RunManifest } from "@/lib/runs";
import type { Brief, ItemDecision } from "@/lib/buy-planner";

const LIVE_LIMIT = 4;
const LIVE_CONCURRENCY = 4;

type LoadState = "idle" | "loading" | "loaded" | "error";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

type ExtractionRow = { commodity: string; cost: number | null; raw_row_text: string };
type ExtractionDoc = {
  doc_id: string;
  supplier: string;
  date: string;
  format: string;
  row_count: number;
  rows: ExtractionRow[];
  duration_ms?: number;
  error?: string;
};

type ViewerState =
  | { kind: "extraction"; title: string; doc_id: string }
  | { kind: "chat-log"; title: string; filename: string; asof: string }
  | null;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const HERO_TILES: Array<{ title: string; body: string }> = [
  {
    title: "Reads every price list",
    body: "20+ suppliers, every PDF, scan, txt, and CSV. Opus 4.7 vision turns the daily 40-hour parsing job into seconds, normalized to one commodity index.",
  },
  {
    title: "Remembers every conversation",
    body: "The agent re-reads the last 14 days of iMessages with each supplier — and won't pick from a lot you just rejected, a price that's quietly drifted, or a SKU that was shorted yesterday.",
  },
  {
    title: "Decides per item, in parallel",
    body: "One Claude session per order line, fanned out via a small custom MCP toolset (find_commodity, get_offerings, get_supplier_chats, get_price_history). 80 buying decisions, ~10 min of agent time.",
  },
  {
    title: "Drafts the messages, ready to send",
    body: "Picks grouped by supplier and rendered as iMessage-ready text — name, qty, pack, locked-in price, plus any open questions. Click copy, paste, hit send.",
  },
];

function Hero() {
  return (
    <section className="mb-6">
      <div
        className="rounded-lg border p-5"
        style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
      >
        <div className="mb-4">
          <div
            className="text-xs uppercase tracking-wider mb-1"
            style={{ color: "var(--accent)" }}
          >
            What BuyOps unlocks
          </div>
          <p className="text-sm" style={{ color: "var(--text)" }}>
            A produce wholesaler buys 80–100 line items across 17+ suppliers every
            morning. The price lists are PDFs, the relationships live in iMessage,
            and the whole loop runs on tribal knowledge.{" "}
            <span style={{ color: "var(--accent)" }}>BuyOps</span> hands the
            morning to an Opus 4.7 agent team.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {HERO_TILES.map((t) => (
            <div
              key={t.title}
              className="rounded border p-3"
              style={{ background: "var(--bg)", borderColor: "var(--border)" }}
            >
              <div
                className="text-sm font-medium mb-1"
                style={{ color: "var(--accent)" }}
              >
                {t.title}
              </div>
              <div className="text-xs leading-relaxed" style={{ color: "var(--text-dim)" }}>
                {t.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Page() {
  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [days, setDays] = useState<string[]>([]);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [viewer, setViewer] = useState<ViewerState>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [briefState, setBriefState] = useState<LoadState>("idle");
  const [briefError, setBriefError] = useState<string | null>(null);
  const [liveItems, setLiveItems] = useState<ItemDecision[]>([]);
  const [liveTotal, setLiveTotal] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<
    "idle" | "running" | "done" | "error"
  >("idle");
  const [liveMode, setLiveMode] = useState<"live" | "replay">("live");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveStartedAt, setLiveStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const liveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (liveStatus !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [liveStatus]);

  const didAutoLoad = useRef(false);
  useEffect(() => {
    void fetch("/api/load-sample", { cache: "no-store" })
      .then((r) => r.json() as Promise<{ days?: string[]; error?: string }>)
      .then((d) => {
        if (!d.days) return;
        setDays(d.days);
        if (didAutoLoad.current) return;
        didAutoLoad.current = true;
        const preferred = d.days.includes("2026-04-23")
          ? "2026-04-23"
          : d.days[0];
        if (preferred) void loadSample(preferred);
      })
      .catch(() => {});
    // loadSample is stable; intentionally not in deps to avoid re-running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetLive = useCallback(() => {
    liveAbortRef.current?.abort();
    liveAbortRef.current = null;
    setLiveItems([]);
    setLiveTotal(null);
    setLiveStatus("idle");
    setLiveMode("live");
    setLiveError(null);
    setLiveStartedAt(null);
  }, []);

  const loadSample = useCallback(
    async (day: string) => {
      setState("loading");
      setError(null);
      setActiveDay(day);
      setBrief(null);
      setBriefState("idle");
      setBriefError(null);
      resetLive();
      try {
        const res = await fetch(`/api/load-sample?day=${day}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as RunManifest;
        setManifest(data);
        setState("loaded");
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      }
    },
    [resetLive],
  );

  const loadBrief = useCallback(async (day: string) => {
    setBriefState("loading");
    setBriefError(null);
    try {
      const res = await fetch(`/api/brief/${day}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Brief;
      setBrief(data);
      setBriefState("loaded");
    } catch (e) {
      setBriefError((e as Error).message);
      setBriefState("error");
    }
  }, []);

  const runLive = useCallback(
    async (day: string, limit = LIVE_LIMIT) => {
      // hard reset state for a fresh run
      liveAbortRef.current?.abort();
      const ctl = new AbortController();
      liveAbortRef.current = ctl;
      setBrief(null);
      setBriefState("idle");
      setBriefError(null);
      setLiveItems([]);
      setLiveTotal(null);
      setLiveError(null);
      setLiveMode("live");
      setLiveStatus("running");
      setLiveStartedAt(Date.now());
      setNow(Date.now());

      try {
        const res = await fetch(
          `/api/run-brief/${day}?limit=${limit}&concurrency=${LIVE_CONCURRENCY}`,
          { cache: "no-store", signal: ctl.signal },
        );
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE events are separated by \n\n; each may have multiple `data:` lines.
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLines = raw
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            let evt: { type: string; [k: string]: unknown };
            try {
              evt = JSON.parse(dataLines.join("\n"));
            } catch {
              continue;
            }
            if (evt.type === "started") {
              setLiveTotal(evt.total as number);
            } else if (evt.type === "item") {
              const dec = evt.decision as ItemDecision;
              setLiveItems((prev) => [...prev, dec]);
            } else if (evt.type === "done") {
              setBrief(evt.brief as Brief);
              setBriefState("loaded");
              setLiveStatus("done");
            } else if (evt.type === "error") {
              throw new Error((evt.message as string) ?? "agent error");
            }
          }
        }
        // stream ended without a `done` event — treat as success if we have items
        if (liveAbortRef.current === ctl) {
          setLiveStatus((s) => (s === "running" ? "done" : s));
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setLiveError((e as Error).message);
        setLiveStatus("error");
      } finally {
        if (liveAbortRef.current === ctl) liveAbortRef.current = null;
      }
    },
    [],
  );

  const replayBrief = useCallback(
    async (day: string, perItemMs = 220) => {
      liveAbortRef.current?.abort();
      const ctl = new AbortController();
      liveAbortRef.current = ctl;
      setBrief(null);
      setBriefState("loading");
      setBriefError(null);
      setLiveItems([]);
      setLiveTotal(null);
      setLiveError(null);
      setLiveMode("replay");
      setLiveStatus("running");
      setLiveStartedAt(Date.now());
      setNow(Date.now());

      let full: Brief;
      try {
        const res = await fetch(`/api/brief/${day}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        full = (await res.json()) as Brief;
        setBriefState("loaded");
      } catch (e) {
        setLiveError((e as Error).message);
        setLiveStatus("error");
        setBriefError((e as Error).message);
        setBriefState("error");
        return;
      }

      const items = [...full.picks, ...full.deferred].sort(
        (a, b) => a.item.id - b.item.id,
      );
      setLiveTotal(items.length);

      for (let i = 0; i < items.length; i++) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, perItemMs + Math.random() * 120),
        );
        if (ctl.signal.aborted) return;
        setLiveItems((prev) => [...prev, items[i]!]);
      }

      if (ctl.signal.aborted) return;
      // brief tail: hold the activity panel for a beat, then reveal full brief
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      if (ctl.signal.aborted) return;
      setBrief(full);
      setLiveStatus("done");
      if (liveAbortRef.current === ctl) liveAbortRef.current = null;
    },
    [],
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setUploading(true);
      setError(null);
      try {
        const fd = new FormData();
        if (manifest?.source_kind === "upload") fd.set("run_id", manifest.run_id);
        for (const f of files) fd.append("files", f);
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { manifest: RunManifest };
        setManifest(data.manifest);
        setState("loaded");
      } catch (e) {
        setError((e as Error).message);
        setState("error");
      } finally {
        setUploading(false);
      }
    },
    [manifest],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const files = Array.from(e.dataTransfer.files);
      void uploadFiles(files);
    },
    [uploadFiles],
  );

  const onPicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      void uploadFiles(files);
      e.target.value = "";
    },
    [uploadFiles],
  );

  const orderTotalQty = useMemo(
    () =>
      manifest?.orders.lines.reduce((s, l) => s + (l.quantity || 0), 0) ?? 0,
    [manifest],
  );
  const orderTotalCount = useMemo(
    () =>
      manifest?.orders.lines.reduce((s, l) => s + (l.n_orders || 0), 0) ?? 0,
    [manifest],
  );

  return (
    <main className="min-h-screen p-6 max-w-7xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Buy Ops — Daily Brief
        </h1>
        <p className="text-sm" style={{ color: "var(--text-dim)" }}>
          Coarse-indexed produce procurement, decided by Opus over messy NL.
        </p>
      </header>

      <Hero />

      <section className={`mb-6 grid gap-4 ${DEMO_MODE ? "" : "md:grid-cols-[2fr_3fr]"}`}>
        <div
          className="rounded-lg border p-3"
          style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
        >
          <div className="text-xs mb-2" style={{ color: "var(--text-dim)" }}>
            Load demo day
          </div>
          <div className="flex flex-wrap gap-2">
            {days.length === 0 && (
              <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                no demo days configured
              </span>
            )}
            {days.map((d) => {
              const active = activeDay === d;
              return (
                <button
                  key={d}
                  onClick={() => loadSample(d)}
                  disabled={state === "loading"}
                  className="rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50"
                  style={{
                    background: active ? "var(--accent)" : "var(--bg)",
                    color: active ? "var(--bg)" : "var(--accent)",
                    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                  }}
                >
                  {d}
                </button>
              );
            })}
            {state === "loading" && (
              <span className="text-xs self-center" style={{ color: "var(--text-dim)" }}>
                loading…
              </span>
            )}
          </div>
        </div>

        {!DEMO_MODE && (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className="rounded-lg border-2 border-dashed flex items-center justify-center px-5 py-4 cursor-pointer transition-colors"
          style={{
            background: dragActive ? "rgba(249,115,22,0.08)" : "transparent",
            borderColor: dragActive ? "var(--accent)" : "var(--border)",
            color: "var(--text-dim)",
          }}
        >
          <input
            type="file"
            multiple
            className="hidden"
            onChange={onPicked}
            accept=".pdf,.csv,.txt"
          />
          <div className="text-center text-sm">
            {uploading ? (
              <span>uploading…</span>
            ) : (
              <>
                <div className="font-medium" style={{ color: "var(--text)" }}>
                  Drop files or click to upload
                </div>
                <div className="text-xs mt-1">
                  orders CSV · price-list PDFs/CSV/TXT · chat-log TXTs
                </div>
              </>
            )}
          </div>
        </label>
        )}
      </section>

      {error && (
        <div
          className="mb-4 rounded-lg border p-3 text-sm"
          style={{
            background: "rgba(239,68,68,0.08)",
            borderColor: "var(--bad)",
            color: "var(--bad)",
          }}
        >
          {error}
        </div>
      )}

      {manifest && (
        <section className="grid gap-4 md:grid-cols-3">
          <Bucket
            title="Orders"
            count={manifest.orders.lines.length}
            subtitle={`${orderTotalQty} units · ${orderTotalCount} orders · delivery ${manifest.delivery_date}`}
          >
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-xs"
                  style={{ color: "var(--text-dim)" }}
                >
                  <th className="text-left font-normal pb-1">Item</th>
                  <th className="text-right font-normal pb-1 w-12">Qty</th>
                  <th className="text-left font-normal pb-1 w-24 pl-2">Pack</th>
                  <th className="text-right font-normal pb-1 w-12">#Ord</th>
                </tr>
              </thead>
              <tbody>
                {manifest.orders.lines.map((l) => (
                  <tr key={l.id} className="align-baseline">
                    <td className="truncate pr-2 py-0.5">{l.name}</td>
                    <td className="text-right tabular-nums font-medium">
                      {l.quantity}
                    </td>
                    <td className="pl-2 text-xs" style={{ color: "var(--text-dim)" }}>
                      {l.description}
                    </td>
                    <td
                      className="text-right tabular-nums text-xs"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {l.n_orders}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Bucket>

          <Bucket
            title="Price lists"
            count={manifest.price_lists.length}
            subtitle={`${manifest.price_lists.filter((p) => p.extracted).length}/${manifest.price_lists.length} extracted · click to view rows`}
          >
            <ul className="space-y-1 text-sm">
              {manifest.price_lists.map((p) => {
                const doc_id = p.filename.replace(/\.(pdf|csv|txt)$/i, "");
                return (
                  <li
                    key={p.filename}
                    onClick={() =>
                      p.extracted &&
                      setViewer({
                        kind: "extraction",
                        title: `${p.supplier} · ${p.date}`,
                        doc_id,
                      })
                    }
                    className={`flex justify-between gap-3 items-baseline rounded px-2 py-1 ${p.extracted ? "cursor-pointer hover:bg-white/5" : "opacity-60"}`}
                  >
                    <span className="truncate">
                      <span
                        className="font-mono text-xs"
                        style={{ color: "var(--text-dim)" }}
                      >
                        {p.format.padEnd(3)}{" "}
                      </span>
                      {p.supplier}
                      <span
                        className="text-xs"
                        style={{ color: "var(--text-dim)" }}
                      >
                        {" "}
                        · {p.date}
                      </span>
                    </span>
                    <span
                      className="text-xs tabular-nums"
                      style={{
                        color: p.extracted ? "var(--good)" : "var(--text-dim)",
                      }}
                    >
                      {p.extracted ? `${p.row_count} rows` : "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Bucket>

          <Bucket
            title="Chat logs"
            count={manifest.chat_logs.length}
            subtitle={`filtered to ${manifest.delivery_date} · click to view`}
          >
            <ul className="space-y-1 text-sm">
              {manifest.chat_logs.map((c) => (
                <li
                  key={c.filename}
                  onClick={() =>
                    setViewer({
                      kind: "chat-log",
                      title: `${c.supplier} chat · as-of ${manifest.delivery_date}`,
                      filename: c.filename,
                      asof: manifest.delivery_date,
                    })
                  }
                  className="flex justify-between gap-3 items-baseline rounded px-2 py-1 cursor-pointer hover:bg-white/5"
                >
                  <span className="truncate">
                    {c.supplier}
                    <span
                      className="text-xs"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {" "}
                      · {c.date_range}
                    </span>
                  </span>
                  <span
                    className="text-xs tabular-nums"
                    style={{ color: "var(--text-dim)" }}
                  >
                    {fmtBytes(c.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          </Bucket>
        </section>
      )}

      {manifest && (
        <section className="mt-6">
          <div
            className="rounded-lg border p-4 text-sm"
            style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
          >
            <div className="font-medium mb-1">Run</div>
            <div style={{ color: "var(--text-dim)" }}>
              <span className="font-mono">{manifest.run_id}</span> · source:{" "}
              {manifest.source_kind}
              {manifest.has_index ? " · index ready" : " · index not built"}
            </div>
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <button
                onClick={() => activeDay && replayBrief(activeDay)}
                disabled={!activeDay || liveStatus === "running"}
                className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
                style={{ background: "var(--accent)", color: "var(--bg)" }}
                title="Animate the pre-baked decisions as if the agents were running live"
              >
                {liveStatus === "running" && liveMode === "replay"
                  ? `Replaying… ${liveItems.length}/${liveTotal ?? "?"}`
                  : "▶ Replay decisions"}
              </button>
              <button
                onClick={() => activeDay && loadBrief(activeDay)}
                disabled={
                  !activeDay || briefState === "loading" || liveStatus === "running"
                }
                className="rounded-md px-3 py-2 text-xs font-medium disabled:opacity-50"
                style={{
                  background: "transparent",
                  color: "var(--text-dim)",
                  border: "1px solid var(--border)",
                }}
                title="Skip the animation — show the pre-baked brief immediately"
              >
                {briefState === "loading" ? "Loading…" : "Load instantly"}
              </button>
              <button
                onClick={() => activeDay && runLive(activeDay)}
                disabled={!activeDay || liveStatus === "running"}
                className="rounded-md px-3 py-2 text-xs font-medium disabled:opacity-50"
                style={{
                  background: "transparent",
                  color: "var(--accent)",
                  border: "1px solid var(--accent)",
                }}
                title={`Run agents live on the first ${LIVE_LIMIT} order lines (slow on dev — uses the SDK)`}
              >
                {liveStatus === "running" && liveMode === "live"
                  ? `Running live… ${liveItems.length}/${liveTotal ?? "?"}`
                  : `Run live (${LIVE_LIMIT})`}
              </button>
              {briefState === "loaded" && brief && liveStatus !== "done" && (
                <span className="text-xs" style={{ color: "var(--text-dim)" }}>
                  pre-baked · {brief.summary.picked}/{brief.summary.total_items} picked ·{" "}
                  {brief.summary.deferred} deferred · est $
                  {brief.summary.estimated_total_cost.toFixed(2)}
                </span>
              )}
              {liveStatus === "done" && brief && (
                <span className="text-xs" style={{ color: "var(--good)" }}>
                  {liveMode === "replay" ? "replay" : "live run"} complete ·{" "}
                  {brief.summary.picked}/{brief.summary.total_items} picked ·{" "}
                  {brief.summary.deferred} deferred
                </span>
              )}
              {briefState === "error" && (
                <span className="text-xs" style={{ color: "var(--bad)" }}>
                  {briefError}
                </span>
              )}
              {liveStatus === "error" && (
                <span className="text-xs" style={{ color: "var(--bad)" }}>
                  {liveError}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {liveStatus === "running" && (
        <LiveActivity
          mode={liveMode}
          items={liveItems}
          total={liveTotal}
          startedAt={liveStartedAt}
          now={now}
        />
      )}

      {brief && <BriefView brief={brief} />}

      {viewer && <Viewer state={viewer} onClose={() => setViewer(null)} />}
    </main>
  );
}

function Bucket({
  title,
  count,
  subtitle,
  children,
}: {
  title: string;
  count: number;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="font-medium">{title}</h2>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: "var(--bg)",
            color: "var(--text-dim)",
            border: "1px solid var(--border)",
          }}
        >
          {count}
        </span>
      </div>
      <div className="text-xs mb-3" style={{ color: "var(--text-dim)" }}>
        {subtitle}
      </div>
      <div
        className="max-h-96 overflow-y-auto pr-3"
        style={{ scrollbarGutter: "stable" }}
      >
        {children}
      </div>
    </div>
  );
}

function Viewer({
  state,
  onClose,
}: {
  state: NonNullable<ViewerState>;
  onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExtractionDoc | null>(null);
  const [chatText, setChatText] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    setExtraction(null);
    setChatText(null);
    const url =
      state.kind === "extraction"
        ? `/api/extraction/${state.doc_id}`
        : `/api/chat-log/${state.filename}?asof=${state.asof}`;
    void fetch(url, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        if (state.kind === "extraction") {
          setExtraction((await r.json()) as ExtractionDoc);
        } else {
          setChatText(await r.text());
        }
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [state]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="rounded-lg border w-full max-w-4xl max-h-[85vh] flex flex-col"
        style={{
          background: "var(--bg-elev)",
          borderColor: "var(--border)",
        }}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b"
          style={{ borderColor: "var(--border)" }}
        >
          <div>
            <div className="font-medium">{state.title}</div>
            <div className="text-xs" style={{ color: "var(--text-dim)" }}>
              {state.kind === "extraction"
                ? extraction
                  ? `${extraction.row_count} extracted rows`
                  : ""
                : chatText
                  ? `${chatText.split("\n").length} lines`
                  : ""}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded px-2 py-1 text-sm"
            style={{ color: "var(--text-dim)" }}
          >
            ✕
          </button>
        </div>

        <div className="overflow-y-auto p-4">
          {loading && (
            <div style={{ color: "var(--text-dim)" }}>loading…</div>
          )}
          {err && (
            <div style={{ color: "var(--bad)" }}>{err}</div>
          )}
          {!loading && state.kind === "extraction" && extraction && (
            <table className="w-full text-sm border-separate border-spacing-0">
              <thead>
                <tr className="text-xs" style={{ color: "var(--text-dim)" }}>
                  <th
                    className="text-left font-normal py-2 w-32 sticky top-0 z-10"
                    style={{
                      background: "var(--bg-elev)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    Commodity
                  </th>
                  <th
                    className="text-right font-normal py-2 w-20 sticky top-0 z-10"
                    style={{
                      background: "var(--bg-elev)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    Cost
                  </th>
                  <th
                    className="text-left font-normal py-2 pl-3 sticky top-0 z-10"
                    style={{
                      background: "var(--bg-elev)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    Raw row
                  </th>
                </tr>
              </thead>
              <tbody>
                {extraction.rows.map((r, i) => {
                  const cellBorder = i === 0 ? {} : { borderTop: "1px solid var(--border)" };
                  return (
                    <tr key={i} className="align-baseline">
                      <td className="py-1 pr-2 font-mono text-xs" style={cellBorder}>
                        {r.commodity}
                      </td>
                      <td className="py-1 text-right tabular-nums" style={cellBorder}>
                        {r.cost === null ? (
                          <span style={{ color: "var(--text-dim)" }}>—</span>
                        ) : (
                          `$${r.cost.toFixed(2)}`
                        )}
                      </td>
                      <td
                        className="py-1 pl-3 text-xs"
                        style={{ ...cellBorder, color: "var(--text-dim)" }}
                      >
                        {r.raw_row_text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!loading && state.kind === "chat-log" && chatText && (
            <pre
              className="text-xs whitespace-pre-wrap font-mono leading-relaxed"
              style={{ color: "var(--text)" }}
            >
              {chatText}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function LiveActivity({
  mode,
  items,
  total,
  startedAt,
  now,
}: {
  mode: "live" | "replay";
  items: ItemDecision[];
  total: number | null;
  startedAt: number | null;
  now: number;
}) {
  const elapsed = startedAt ? Math.max(0, now - startedAt) / 1000 : 0;
  const sorted = useMemo(
    () => [...items].sort((a, b) => a.item.id - b.item.id),
    [items],
  );
  const remaining = total != null ? total - items.length : null;

  const heading = mode === "live" ? "Live agent activity" : "Replaying agent decisions";
  const subtitle =
    mode === "live"
      ? `one Claude session per item · concurrency ${LIVE_CONCURRENCY} · streaming decisions as they finish`
      : "animating the pre-baked brief — same decisions, same rationales, faster";

  return (
    <section className="mt-6">
      <div
        className="rounded-lg border p-4"
        style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
      >
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <h2 className="font-medium">{heading}</h2>
            <div className="text-xs" style={{ color: "var(--text-dim)" }}>
              {subtitle}
            </div>
          </div>
          <div className="text-right">
            <div className="text-sm tabular-nums">
              {items.length}
              {total != null ? `/${total}` : ""} done
            </div>
            <div className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
              {elapsed.toFixed(1)}s
            </div>
          </div>
        </div>
        <div className="space-y-1.5">
          {sorted.map((d) => (
            <LiveRow key={d.item.id} d={d} />
          ))}
          {remaining != null && remaining > 0 &&
            Array.from({ length: remaining }).map((_, i) => (
              <PendingRow key={`pending-${i}`} />
            ))}
        </div>
      </div>
    </section>
  );
}

function LiveRow({ d }: { d: ItemDecision }) {
  const isPick = d.decision === "pick";
  const tone = isPick ? "var(--good)" : "var(--warn)";
  return (
    <div
      className="rounded border px-3 py-1.5 text-sm flex items-baseline gap-3"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
    >
      <span className="font-mono text-xs tabular-nums" style={{ color: tone }}>
        {isPick ? "✓" : "⊙"}
      </span>
      <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
        #{d.item.id}
      </span>
      <span className="font-medium truncate flex-1">{d.item.name}</span>
      {d.supplier ? (
        <span
          className="font-mono text-xs px-1.5 py-0.5 rounded"
          style={{
            background: "var(--bg-elev)",
            color: tone,
            border: `1px solid ${tone}`,
          }}
        >
          {d.supplier}
        </span>
      ) : (
        <span className="text-xs" style={{ color: "var(--text-dim)" }}>
          defer
        </span>
      )}
      {typeof d.cost === "number" && (
        <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
          ${d.cost.toFixed(2)}
        </span>
      )}
      <span className="text-xs tabular-nums" style={{ color: "var(--text-dim)" }}>
        {d.trace.tool_calls} tools · {(d.trace.duration_ms / 1000).toFixed(1)}s
      </span>
    </div>
  );
}

function PendingRow() {
  return (
    <div
      className="rounded border px-3 py-1.5 text-sm flex items-center gap-3"
      style={{
        background: "var(--bg)",
        borderColor: "var(--border)",
        opacity: 0.45,
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full animate-pulse"
        style={{ background: "var(--accent)" }}
      />
      <span className="text-xs" style={{ color: "var(--text-dim)" }}>
        deciding…
      </span>
    </div>
  );
}

function BriefView({ brief }: { brief: Brief }) {
  const supplierCount = useMemo(
    () => new Set(brief.picks.map((p) => p.supplier).filter(Boolean)).size,
    [brief],
  );

  return (
    <section className="mt-6 space-y-4">
      <div
        className="rounded-lg border px-4 py-3 flex flex-wrap gap-x-6 gap-y-1 text-sm"
        style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
      >
        <div>
          <span className="font-medium">Brief</span>
          <span className="ml-2 text-xs" style={{ color: "var(--text-dim)" }}>
            delivery {brief.delivery_date} · baked{" "}
            {new Date(brief.generated_at).toLocaleString()}
          </span>
        </div>
        <Stat label="picked" value={`${brief.summary.picked}/${brief.summary.total_items}`} />
        <Stat label="deferred" value={brief.summary.deferred} />
        <Stat label="suppliers" value={supplierCount} />
        <Stat
          label="est. total"
          value={`$${brief.summary.estimated_total_cost.toFixed(2)}`}
        />
        <Stat label="agent time" value={`${(brief.summary.total_duration_ms / 1000).toFixed(0)}s`} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <DecisionsCard
          title="Picks"
          tone="good"
          items={brief.picks}
          emptyText="no picks yet"
        />
        <DecisionsCard
          title="Deferred"
          tone="warn"
          items={brief.deferred}
          emptyText="nothing deferred"
        />
      </div>

      <DraftsSection drafts={brief.drafts} />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="tabular-nums font-medium">{value}</span>
      <span className="text-xs" style={{ color: "var(--text-dim)" }}>
        {label}
      </span>
    </div>
  );
}

function DecisionsCard({
  title,
  tone,
  items,
  emptyText,
}: {
  title: string;
  tone: "good" | "warn";
  items: Brief["picks"];
  emptyText: string;
}) {
  const accent = tone === "good" ? "var(--good)" : "var(--warn)";
  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-medium">{title}</h2>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: "var(--bg)",
            color: accent,
            border: `1px solid ${accent}`,
          }}
        >
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-dim)" }}>
          {emptyText}
        </div>
      ) : (
        <div
          className="max-h-[28rem] overflow-y-auto pr-2 space-y-2"
          style={{ scrollbarGutter: "stable" }}
        >
          {items.map((d) => (
            <DecisionRow key={d.item.id} d={d} tone={tone} />
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionRow({
  d,
  tone,
}: {
  d: Brief["picks"][number];
  tone: "good" | "warn";
}) {
  const accent = tone === "good" ? "var(--good)" : "var(--warn)";
  return (
    <div
      className="rounded border px-3 py-2 text-sm"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline gap-2">
        <span
          className="text-xs tabular-nums"
          style={{ color: "var(--text-dim)" }}
        >
          #{d.item.id}
        </span>
        <span className="font-medium truncate flex-1">{d.item.name}</span>
        <span
          className="text-xs tabular-nums"
          style={{ color: "var(--text-dim)" }}
        >
          {d.item.quantity}× {d.item.description}
        </span>
      </div>
      <div className="mt-1 flex items-baseline gap-2 text-xs">
        {d.supplier ? (
          <span
            className="font-mono px-1.5 py-0.5 rounded"
            style={{
              background: "var(--bg-elev)",
              color: accent,
              border: `1px solid ${accent}`,
            }}
          >
            {d.supplier}
          </span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>(no supplier)</span>
        )}
        {typeof d.cost === "number" && (
          <span className="tabular-nums" style={{ color: "var(--text-dim)" }}>
            ${d.cost.toFixed(2)}
          </span>
        )}
        {d.commodity && (
          <span className="font-mono" style={{ color: "var(--text-dim)" }}>
            {d.commodity}
          </span>
        )}
        <span className="ml-auto" style={{ color: "var(--text-dim)" }}>
          {d.trace.tool_calls} tools · {(d.trace.duration_ms / 1000).toFixed(1)}s
        </span>
      </div>
      <div
        className="mt-1 text-xs leading-snug"
        style={{ color: "var(--text-dim)" }}
      >
        {d.rationale}
      </div>
      {d.supplier_question && (
        <div
          className="mt-1 text-xs italic"
          style={{ color: "var(--text)" }}
        >
          → ask: {d.supplier_question}
        </div>
      )}
    </div>
  );
}

function DraftsSection({ drafts }: { drafts: Brief["drafts"] }) {
  if (drafts.length === 0) return null;
  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: "var(--bg-elev)", borderColor: "var(--border)" }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="font-medium">Supplier drafts</h2>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            background: "var(--bg)",
            color: "var(--text-dim)",
            border: "1px solid var(--border)",
          }}
        >
          {drafts.length}
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {drafts.map((dr) => (
          <DraftCard key={dr.supplier} draft={dr} />
        ))}
      </div>
    </div>
  );
}

function DraftCard({ draft }: { draft: Brief["drafts"][number] }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft.message);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  };
  return (
    <div
      className="rounded border flex flex-col"
      style={{ background: "var(--bg)", borderColor: "var(--border)" }}
    >
      <div
        className="flex items-baseline justify-between px-3 py-2 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <div>
          <div className="font-mono text-sm">{draft.supplier}</div>
          <div className="text-xs" style={{ color: "var(--text-dim)" }}>
            {draft.picks.length} pick{draft.picks.length === 1 ? "" : "s"}
            {draft.questions.length > 0
              ? ` · ${draft.questions.length} question${draft.questions.length === 1 ? "" : "s"}`
              : ""}
          </div>
        </div>
        <button
          onClick={onCopy}
          className="text-xs rounded px-2 py-1"
          style={{
            background: "var(--bg-elev)",
            color: copied ? "var(--good)" : "var(--text-dim)",
            border: "1px solid var(--border)",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        className="text-xs whitespace-pre-wrap font-mono leading-relaxed p-3 max-h-72 overflow-y-auto"
        style={{ color: "var(--text)" }}
      >
        {draft.message}
      </pre>
    </div>
  );
}
