import { useEffect, useState } from "react";
import { controller } from "../controller";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

function Pill({ tone, label, value }: { tone: "ok" | "warn" | "bad" | "idle"; label: string; value: string }) {
  return (
    <div className={`pill pill-${tone}`}>
      <span className="pill-dot" />
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <div className="clock">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>;
}

export function TopBar() {
  const config = useStore((s) => s.config);
  const socket = useStore((s) => s.socket);
  const status = useStore((s) => s.status);
  const voiceMode = useStore((s) => s.voiceMode);
  const soundOn = useStore((s) => s.soundOn);
  const gesturesOn = useStore((s) => s.gesturesOn);
  const tokenOk = useStore((s) => s.tokenOk);
  const patch = useStore((s) => s.patch);

  const sources = Object.values(status?.sensors ?? {}).map((s) => s.source?.type ?? "simulator");
  const live = sources.filter((t) => t === "medaqlib").length;
  const replay = sources.filter((t) => t === "replay").length;
  const fallback = Object.values(status?.sensors ?? {}).some((s) => s.source?.fallback);
  const sourceText = live ? "Live sensors" : replay ? "Recorded data" : "Simulator";

  const voiceTone = voiceMode === "ready" ? "ok" : voiceMode === "connecting" ? "warn" : voiceMode === "error" ? "bad" : "idle";
  const voiceText =
    voiceMode === "ready" ? "AI" : voiceMode === "connecting" ? "connecting" : voiceMode === "error" ? "error" : config?.voice.enabled ? "off" : "offline";
  const phones = status?.clients.phone ?? 0;

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="17" fill="none" stroke="currentColor" strokeWidth="4" />
          <circle cx="32" cy="32" r="6" fill="currentColor" />
          <path d="M6 32h9M49 32h9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
        </svg>
        <div>
          <div className="brand-title">{config?.title ?? "KI Sensor Cockpit"}</div>
          <div className="brand-sub">{config?.team ?? ""} · copilot {config?.assistant_name ?? ""}</div>
        </div>
      </div>

      <div className="pills">
        <Pill tone={socket === "open" ? "ok" : socket === "connecting" ? "warn" : "bad"} label="Data" value={socket === "open" ? "streaming" : socket} />
        <Pill tone={fallback ? "warn" : "ok"} label="Source" value={fallback ? `${sourceText} (fallback)` : sourceText} />
        <Pill tone={voiceTone} label="Voice" value={voiceText} />
        <Pill tone={phones ? "ok" : "idle"} label="Phones" value={String(phones)} />
      </div>

      <div className="top-actions">
        {config?.voice.enabled && (
          <button
            className={`btn ${voiceMode === "ready" ? "btn-on" : "btn-accent"}`}
            onClick={() => (voiceMode === "ready" ? controller.disconnectVoice() : void controller.connectVoice())}
            disabled={voiceMode === "connecting"}
            title="Connect the AI voice (needs internet)"
          >
            <Icon name={voiceMode === "ready" ? "power" : "mic"} />
            {voiceMode === "ready" ? "Disconnect voice" : voiceMode === "connecting" ? "Connecting…" : "Connect AI voice"}
          </button>
        )}
        {config?.token_required && tokenOk === false && (
          <button className="icon-btn warn" onClick={() => void controller.enterToken()} title="Enter cockpit token">
            <Icon name="lock" />
          </button>
        )}
        <button className={`icon-btn ${soundOn ? "" : "off"}`} onClick={() => controller.toggleSound()} title="Sound on/off (M)">
          <Icon name={soundOn ? "speaker" : "mute"} />
        </button>
        <button className={`icon-btn ${gesturesOn ? "on" : ""}`} onClick={() => patch({ gesturesOn: !gesturesOn })} title="Hand gestures">
          <Icon name="hand" />
        </button>
        <button className="icon-btn" onClick={() => patch({ qrOpen: true })} title="QR code for phones (Q)">
          <Icon name="qr" />
        </button>
        <button className="icon-btn" onClick={() => patch({ demoOpen: !useStore.getState().demoOpen })} title="Demo controls (D)">
          <Icon name="sliders" />
        </button>
        <Clock />
      </div>
    </header>
  );
}
