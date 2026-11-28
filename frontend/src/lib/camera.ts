// The camera next to the sensor (a webcam or a USB camera on the cockpit laptop): a live preview and a JPEG
// snapshot of each part while it rests under the laser.

const KEY = "cockpit-camera";

const TURN_KEY = "cockpit-camera-turn";

export class Camera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  /** clockwise quarter turns for a camera mounted sideways or upside down: 0, 90, 180 or 270 */
  turn = 0;

  constructor() {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      this.turn = Number(localStorage.getItem(TURN_KEY)) || 0;
    } catch {
      this.turn = 0;
    }
  }

  /** Turn the picture by another quarter, and remember it. */
  rotate(): number {
    this.turn = (this.turn + 90) % 360;
    try {
      localStorage.setItem(TURN_KEY, String(this.turn));
    } catch {
      /* private mode */
    }
    return this.turn;
  }

  get on(): boolean {
    return this.stream !== null;
  }

  /** The cameras the browser can see (names appear after the first permission). */
  static async list(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  }

  static saved(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  /** The camera in use now. */
  get deviceId(): string | null {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  }

  /** ``chosen``: the operator picked this camera, so an error is shown instead of falling back to another one. */
  async start(deviceId?: string | null, chosen = false): Promise<string> {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use a camera here (it needs localhost or https).");
    const video: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (error) {
      if (!deviceId || chosen) throw error;
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });  // the saved camera is gone
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    const id = stream.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    try {
      if (id) localStorage.setItem(KEY, id);
    } catch {
      /* private mode */
    }
    return stream.getVideoTracks()[0]?.label || "camera";
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  /** The current frame as a JPEG, at most 960 px wide. */
  async snapshot(): Promise<Blob | null> {
    const v = this.video;
    if (!this.stream || !v.videoWidth) return null;
    const side = this.turn === 90 || this.turn === 270;
    const scale = Math.min(1, 960 / (side ? v.videoHeight : v.videoWidth));
    const w = Math.round(v.videoWidth * scale);
    const h = Math.round(v.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = side ? h : w;
    canvas.height = side ? w : h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((this.turn * Math.PI) / 180);
    ctx.drawImage(v, -w / 2, -h / 2, w, h);
    ctx.restore();
    // the time in the corner, as on an inspection photo
    ctx.font = `${Math.round(canvas.height / 24)}px sans-serif`;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const stamp = new Date().toLocaleTimeString();
    const tw = ctx.measureText(stamp).width + 16;
    ctx.fillRect(canvas.width - tw - 8, canvas.height - canvas.height / 14 - 8, tw, canvas.height / 14);
    ctx.fillStyle = "#fff";
    ctx.fillText(stamp, canvas.width - tw, canvas.height - 8 - canvas.height / 60);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82));
  }
}

export const camera = new Camera();
