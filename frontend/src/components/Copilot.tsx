// The copilot column: one conversation for alerts, answers and actions.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { controller } from "../controller";
import { api } from "../lib/api";
import { KIND_LABEL } from "../lib/format";
import { meters } from "../lib/live";
import { useStore, type FeedItem } from "../state/store";
import type { VoiceActivity } from "../types";
import { KIND_DE } from "./de";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const ACTIVITY_RGB: Record<VoiceActivity, [number, number, number]> = {
  idle: [196, 22, 28],
  listening: [30, 142, 62],
  thinking: [217, 119, 6],
  speaking: [196, 22, 28],
};

/** The copilot's presence: rings that breathe with its voice. */
export function Orb({ size = 64 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activity = useStore((s) => s.activity);
  const activityRef = useRef(activity);
  activityRef.current = activity;

  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const draw = (now: number) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const px = canvas.clientWidth;
        if (canvas.width !== Math.round(px * dpr)) canvas.width = canvas.height = Math.round(px * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, px, px);
        const act = activityRef.current;
        const target = act === "speaking" || act === "listening" ? Math.max(meters.level, 0.1) : act === "thinking" ? 0.16 : 0.04;
        smooth += (target - smooth) * 0.18;
        const [r, g, b] = ACTIVITY_RGB[act];
        const c = px / 2;
        const base = px * 0.17;
        const t = now / 1000;
        for (let i = 0; i < 3; i++) {
          const wobble = Math.sin(t * (1.5 + i * 0.8) + i) * 0.5 + 0.5;
          const radius = base + i * px * 0.07 + smooth * px * 0.2 * (1 - i * 0.2) + wobble * 1.5;
          ctx.beginPath();
          ctx.arc(c, c, radius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${b},${0.75 - i * 0.22})`;
          ctx.lineWidth = 2.2 - i * 0.5;
          ctx.stroke();
        }
        if (act === "thinking") {
          ctx.beginPath();
          ctx.arc(c, c, base + px * 0.1, t * 4, t * 4 + Math.PI * 0.6);
          ctx.strokeStyle = `rgba(${r},${g},${b},0.95)`;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(c, c, base * (0.62 + smooth * 0.5), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.85})`;
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas className="orb" style={{ width: size, height: size }} ref={canvasRef} aria-label={`Copilot ${activity}`} />;
}

function Item({ item, assistant }: { item: FeedItem; assistant: string }) {
  const sensorName = (id: string) => controller.sensorName(id);
  switch (item.type) {
    case "alert": {
      const e = item.event;
      return (
        <li className={`feed-alert sev-${e.severity}`}>
          <div className="feed-meta">
            <strong>{KIND_DE[e.kind] ?? KIND_LABEL[e.kind]} am {sensorName(e.sensor)}</strong>
            <time>{new Date(e.t * 1000).toLocaleTimeString("de-DE")}</time>
          </div>
          <p>{e.summary}</p>
          <div className="feed-actions">
            <button onClick={() => controller.showForEvent(e)}>Diagramm zeigen</button>
            <button onClick={() => void api.createReport(e.id)}>Bericht schreiben</button>
            {e.kind === "wrong_part" && (
              <button onClick={() => controller.openPartCheck(e.sensor)}>Teileprüfung</button>
            )}
            {(e.kind === "jam" || e.kind === "double_feed" || e.kind === "trend" || e.kind === "wrong_part") && (
              <button onClick={() => controller.openParts(e.sensor)}>Teile-Log</button>
            )}
          </div>
        </li>
      );
    }
    case "say":
      return (
        <li className={`feed-say who-${item.who}`}>
          <span className="feed-who">{item.who === "you" ? "Du" : item.who === "ai" ? assistant : "Cockpit"}</span>
          {item.who === "ai" && item.final
            ? <div className="feed-md"><Markdown text={item.text} /></div>
            : <p>{item.text}{!item.final && <span className="caret" />}</p>}
        </li>
      );
    case "report":
      return (
        <li className="feed-note feed-report">
          <Icon name="doc" size={16} />
          <p>Bericht fertig: {item.title}</p>
          <button onClick={() => controller.openReport(item.reportId)}>Öffnen</button>
        </li>
      );
  }
}

export function Copilot() {
  const config = useStore((s) => s.config);
  const feed = useStore((s) => s.feed);
  const voiceMode = useStore((s) => s.voiceMode);
  const voiceError = useStore((s) => s.voiceError);
  const activity = useStore((s) => s.activity);
  const speakAlerts = useStore((s) => s.speakAlerts);
  const patch = useStore((s) => s.patch);
  const [text, setText] = useState("");
  const [holding, setHolding] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const assistant = config?.assistant_name ?? "Copilot";
  const ai = voiceMode === "ready";

  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [feed]);

  const status = ai
    ? { listening: "Hört zu", thinking: "Denkt nach", speaking: "Spricht", idle: "Bereit. Leertaste halten zum Sprechen" }[activity]
    : voiceMode === "connecting" ? "Verbinde die Stimme …"
      : voiceMode === "error" ? `Stimme fehlgeschlagen: ${voiceError ?? "unbekannter Fehler"}`
        : config?.voice.enabled ? "KI-Stimme aus" : "Browser-Stimme (kein API-Schlüssel)";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    void controller.submitText(value);
  };
  const press = () => { setHolding(true); controller.pttDown(); };
  const release = () => { if (holding) { setHolding(false); void controller.pttUp(); } };

  return (
    <aside className="copilot">
      <header className="copilot-head">
        <Orb size={34} />
        <div>
          <div className="copilot-name">{assistant}</div>
          <div className={`copilot-status ${voiceMode === "error" ? "is-error" : ""}`}>{status}</div>
        </div>
        {config?.voice.enabled && (
          <button className="quiet-btn" onClick={() => (ai ? controller.disconnectVoice() : void controller.connectVoice())}>
            {ai ? "Trennen" : voiceMode === "connecting" ? "Verbinde …" : "KI verbinden"}
          </button>
        )}
      </header>

      <ol className="feed" ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}>
        {feed.length === 0 && (
          <li className="feed-empty">
            <p>{assistant} beobachtet {config?.sensors.length === 1 ? "den Sensor" : `${config?.sensors.length ?? 0} Sensoren`} und meldet sich, wenn sich etwas ändert.</p>
            <p className="muted">Zum Beispiel: „how many parts“, „show me a bar chart“, „explain this chart“ oder „write a report“.</p>
          </li>
        )}
        {feed.map((item) => <Item key={item.id} item={item} assistant={assistant} />)}
      </ol>

      <form className="composer" onSubmit={submit}>
        <button type="button" className={`talk ${holding ? "is-on" : ""}`}
                onPointerDown={press} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
                title="Halten zum Sprechen (oder Leertaste halten)">
          <Icon name="mic" size={22} />
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)}
               placeholder={`Frag ${assistant} …`} aria-label={`Nachricht an ${assistant}`} />
        <button className="send" type="submit" title="Senden" disabled={!text.trim()}>
          <Icon name="send" size={18} />
        </button>
      </form>
      <label className="speak-toggle">
        <input type="checkbox" checked={speakAlerts} onChange={(e) => patch({ speakAlerts: e.target.checked })} />
        Meldungen vorlesen
      </label>
    </aside>
  );
}
