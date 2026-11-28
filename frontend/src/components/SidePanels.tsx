// The left column: folding cards with the short version of the part check, the part log, the sensor and manuals.
import { useState, type ReactNode } from "react";
import { controller } from "../controller";
import { api, ApiError } from "../lib/api";
import { series } from "../lib/live";
import { useStore } from "../state/store";
import type { SensorInfo } from "../types";
import { de, PART_DE, pos, unitOf } from "./de";

function Fold({ title, count, open: start = false, children }: { title: string; count?: string; open?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <section className={`fold side ${open ? "is-open" : ""}`}>
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>{title}</span>
        {count !== undefined && <span className="fold-count">{count}</span>}
        <i className="fold-arrow" />
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return <div className="kv"><span>{k}</span><b className={tone}>{v}</b></div>;
}

function PartCheckFold({ sensor }: { sensor: SensorInfo }) {
  const part = useStore((s) => s.status?.sensors[sensor.id]?.part);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const latest = series(sensor.id).latest();
  const learn = async (kind: "part" | "empty") => {
    setBusy(true);
    try {
      await api.partLearn(sensor.id, { kind });
      toast(kind === "empty" ? "Leere Auflage gelernt." : "Gutes Teil gelernt.", "ok");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) void controller.enterToken();
      toast(String(e instanceof Error ? e.message : e), "error");
    } finally {
      setBusy(false);
    }
  };
  if (!part?.supported) return <p className="muted small">Die Teileprüfung braucht einen Sensor in µm.</p>;
  const ref = part.reference;
  const stateTone = part.state === "different" ? "bad" : part.state === "match" ? "ok" : "";
  return (
    <>
      <div className="muted small">Unter dem Sensor</div>
      <div className={`state-word ${stateTone}`}>{PART_DE[part.state]}</div>
      {ref && <Row k="Gelerntes Teil" v={`${pos(ref.center_um, sensor, 4)} ${unitOf(sensor)}`} />}
      {ref && <Row k="Abweichung" v={`± ${pos(ref.half_width_um, sensor, 4)} ${unitOf(sensor)}`} />}
      {part.empty_um !== null && <Row k="Leere Auflage" v={`${pos(part.empty_um, sensor, 4)} ${unitOf(sensor)}`} />}
      <Row k="Jetzt" v={`${pos(latest && Number.isFinite(latest.v) ? latest.v : null, sensor, 4)} ${unitOf(sensor)}`} tone={stateTone} />
      <div className="fold-actions">
        {part.empty_um === null && !ref && <button className="btn" disabled={busy} onClick={() => void learn("empty")}>Leere Auflage lernen</button>}
        <button className="btn primary" disabled={busy} onClick={() => void learn("part")}>{ref ? "Neu lernen" : "Gutes Teil lernen"}</button>
        <button className="link" onClick={() => controller.openPartCheck(sensor.id)}>Ganze Teileprüfung</button>
      </div>
    </>
  );
}

export function SidePanels({ sensor }: { sensor: SensorInfo | undefined }) {
  const st = useStore((s) => (sensor ? s.status?.sensors[sensor.id] : undefined));
  const manuals = useStore((s) => s.knowledge?.documents.length ?? 0);
  const patch = useStore((s) => s.patch);
  if (!sensor) return <aside className="side" />;
  const station = st?.station;
  const live = st?.live;
  return (
    <aside className="side">
      <Fold title="Teileprüfung" open><PartCheckFold sensor={sensor} /></Fold>
      <Fold title="Teile-Log" count={`${station?.parts ?? 0} Teile`}>
        {station ? (
          <>
            <Row k="Teile" v={String(station.parts)} />
            <Row k="Gut" v={String(station.good)} tone="ok" />
            <Row k="Abweichend" v={String(station.different)} tone={station.different ? "bad" : ""} />
            <Row k="Pro Minute" v={station.per_minute !== null ? de(station.per_minute, 1) : "–"} />
            <Row k="Ausbeute" v={station.yield_percent !== null ? `${de(station.yield_percent, 0)} %` : "–"} />
          </>
        ) : <p className="muted small">Noch keine Teile.</p>}
        <div className="fold-actions"><button className="link" onClick={() => controller.openParts(sensor.id)}>Ganzes Teile-Log</button></div>
      </Fold>
      <Fold title="Sensor">
        <Row k="Modell" v={sensor.model} />
        <Row k="Verbindung" v={live ? (live.state === "streaming" ? "Live" : live.state === "offline" ? "Nicht verbunden" : "Keine Messwerte") : "–"}
             tone={live?.state === "streaming" ? "ok" : live ? "bad" : ""} />
        {live?.host && <Row k="Adresse" v={live.host} />}
        {live?.rate_hz ? <Row k="Rate" v={`${de(live.rate_hz / 1000, 1)} kHz`} /> : null}
        <Row k="Rauschen" v={`${de(st?.noise ?? null, 2)} ${sensor.unit}`} />
        {live?.serial ? <Row k="Seriennummer" v={String(live.serial)} /> : null}
        {live && live.state !== "streaming" && <p className="muted small">{live.message}</p>}
      </Fold>
      <Fold title="Handbücher" count={String(manuals)}>
        <p className="muted small">{manuals ? `${manuals} Handbücher geladen: Epsilon antwortet daraus und nennt die Seite.` : "Noch keine Handbücher. Lege die PDFs von Micro-Epsilon hinein."}</p>
        <div className="fold-actions"><button className="link" onClick={() => patch({ manualsOpen: true })}>Handbücher öffnen</button></div>
      </Fold>
    </aside>
  );
}
