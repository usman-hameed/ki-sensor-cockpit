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
    <div className="camera-pip">
      <div className={`camera-frame turn-${turn}`} ref={box}>
        {flash && <div className="camera-flash" key={cam.snapAt} />}
      </div>
      <div className="camera-bar">
        <span className="camera-dot" />
        <span className="camera-label">{cam.snapPart ? `Part ${cam.snapPart} photographed` : "Live"}</span>
        <button className="icon-only" title="Turn the picture a quarter (also the photos)" onClick={() => setTurn(camera.rotate())}>⟳</button>
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
