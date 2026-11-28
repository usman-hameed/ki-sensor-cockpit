// The middle of the cockpit: the big value, the measuring range, the live diagram, the channel table and the
// charts the assistant opened.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { series } from "../lib/live";
import { zoneOf } from "../lib/units";
import { useStore } from "../state/store";
import type { SensorInfo } from "../types";
import { de, KIND_DE, PART_DE, pos, unitOf, ZONE_DE } from "./de";
import { LINE_COLORS, type LiveChartHandle } from "./LiveChart";
import { Stage } from "./Stage";

/** The gauge covers the extended measuring range of a sensor with a data sheet, otherwise 1.3 times the tolerance. */
function gaugeAxis(sensor: SensorInfo): { min: number; width: number } {
  const z = sensor.spec?.zones_um;
  if (z && sensor.tolerance_kind === "measuring_range") return { min: z.ext_low, width: z.ext_high - z.ext_low };
  const { low, high } = sensor.tolerance;
  const width = (high - low) * 1.3;
  return { min: (low + high) / 2 - width / 2, width };
}

function Gauge({ sensor, needle }: { sensor: SensorInfo; needle: React.RefObject<HTMLSpanElement | null> }) {
  const noise = useStore((s) => s.status?.sensors[sensor.id]?.noise ?? null);
  const { low, high } = sensor.tolerance;
  const { min, width } = gaugeAxis(sensor);
  const pct = (v: number) => `${((v - min) / width) * 100}%`;
  const ext = sensor.tolerance_kind === "measuring_range" ? sensor.spec?.zones_um : undefined;
  const label = ext
    ? `Measuring range ${pos(low, sensor, 0)} … ${pos(high, sensor, 0)} ${unitOf(sensor)} (extended ${pos(ext.ext_low, sensor, 1)} … ${pos(ext.ext_high, sensor, 1)})`
    : `Tolerance ${pos(low, sensor)} … ${pos(high, sensor)} ${unitOf(sensor)}`;
  return (
    <div className="mgauge">
      <div className="mgauge-top"><span>{label}</span><span>Noise {de(noise, 2)} {sensor.unit}</span></div>
      <div className="mgauge-bar">
        {ext && <span className="mgauge-ext" style={{ left: 0, width: pct(low) }} />}
        {ext && <span className="mgauge-ext" style={{ left: pct(high), right: 0 }} />}
        <span className="mgauge-go" style={{ left: pct(low), width: `${((high - low) / width) * 100}%` }} />
        <span className="mgauge-needle" ref={needle} />
      </div>
      <div className="mgauge-scale">
        {ext && <span style={{ left: "0%" }}>{pos(ext.ext_low, sensor, 1)}</span>}
        <span style={{ left: pct(low) }}>{pos(low, sensor, 0)}</span>
        <span style={{ left: pct(high) }}>{pos(high, sensor, 0)}</span>
        {ext && <span style={{ left: "100%" }}>{pos(ext.ext_high, sensor, 1)}</span>}
      </div>
    </div>
  );
}

export function StatePills({ sensor, zone }: { sensor: SensorInfo; zone: string | null }) {
  const status = useStore((s) => s.status?.sensors[sensor.id]);
  const part = status?.part;
  const active = (status?.active ?? []).filter((k) => k !== "wrong_part");
  return (
    <div className="pills">
      {sensor.spec && <span className={`pill ${zone === "standard" ? "ok" : zone === "none" ? "" : "warn"}`}><i />{ZONE_DE[zone ?? "none"]}</span>}
      {part?.supported && part.state !== "no_reference" && (
        <span className={`pill ${part.state === "different" ? "bad" : part.state === "match" ? "ok" : ""}`}>{PART_DE[part.state]}</span>
      )}
      {active.map((k) => <span key={k} className="pill bad">{KIND_DE[k] ?? k}</span>)}
    </div>
  );
}

function ChannelTable({ chart, hidden, toggle }: {
  chart: React.RefObject<LiveChartHandle | null>; hidden: Set<string>; toggle: (id: string) => void;
}) {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  return (
    <table className="channels">
      <thead>
        <tr><th /><th>Name</th><th>Color</th><th className="num">Current value</th><th className="num">Min</th>
          <th className="num">Max</th><th className="num">Peak-to-peak</th><th className="num">Noise</th><th>State</th><th>Unit</th></tr>
      </thead>
      <tbody>
        {config?.sensors.map((sensor, i) => {
          const st = status?.sensors[sensor.id];
          const latest = series(sensor.id).latest();
          const span = chart.current?.span(sensor.id) ?? null;
          const part = st?.part;
          const state = st?.active.length ? KIND_DE[st.active[0]] ?? st.active[0]
            : part?.supported && part.state !== "no_reference" ? PART_DE[part.state] : "ok";
          const tone = st?.state === "critical" || part?.state === "different" ? "bad" : st?.state === "warning" ? "warn" : "ok";
          return (
            <tr key={sensor.id}>
              <td><input type="checkbox" checked={!hidden.has(sensor.id)} onChange={() => toggle(sensor.id)} aria-label={`Show ${sensor.name}`} /></td>
              <td>{sensor.name}</td>
              <td><span className="swatch" style={{ background: LINE_COLORS[i % LINE_COLORS.length] }} /></td>
              <td className="num">{pos(latest?.v, sensor, 4)}</td>
              <td className="num">{pos(span?.min, sensor, 4)}</td>
              <td className="num">{pos(span?.max, sensor, 4)}</td>
              <td className="num">{span ? pos(span.max - span.min, sensor, 4) : "–"}</td>
              <td className="num">{de(st?.noise ?? null, 2)} {sensor.unit}</td>
              <td><span className={`pill ${tone}`}>{state === "ok" ? "OK" : state}</span></td>
              <td>{unitOf(sensor)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AssistantCharts() {
  const count = useStore((s) => s.stage.filter((p) => !p.leaving).length);
  const [open, setOpen] = useState(false);
  const before = useRef(count);
  const mounted = useRef(Date.now());
  useEffect(() => {
    // a new chart from the chat opens the field (not the one the cockpit shows by itself at the start)
    if (count > before.current && Date.now() - mounted.current > 5000) setOpen(true);
    before.current = count;
  }, [count]);
  return (
    <section className={`fold assistant ${open ? "is-open" : ""}`}>
      <button className="fold-head" onClick={() => setOpen(!open)}>
        <span>Charts from the assistant</span>
        <span className="fold-count">{count ? `${count} open` : "none"}</span>
        <i className="fold-arrow" />
      </button>
      {open && <div className="assistant-stage"><Stage /></div>}
    </section>
  );
}

export function MeasureCard({ sensor, chart, slot, windowS, setWindowS, paused, setPaused, hidden, toggle, swapped, onSwap }: {
  sensor: SensorInfo | undefined;
  chart: React.RefObject<LiveChartHandle | null>;
  slot: ReactNode;
  windowS: number; setWindowS: (v: number) => void;
  paused: boolean; setPaused: (v: boolean) => void;
  hidden: Set<string>; toggle: (id: string) => void;
  swapped: boolean; onSwap: () => void;
}) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const needleRef = useRef<HTMLSpanElement>(null);
  const [zone, setZone] = useState<string | null>(null);

  useEffect(() => {
    if (!sensor) return;
    let raf = 0;
    let last = 0;
    let lastZone: string | null = null;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 100) return;
      last = now;
      const latest = series(sensor.id).latest();
      const v = latest && Number.isFinite(latest.v) ? latest.v : null;
      if (valueRef.current) valueRef.current.textContent = v === null ? "no reading" : pos(v, sensor);
      if (needleRef.current) {
        const { min, width } = gaugeAxis(sensor);
        const p = v === null ? 50 : Math.min(Math.max(((v - min) / width) * 100, 0), 100);
        needleRef.current.style.left = `${p}%`;
        needleRef.current.style.opacity = v === null ? "0.25" : "1";
      }
      const z = zoneOf(v, sensor) ?? "none";
      if (z !== lastZone) { lastZone = z; setZone(z); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sensor]);

  const save = () => {
    const url = chart.current?.image();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `live-signal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
  };

  if (!sensor) return <section className="card measure" />;
  return (
    <section className="card measure">
      <div className="measure-top">
        <div className="measure-value">
          <div className="label">{sensor.name} – distance</div>
          <div className="big"><span ref={valueRef}>…</span><small>{unitOf(sensor)}</small></div>
          <StatePills sensor={sensor} zone={zone} />
        </div>
        <Gauge sensor={sensor} needle={needleRef} />
      </div>
      <div className="toolbar">
        <div className="seg">
          {[10, 30].map((s) => (
            <button key={s} className={windowS === s ? "is-on" : ""} onClick={() => setWindowS(s)}>{s} s</button>
          ))}
        </div>
        <button className="btn" onClick={() => setPaused(!paused)}>{paused ? "▶ Resume" : "❚❚ Pause"}</button>
        <button className="btn" onClick={save} disabled={swapped} title={swapped ? "The live signal is on the right now" : "Save the live signal as a PNG"}>Save image</button>
        <button className="btn" onClick={onSwap} title="Swap the 3D model and the live signal">{swapped ? "⇄ Live signal large" : "⇄ 3D model large"}</button>
        <span className="toolbar-note">Live signal · red background = alert (different part, invalid)</span>
      </div>
      <div className="measure-slot">{slot}</div>
      <ChannelTable chart={chart} hidden={hidden} toggle={toggle} />
      <AssistantCharts />
    </section>
  );
}
