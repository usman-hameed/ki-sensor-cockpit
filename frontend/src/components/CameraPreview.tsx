// The live picture of the camera next to the sensor; it flashes when a part is photographed.
import { useEffect, useRef, useState } from "react";
import { controller } from "../controller";
import { Camera, camera } from "../lib/camera";
import { useStore } from "../state/store";
import { Icon } from "./Icon";

export function CameraPreview() {
  const cam = useStore((s) => s.camera);
  const box = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [turn, setTurn] = useState(camera.turn);
  // where the picture floats: dragged by its bar, remembered
  const [at, setAt] = useState<{ x: number; y: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem("cockpit-camera-at") ?? "null"); } catch { return null; }
  });
  const [dragging, setDragging] = useState(false);
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, select")) return;
    const pip = e.currentTarget.parentElement;
    if (!pip) return;
    const r = pip.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    setDragging(true);
    let last = { x: r.left, y: r.top };
    const move = (ev: PointerEvent) => {
      last = {
        x: Math.min(Math.max(ev.clientX - dx, 0), window.innerWidth - r.width),
        y: Math.min(Math.max(ev.clientY - dy, 0), window.innerHeight - 40),
      };
      setAt(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(false);
      try { localStorage.setItem("cockpit-camera-at", JSON.stringify(last)); } catch { /* private mode */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // every camera Windows offers (a phone in USB webcam mode appears here once it is plugged in)
  useEffect(() => {
    if (!cam.on) return;
    const load = () => void Camera.list().then(setDevices);
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", load);
  }, [cam.on, cam.label]);

  useEffect(() => {
    const host = box.current;
    if (!cam.on || !host) return;
    host.prepend(camera.video);
    void camera.video.play().catch(() => undefined);
    return () => {
      if (camera.video.parentElement === host) host.removeChild(camera.video);
    };
  }, [cam.on]);

  if (!cam.on) return null;
  const flash = Date.now() - cam.snapAt < 900;
  return (
    <div className={`camera-pip ${dragging ? "is-dragging" : ""}`}
      style={at ? { left: at.x, top: at.y, right: "auto", bottom: "auto" } : undefined}>
      <div className={`camera-frame turn-${turn}`} ref={box}>
        {flash && <div className="camera-flash" key={cam.snapAt} />}
      </div>
      <div className="camera-bar" onPointerDown={drag} title="Drag to move">
        <span className="camera-dot" />
        <span className="camera-label">{cam.snapPart ? `Part ${cam.snapPart} photographed` : "Live · drag to move"}</span>
        <button className="icon-only" title="Turn the picture 90° (the photos too)" onClick={() => setTurn(camera.rotate())}>⟳</button>
        <button className="icon-only" title="Camera off" onClick={() => void controller.toggleCamera()}><Icon name="close" /></button>
      </div>
      <div className="camera-bar">
        <select className="camera-select" value={camera.deviceId ?? ""} title="Which camera"
          onChange={(e) => void controller.useCamera(e.target.value)}>
          {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
        </select>
      </div>
    </div>
  );
}
