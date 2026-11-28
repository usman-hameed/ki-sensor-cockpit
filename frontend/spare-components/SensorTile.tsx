import { useEffect, useRef } from "react";
import { series, serverNow } from "../lib/live";
import { KIND_LABEL, num, signed } from "../lib/format";
import type { SensorInfo, SensorStatus } from "../types";

const SPARK_SECONDS = 20;

const STATE_COLOR = { ok: "#34d399", warning: "#fbbf24", critical: "#fb4f6b" } as const;

export function SensorTile({ sensor, status }: { sensor: SensorInfo; status?: SensorStatus }) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = status?.state ?? "ok";
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let raf = 0;
    let lastText = 0;
    const { low, high } = sensor.tolerance;
    const draw = (now: number) => {
      const s = series(sensor.id);
      const latest = s.latest();
      if (latest && now - lastText > 120 && valueRef.current && markerRef.current) {
        lastText = now;
        valueRef.current.textContent = Number.isNaN(latest.v) ? "invalid" : signed(latest.v, 2);
        const fraction = Number.isNaN(latest.v) ? 0.5 : (latest.v - low) / (high - low);
        markerRef.current.style.left = `${Math.min(100, Math.max(0, fraction * 100))}%`;
      }
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const tEnd = serverNow();
        const tStart = tEnd - SPARK_SECONDS;
        let lo = Infinity;
        let hi = -Infinity;
        s.forEachSince(tStart, (_, v) => {
          if (Number.isNaN(v)) return;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        });
        if (Number.isFinite(lo)) {
          const span = Math.max(2, hi - lo);
          const mid = (hi + lo) / 2;
          lo = mid - span * 0.62;
          hi = mid + span * 0.62;
          const color = STATE_COLOR[stateRef.current];
          const toY = (v: number) => h - ((v - lo) / (hi - lo)) * h;
          const pairs: [number, number, number][] = [];
          let pending: [number, number] | null = null;
          s.forEachSince(tStart, (t, v) => {
            if (Number.isNaN(v)) {
              pending = null;
              pairs.push([((t - tStart) / SPARK_SECONDS) * w, Number.NaN, Number.NaN]);
              return;
            }
            if (!pending) {
              pending = [t, v];
              return;
            }
            const x = ((pending[0] - tStart) / SPARK_SECONDS) * w;
            pairs.push([x, Math.min(pending[1], v), Math.max(pending[1], v)]);
            pending = null;
          });
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.22;
          for (const [x, a, b] of pairs) {
            if (!Number.isNaN(a)) ctx.fillRect(x, toY(b), Math.max(1, w / 500), Math.max(1, toY(a) - toY(b)));
          }
          ctx.globalAlpha = 1;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.shadowColor = color;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          let pen = false;
          for (const [x, a, b] of pairs) {
            if (Number.isNaN(a)) {
              pen = false;
              continue;
            }
            const y = toY((a + b) / 2);
            if (pen) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
            pen = true;
          }
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [sensor]);

  const sourceType = status?.source?.type ?? sensor.source;
  const sourceLabel = sourceType === "medaqlib" ? "LIVE" : sourceType === "replay" ? "REPLAY" : "SIM";
  const averaging = status?.settings?.averaging;

  return (
    <article className={`tile tile-${state}`}>
      <header className="tile-head">
        <div>
          <div className="tile-name">{sensor.name}</div>
          <div className="tile-model">{sensor.model}</div>
        </div>
        <span className={`badge ${status?.source?.fallback ? "badge-warn" : ""}`} title={status?.source?.error ?? ""}>
          {sourceLabel}
        </span>
      </header>

      <div className="tile-value">
        <span ref={valueRef}>{signed(status?.latest ?? null, 2)}</span>
        <span className="tile-unit">{sensor.unit}</span>
      </div>

      <div className="gauge" title={`Tolerance ${sensor.tolerance.low} to ${sensor.tolerance.high} ${sensor.unit}`}>
        <div className="gauge-zone" />
        <div className="gauge-mid" />
        <div className="gauge-marker" ref={markerRef} />
        <span className="gauge-label left">{sensor.tolerance.low}</span>
        <span className="gauge-label right">+{sensor.tolerance.high}</span>
      </div>

      <canvas className="spark" ref={canvasRef} />

      <footer className="tile-foot">
        <span>noise σ {num(status?.noise ?? null, 2)} {sensor.unit}</span>
        {averaging !== undefined && <span>avg {averaging}</span>}
      </footer>
      {status?.active?.length ? (
        <div className="tile-alerts">
          {status.active.map((kind) => (
            <span key={kind} className="chip">{KIND_LABEL[kind]}</span>
          ))}
        </div>
      ) : null}
      {status?.read_error && <div className="tile-error">{status.read_error}</div>}
    </article>
  );
}
