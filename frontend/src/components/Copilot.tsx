// The copilot column: one conversation for alerts, answers and actions.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { controller } from "../controller";
import { api } from "../lib/api";
import { clock, KIND_LABEL } from "../lib/format";
import { meters } from "../lib/live";
import { useStore, type FeedItem } from "../state/store";
import type { VoiceActivity } from "../types";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const ACTIVITY_RGB: Record<VoiceActivity, [number, number, number]> = {
  idle: [106, 82, 255],
  listening: [19, 160, 110],
  thinking: [138, 124, 248],
  speaking: [106, 82, 255],
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
            <strong>{KIND_LABEL[e.kind]} on {sensorName(e.sensor)}</strong>
            <time>{clock(e.t)}</time>
          </div>
          <p>{e.summary}</p>
          <div className="feed-actions">
            <button onClick={() => controller.showForEvent(e)}>Show chart</button>
            <button onClick={() => void api.createReport(e.id)}>Write report</button>
            {e.kind === "wrong_part" && (
              <button onClick={() => controller.openPartCheck(e.sensor)}>Part check</button>
            )}
            {(e.kind === "jam" || e.kind === "double_feed" || e.kind === "trend" || e.kind === "wrong_part") && (
              <button onClick={() => controller.openParts(e.sensor)}>Part log</button>
            )}
          </div>
        </li>
      );
    }
    case "say":
      return (
        <li className={`feed-say who-${item.who}`}>
          <span className="feed-who">{item.who === "you" ? "You" : item.who === "ai" ? assistant : "Cockpit"}</span>
          {item.who === "ai" && item.final
            ? <div className="feed-md"><Markdown text={item.text} /></div>
            : <p>{item.text}{!item.final && <span className="caret" />}</p>}
        </li>
      );
    case "report":
      return (
        <li className="feed-note feed-report">
          <Icon name="doc" size={16} />
          <p>Report ready: {item.title}</p>
          <button onClick={() => controller.openReport(item.reportId)}>Open</button>
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
    ? { listening: "Listening", thinking: "Thinking", speaking: "Speaking", idle: "Ready. Hold Space to talk" }[activity]
    : voiceMode === "connecting" ? "Connecting the voice…"
      : voiceMode === "error" ? `Voice failed: ${voiceError ?? "unknown error"}`
        : config?.voice.enabled ? "Voice is off" : "Browser voice (no API key)";

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
        <Orb size={56} />
        <div>
          <div className="copilot-name">{assistant}</div>
          <div className={`copilot-status ${voiceMode === "error" ? "is-error" : ""}`}>{status}</div>
        </div>
        {config?.voice.enabled && (
          <button className="quiet-btn" onClick={() => (ai ? controller.disconnectVoice() : void controller.connectVoice())}>
            {ai ? "Disconnect" : voiceMode === "connecting" ? "Connecting…" : "Connect voice"}
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
            <p>{assistant} is watching {config?.sensors.length === 1 ? "the sensor" : `${config?.sensors.length ?? 0} sensors`} and will speak up when something changes.</p>
            <p className="muted">Try “show me the whole shift”, “how are the readings spread?”, “do the sensors move
              together?”, “explain this chart” or “is sensor 1 set up well?”.</p>
          </li>
        )}
        {feed.map((item) => <Item key={item.id} item={item} assistant={assistant} />)}
      </ol>

      <form className="composer" onSubmit={submit}>
        <button type="button" className={`talk ${holding ? "is-on" : ""}`}
                onPointerDown={press} onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
                title="Hold to talk (or hold Space)">
          <Icon name="mic" size={22} />
        </button>
        <input value={text} onChange={(e) => setText(e.target.value)}
               placeholder={`Ask ${assistant} something`} aria-label={`Message to ${assistant}`} />
        <button className="send" type="submit" title="Send" disabled={!text.trim()}>
          <Icon name="send" size={18} />
        </button>
      </form>
      <label className="speak-toggle">
        <input type="checkbox" checked={speakAlerts} onChange={(e) => patch({ speakAlerts: e.target.checked })} />
        Read alerts out loud
      </label>
    </aside>
  );
}
