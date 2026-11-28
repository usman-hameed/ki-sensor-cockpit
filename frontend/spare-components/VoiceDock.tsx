import { useEffect, useRef, useState, type FormEvent } from "react";
import { controller } from "../controller";
import { meters } from "../lib/live";
import { useStore } from "../state/store";
import type { VoiceActivity } from "../types";
import { Icon } from "./Icon";

const ACTIVITY_COLOR: Record<VoiceActivity, [number, number, number]> = {
  idle: [34, 211, 238],
  listening: [52, 211, 153],
  thinking: [167, 139, 250],
  speaking: [34, 211, 238],
};

function Orb() {
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
        const size = canvas.clientWidth;
        if (canvas.width !== Math.round(size * dpr)) {
          canvas.width = canvas.height = Math.round(size * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size, size);
        const act = activityRef.current;
        const target = act === "speaking" || act === "listening" ? Math.max(meters.level, 0.08) : act === "thinking" ? 0.15 : 0.03;
        smooth += (target - smooth) * 0.18;
        const [r, g, b] = ACTIVITY_COLOR[act];
        const c = size / 2;
        const base = size * 0.2;
        const t = now / 1000;
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < 4; i++) {
          const wobble = Math.sin(t * (1.6 + i * 0.7) + i) * 0.5 + 0.5;
          const radius = base + i * size * 0.05 + smooth * size * 0.22 * (1 - i * 0.18) + wobble * 2;
          ctx.beginPath();
          ctx.arc(c, c, radius, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${r},${g},${b},${0.55 - i * 0.12})`;
          ctx.lineWidth = 2 - i * 0.35;
          ctx.shadowColor = `rgb(${r},${g},${b})`;
          ctx.shadowBlur = 14;
          ctx.stroke();
        }
        if (act === "thinking") {
          ctx.beginPath();
          ctx.arc(c, c, base + size * 0.12, t * 4, t * 4 + Math.PI * 0.6);
          ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        const core = ctx.createRadialGradient(c, c, 0, c, c, base);
        core.addColorStop(0, `rgba(${r},${g},${b},${0.55 + smooth * 0.4})`);
        core.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(c, c, base, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return <canvas className="orb" ref={canvasRef} aria-label={`Voice ${activity}`} />;
}

export function VoiceDock() {
  const config = useStore((s) => s.config);
  const voiceMode = useStore((s) => s.voiceMode);
  const activity = useStore((s) => s.activity);
  const captions = useStore((s) => s.captions);
  const speakAlerts = useStore((s) => s.speakAlerts);
  const pending = useStore((s) => s.pending);
  const voiceError = useStore((s) => s.voiceError);
  const patch = useStore((s) => s.patch);
  const [text, setText] = useState("");
  const [holding, setHolding] = useState(false);

  const lastAi = [...captions].reverse().find((c) => c.who === "ai" || c.who === "system");
  const lastYou = [...captions].reverse().find((c) => c.who === "you");
  const ai = voiceMode === "ready";
  const modeText = ai
    ? `AI voice · ${config?.voice.model ?? ""}`
    : voiceMode === "connecting"
      ? "Connecting AI voice…"
      : voiceMode === "error"
        ? `AI voice failed (${voiceError ?? "unknown error"}) · offline voice active`
        : config?.voice.enabled
        ? "Offline voice · connect AI voice for full conversations"
        : "Offline voice · no API key set";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void controller.submitText(text);
    setText("");
  };

  const press = () => {
    setHolding(true);
    controller.pttDown();
  };
  const release = () => {
    if (!holding) return;
    setHolding(false);
    void controller.pttUp();
  };

  return (
    <section className="dock">
      <Orb />
      <div className="captions">
        <div className="caption-you">{lastYou ? `You: ${lastYou.text}` : "Hold Space or the button and speak"}</div>
        <div className={`caption-ai ${lastAi?.who === "system" ? "caption-system" : ""}`}>
          {lastAi?.text ?? `${config?.assistant_name ?? "Copilot"} is watching the sensors.`}
        </div>
        <div className="caption-mode">
          <span className={`dot dot-${ai ? "ok" : voiceMode === "error" ? "bad" : "idle"}`} />
          {modeText}
          {pending && <span className="pending"> · waiting for yes or no</span>}
          <span className="activity">{activity}</span>
        </div>
      </div>
      <div className="dock-controls">
        <button
          className={`ptt ${holding ? "ptt-on" : ""}`}
          onPointerDown={press}
          onPointerUp={release}
          onPointerLeave={release}
          onPointerCancel={release}
          title="Push to talk (hold Space)"
        >
          <Icon name="mic" size={26} />
          <span>{holding ? "Listening…" : "Hold to talk"}</span>
        </button>
        <form className="command" onSubmit={submit}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ai ? "Type to the copilot…" : "Type a command: show me the drift"}
            aria-label="Command"
          />
          <button className="icon-btn" type="submit" title="Send">
            <Icon name="send" />
          </button>
        </form>
        <label className="toggle">
          <input type="checkbox" checked={speakAlerts} onChange={(e) => patch({ speakAlerts: e.target.checked })} />
          Speak alerts
        </label>
      </div>
    </section>
  );
}
