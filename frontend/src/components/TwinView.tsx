// The 3D digital twin with measurement callouts that follow each sensor, and the part under it.
import { useEffect, useRef, useState } from "react";
import { pos, shownFor } from "../lib/units";
import { series } from "../lib/live";
import { serverNow } from "../lib/live";
import { trackFor } from "../lib/tracks";
import type { Twin, TwinState } from "../lib/twin";
import { useStore } from "../state/store";

const get = () => useStore.getState();

function sensorState(id: string): TwinState {
  const status = get().status?.sensors[id];
  if (!status) return "ok";
  if (status.active.includes("invalid")) return "invalid";
  return status.state;
}

export function TwinView() {
  const config = useStore((s) => s.config);
  const hostRef = useRef<HTMLDivElement>(null);
  const labelRefs = useRef(new Map<string, HTMLDivElement>());
  const valueRefs = useRef(new Map<string, HTMLSpanElement>());
  const twinRef = useRef<Twin | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const sensorKey = config?.sensors.map((s) => s.id).join(",") ?? "";

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !config) return;
    let disposed = false;
    let raf = 0;
    let lastText = 0;
    void import("../lib/twin").then(({ Twin }) => {
      if (disposed) return;
      try {
        const twin = new Twin(host, config.sensors.map((s, i) => ({
          id: s.id, low: s.tolerance.low, high: s.tolerance.high,
          extLow: s.spec?.zones_um.ext_low, extHigh: s.spec?.zones_um.ext_high,
          model: s.model, ...trackFor(i, config.sensors.length),
        })), {
          forEachSince: (id, tMin, fn) => series(id).forEachSince(tMin, fn),
          now: serverNow,
          value: (id) => {
            const latest = series(id).latest();
            return latest && Number.isFinite(latest.v) ? latest.v : null;
          },
          state: sensorState,
          part: (id) => {
            const part = get().status?.sensors[id]?.part;
            return part?.supported ? { state: part.state, emptyUm: part.empty_um } : null;
          },
        });
        twinRef.current = twin;
        twin.setMission(get().mission);
      } catch (error) {
        setFailed(error instanceof Error ? error.message : String(error));
        return;
      }
      // callouts follow the sensors; values refresh about ten times a second
      const tick = (now: number) => {
        const twin = twinRef.current;
        if (twin) {
          for (const p of twin.labelPositions()) {
            const el = labelRefs.current.get(p.id);
            if (el) {
              el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
              el.style.opacity = p.visible ? "1" : "0";
              el.dataset.state = sensorState(p.id);
            }
          }
          if (now - lastText > 100) {
            lastText = now;
            for (const sensor of get().config?.sensors ?? []) {
              const el = valueRefs.current.get(sensor.id);
              const latest = series(sensor.id).latest();
              if (el) el.textContent = latest && Number.isFinite(latest.v) ? pos(latest.v, shownFor(sensor), 2).replace("-", "−") : "no reading";
            }
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      twinRef.current?.dispose();
      twinRef.current = null;
    };
    // the scene is rebuilt only when the set of sensors changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sensorKey]);

  // mission mode
  useEffect(() => useStore.subscribe((s, prev) => {
    if (s.mission !== prev.mission) twinRef.current?.setMission(s.mission);
  }), []);

  return (
    <div className="twin">
      <div className="twin-canvas" ref={hostRef} />
      {failed && (
        <div className="twin-failed">
          <p>The 3D view needs WebGL, which this browser has switched off.</p>
          <p className="muted">{failed}</p>
        </div>
      )}
      {!failed && config?.sensors.map((sensor, i) => (
        <div key={sensor.id} className="callout" data-state="ok"
             data-side={i < config.sensors.length / 2 && config.sensors.length > 1 ? "left" : "right"}
             ref={(el) => { if (el) labelRefs.current.set(sensor.id, el); else labelRefs.current.delete(sensor.id); }}>
          <span className="callout-dot" />
          <span className="callout-leader" />
          <span className="callout-body">
            <span className="callout-name">{sensor.name}</span>
            <span className="callout-value">
              <span ref={(el) => { if (el) valueRefs.current.set(sensor.id, el); else valueRefs.current.delete(sensor.id); }}>…</span>
              <small>{shownFor(sensor).unit}</small>
            </span>
          </span>
        </div>
      ))}
      <div className="twin-hint">Drag to look around</div>
    </div>
  );
}
