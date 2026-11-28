// The head of the cockpit: the current sensor, one health statement, the tools and the brand.
import { useEffect, useState } from "react";
import { controller } from "../controller";
import { useStore } from "../state/store";
import { KIND_DE } from "./de";
import { Icon } from "./Icon";

function useClock(): string {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

/** One statement about the whole line as a pill: green ok, yellow warning, red critical, grey disconnected. */
export function useHealth(): { tone: "ok" | "warn" | "bad" | "off"; text: string; title?: string } {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const socket = useStore((s) => s.socket);
  if (socket !== "open") return { tone: "off", text: "Verbinde mit den Sensoren …" };
  const sensors = config?.sensors ?? [];
  const notLive = sensors.flatMap((s) => {
    const live = status?.sensors[s.id]?.live;
    return live && live.state !== "streaming" ? [{ name: s.name, live }] : [];
  });
  if (notLive.length) {
    const { name, live } = notLive[0];
    const what = live.state === "offline" ? "Sensor nicht verbunden" : live.state === "no_data" ? "verbunden, keine Messwerte" : "keine gültigen Messwerte";
    return { tone: "warn", text: `${name}: ${what}`, title: live.message };
  }
  const problems = sensors.flatMap((s) => {
    const st = status?.sensors[s.id];
    return st && st.state !== "ok" ? [{ name: s.name, state: st.state, kinds: st.active }] : [];
  });
  if (!problems.length) {
    const byRange = sensors.length > 0 && sensors.every((s) => s.tolerance_kind === "measuring_range");
    return { tone: "ok", text: byRange ? "Ziel im Messbereich" : "Sensor in Toleranz" };
  }
  const first = problems[0];
  const what = first.kinds.length ? (KIND_DE[first.kinds[0]] ?? first.kinds[0]) : "Achtung";
  return { tone: problems.some((p) => p.state === "critical") ? "bad" : "warn",
    text: `${first.name}: ${what}${problems.length > 1 ? ` und ${problems.length - 1} weitere` : ""}` };
}

function SensorIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true">
      <rect x="10" y="7" width="28" height="17" rx="3" fill="#5b636b" />
      <rect x="13" y="10" width="15" height="8" rx="1.5" fill="#dfe3e8" />
      <circle cx="33" cy="15" r="2" fill="#c4161c" />
      <path d="M20 24 15 42M28 24 33 42" stroke="#c4161c" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 42h26" stroke="#9aa1a9" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const soundOn = useStore((s) => s.soundOn);
  const phones = useStore((s) => s.status?.clients.phone ?? 0);
  const cameraOn = useStore((s) => s.camera.on);
  const tokenOk = useStore((s) => s.tokenOk);
  const manualCount = useStore((s) => s.knowledge?.documents.length ?? 0);
  const patch = useStore((s) => s.patch);
  const health = useHealth();
  const time = useClock();
  const sensor = config?.sensors[0];
  const live = sensor ? status?.sensors[sensor.id]?.live : undefined;
  const liveText = live ? (live.state === "streaming" ? "Live" : "nicht live") : "";

  return (
    <header className="topbar">
      <div className="sensor-card">
        <div className="sensor-thumb"><SensorIcon /></div>
        <div>
          <div className="eyebrow">Aktueller Sensor{config && config.sensors.length > 1 ? ` (1 von ${config.sensors.length})` : ""}</div>
          <div className="sensor-name">{sensor?.name ?? "…"}</div>
          <div className="sensor-sub">
            <i className={`dot ${live?.state === "streaming" ? "ok" : live ? "bad" : ""}`} />
            {[sensor?.model, liveText, live?.host].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <div className="topbar-right">
        <span className={`pill pill-lg ${health.tone}`} title={health.title}><i />{health.text}</span>
        {config?.token_required && tokenOk === false && (
          <button className="btn" onClick={() => void controller.enterToken()} title="Teile lernen und KI-Stimme freischalten">
            <Icon name="lock" /><span>Entsperren</span>
          </button>
        )}
        <button className="btn" onClick={() => patch({ manualsOpen: true })} title="Handbücher, aus denen die KI antwortet">
          <Icon name="book" /><span>Handbücher{manualCount ? ` (${manualCount})` : ""}</span>
        </button>
        <button className={`btn ${cameraOn ? "is-on" : ""}`} onClick={() => void controller.toggleCamera()} title="Kamera: fotografiert jedes Teil unter dem Sensor (C)">
          <Icon name="camera" /><span>{cameraOn ? "Kamera an" : "Kamera"}</span>
        </button>
        <button className="btn" onClick={() => patch({ qrOpen: true })} title="Handys koppeln (Q)">
          <Icon name="phone" /><span>{phones ? `${phones} Handy${phones === 1 ? "" : "s"}` : "Handys"}</span>
        </button>
        <button className={`btn icon ${soundOn ? "" : "is-off"}`} onClick={() => controller.toggleSound()} title="Ton an oder aus (M)">
          <Icon name={soundOn ? "speaker" : "mute"} />
        </button>
        <time className="clock">{time}</time>
        <div className="brandbox">
          <div className="brand-name">{config?.title ?? "KI Sensor Cockpit"}</div>
          <div className="brand-sub">für Micro-Epsilon-Sensoren{config?.team ? ` · ${config.team}` : ""}</div>
        </div>
      </div>
    </header>
  );
}

export function Tabs() {
  const config = useStore((s) => s.config);
  const patch = useStore((s) => s.patch);
  const sid = config?.sensors[0]?.id ?? "";
  const tabs: { label: string; icon: string; on?: boolean; go?: () => void }[] = [
    { label: "Messung", icon: "wave", on: true },
    { label: "Teileprüfung", icon: "check", go: () => controller.openPartCheck(sid) },
    { label: "Teile-Log", icon: "sliders", go: () => controller.openParts(sid) },
    { label: "Bericht", icon: "doc", go: () => patch({ reportId: `run:${sid}`, partsFor: null, partFor: null }) },
    { label: "Handbücher", icon: "book", go: () => patch({ manualsOpen: true }) },
  ];
  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <button key={t.label} className={`tab ${t.on ? "is-on" : ""}`} onClick={t.go}>
          <Icon name={t.icon} size={16} />{t.label}
        </button>
      ))}
    </nav>
  );
}

export function StatusBar() {
  const config = useStore((s) => s.config);
  const status = useStore((s) => s.status);
  const socket = useStore((s) => s.socket);
  const sensor = config?.sensors[0];
  const st = sensor ? status?.sensors[sensor.id] : undefined;
  const live = st?.live;
  const station = st?.station;
  const phones = status?.clients.phone ?? 0;
  const ready = socket === "open" && (!live || live.state === "streaming");
  const rate = live?.rate_hz ? `${(live.rate_hz / 1000).toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kHz` : null;
  return (
    <footer className="statusbar">
      <span className={`ready ${ready ? "ok" : "bad"}`}><i />{ready ? "Bereit" : socket !== "open" ? "Getrennt" : "Sensor nicht bereit"}</span>
      {live && <span>Live-Sensor {live.host}</span>}
      {rate && <span>{rate}</span>}
      {st && <span>Rauschen {(st.noise ?? 0).toLocaleString("de-DE", { maximumFractionDigits: 2 })} {sensor?.unit}</span>}
      {station && <span>{station.parts} Teile · {station.good} gut · {station.different} abweichend</span>}
      <span className="grow" />
      <span>{phones} Handy{phones === 1 ? "" : "s"} verbunden</span>
    </footer>
  );
}
