// The digital twin: a live 3D model of the measuring setup (three.js).
//
// A granite measuring table with a fixture plate, an aluminium gantry, and one
// laser triangulation sensor per configured sensor. Each laser draws the real
// triangulation geometry: the emitted beam down to the surface it measures and
// the reflected beam back to the receiver lens. A faint band shows the sensor's
// measuring range. Whatever lies on the plate appears as a block whose top is
// the live reading: green for the taught part, red for a different one.
// Mission mode turns the lights down.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { buildIld5500, isIld5500 } from "./sensorModel";

export type TwinState = "ok" | "warning" | "critical" | "invalid";

export interface TwinSensor {
  id: string;
  /** the limits in signal units (µm): for a sensor with a data sheet its measuring range, 0 to 10 000 for a -10 */
  low: number;
  high: number;
  /** the extended measuring range around them, where the sensor still measures */
  extLow?: number;
  extHigh?: number;
  /** where the sensor sits on the gantry: left (angle pi) or right of the middle, and how far out */
  angle: number;
  radius: number;
  /** model name from the configuration; the optoNCDT 5500 gets its own 3D model, all others a generic body */
  model?: string;
}

/** What the part check knows about the thing under a sensor. */
export interface TwinPart {
  state: "no_reference" | "waiting" | "match" | "different" | "empty";
  /** the taught empty plate, in signal units; null when it was not taught */
  emptyUm: number | null;
}

export interface TwinSource {
  /** the latest reading in signal units (µm from the start of the measuring range), null without one */
  value(id: string): number | null;
  state(id: string): TwinState;
  part(id: string): TwinPart | null;
  /** every new reading of a sensor since tMin, oldest first */
  forEachSince(id: string, tMin: number, fn: (t: number, v: number) => void): void;
  /** the server's clock */
  now(): number;
}

export { trackFor } from "./tracks";

/** The part takes the colour of the part check's verdict. */
const PART_COLOR: Record<TwinPart["state"], THREE.Color> = {
  match: new THREE.Color("#1fb97c"),
  different: new THREE.Color("#ff3150"),
  waiting: new THREE.Color("#8d97a3"),
  no_reference: new THREE.Color("#8d97a3"),
  empty: new THREE.Color("#8d97a3"),
};

const STATE_COLOR: Record<TwinState, THREE.Color> = {
  ok: new THREE.Color("#d8262c"),
  warning: new THREE.Color("#ffa51f"),
  critical: new THREE.Color("#ff3150"),
  invalid: new THREE.Color("#d8262c"),
};

const LOOK = {
  // bloom stays off in the bright room: shiny metal would glow along with the lasers
  light: { bg: new THREE.Color("#e9ecef"), shadow: 0.2, env: 0.75, bloom: 0.0,
    threshold: 1.0, grid: 0.0, glow: 0.35, key: 1.8 },
  dark: { bg: new THREE.Color("#05060f"), shadow: 0.5, env: 0.2, bloom: 1.35,
    threshold: 0.9, grid: 0.45, glow: 0.8, key: 0.7 },
};
// lasers are drawn brighter than white so they, and only they, glow
const HDR = 3.2;

const TABLE_TOP = 0.5;
const BEAM_Y = 2.0;
const SENSOR_BOTTOM = BEAM_Y - 0.09 - 0.42;
// The measuring range is drawn from RANGE_TOP (its start, nearest the sensor) down to RANGE_BOTTOM (its end).
// Heights are drawn larger than life, so that a part of a few millimetres is clearly visible.
const RANGE_TOP = 1.22;
const RANGE_BOTTOM = 0.68;
/** a block thinner than this (in scene units) is the plate itself, not a part */
const MIN_PART = 0.012;
/** without a taught empty plate, the farthest surface of the last minutes counts as the plate */
const PLATE_MEMORY_S = 120;
/** a surface this close to the farthest one is the farthest one */
const PLATE_GAP_UM = 300;

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A beam between two points: a thin bright core and a soft glow around it. */
class Beam {
  readonly group = new THREE.Group();
  private readonly core: THREE.Mesh;
  private readonly halo: THREE.Mesh;
  readonly coreMat: THREE.MeshBasicMaterial;
  readonly haloMat: THREE.MeshBasicMaterial;

  constructor(radius: number, haloRadius: number) {
    this.coreMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.ok, toneMapped: false, transparent: true });
    this.haloMat = new THREE.MeshBasicMaterial({ color: STATE_COLOR.ok, toneMapped: false, transparent: true,
      opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });
    this.core = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8, 1, true), this.coreMat);
    this.halo = new THREE.Mesh(new THREE.CylinderGeometry(haloRadius, haloRadius, 1, 12, 1, true), this.haloMat);
    this.group.add(this.core, this.halo);
  }

  set(from: THREE.Vector3, to: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = dir.length();
    this.group.position.copy(from).addScaledVector(dir, 0.5);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.group.scale.set(1, Math.max(len, 1e-4), 1);
  }
}

interface SensorRig {
  cfg: TwinSensor;
  anchor: THREE.Object3D; // where the label points
  emitted: Beam;
  reflected: Beam;
  spot: THREE.Sprite;
  led: THREE.MeshBasicMaterial;
  emitter: THREE.Vector3;
  receiver: THREE.Vector3;
  x: number;
  /** the fixture plate under this sensor and the part on it */
  plate: THREE.Mesh;
  part: THREE.Mesh;
  partMat: THREE.MeshStandardMaterial;
  band: THREE.MeshBasicMaterial;
  /** smoothed heights in scene units: the plate top and the measured surface */
  plateY: number;
  surfaceY: number;
  /** the farthest reading of every second, for the plate when it was not taught */
  farthest: Map<number, number>;
  lastT: number;
  color: THREE.Color;
}

export class Twin {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly floorMat: THREE.ShadowMaterial;
  private readonly gridMat: THREE.LineBasicMaterial;
  private readonly key: THREE.DirectionalLight;
  private readonly gantry = new THREE.Group();
  private readonly scan: THREE.Mesh;
  private readonly rigs: SensorRig[] = [];
  private readonly glow = glowTexture();
  private readonly clock = new THREE.Clock();
  private raf = 0;
  private dark = 0; // 0 light .. 1 dark, animated over a fixed time
  private darkFrom = 0;
  private darkTarget = 0;
  private darkAt = -10;
  private scanAt = -10;
  private lastInteraction = -10;
  private readonly resize: ResizeObserver;

  constructor(private readonly host: HTMLElement, sensors: TwinSensor[], private readonly source: TwinSource) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.background = LOOK.light.bg.clone();
    this.scene.fog = new THREE.Fog(LOOK.light.bg.clone(), 14, 30);

    this.camera.position.set(3.4, 3.3, 4.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.5;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = 1.38;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;
    this.controls.addEventListener("start", () => {
      this.lastInteraction = this.clock.elapsedTime;
      this.controls.autoRotate = false;
    });

    // light
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#8e98a6", 0.6));
    this.key = new THREE.DirectionalLight("#ffffff", LOOK.light.key);
    this.key.position.set(4, 7, 3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -4;
    this.key.shadow.camera.right = this.key.shadow.camera.top = 4;
    this.key.shadow.radius = 6;
    this.scene.add(this.key);

    // floor and grid
    // the floor only catches shadows, so there is no horizon line in the bright room
    this.floorMat = new THREE.ShadowMaterial({ color: "#1b2430", opacity: LOOK.light.shadow });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(16, 64), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(24, 48, "#d8262c", "#d8262c");
    this.gridMat = grid.material as THREE.LineBasicMaterial;
    this.gridMat.transparent = true;
    this.gridMat.opacity = 0;
    this.gridMat.toneMapped = false;
    grid.position.y = 0.002;
    this.scene.add(grid);

    this.buildMachine(sensors);

    // the scan plane that sweeps the machine once when mission mode starts
    this.scan = new THREE.Mesh(new THREE.PlaneGeometry(6, 4),
      new THREE.MeshBasicMaterial({ color: "#d8262c", transparent: true, opacity: 0, toneMapped: false,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.scan.rotation.x = -Math.PI / 2;
    this.scene.add(this.scan);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), LOOK.light.bloom, 0.55, LOOK.light.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();
    this.loop();
  }

  private buildMachine(sensors: TwinSensor[]): void {
    const granite = new THREE.MeshStandardMaterial({ color: "#2b3038", roughness: 0.55, metalness: 0.05 });
    const aluminium = new THREE.MeshStandardMaterial({ color: "#c7ced6", roughness: 0.32, metalness: 0.75 });
    const housing = new THREE.MeshStandardMaterial({ color: "#3b4149", roughness: 0.45, metalness: 0.4 });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number,
      parent: THREE.Object3D = this.scene) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    // granite measuring table on four feet
    add(new THREE.BoxGeometry(3.8, 0.42, 2.5), granite, 0, TABLE_TOP - 0.21, 0);
    for (const [x, z] of [[-1.6, -1], [1.6, -1], [-1.6, 1], [1.6, 1]]) {
      add(new THREE.CylinderGeometry(0.07, 0.09, 0.08, 16), housing, x, 0.04, z);
    }

    // gantry: two posts and a crossbeam
    this.scene.add(this.gantry);
    add(new THREE.BoxGeometry(0.2, BEAM_Y - TABLE_TOP + 0.1, 0.24), aluminium, -1.45, (BEAM_Y + TABLE_TOP) / 2, 0, this.gantry);
    add(new THREE.BoxGeometry(0.2, BEAM_Y - TABLE_TOP + 0.1, 0.24), aluminium, 1.45, (BEAM_Y + TABLE_TOP) / 2, 0, this.gantry);
    add(new THREE.BoxGeometry(3.12, 0.18, 0.24), aluminium, 0, BEAM_Y, 0, this.gantry);

    sensors.forEach((cfg) => {
      const x = cfg.angle === Math.PI ? -cfg.radius : cfg.radius;
      const detailed = cfg.model && isIld5500(cfg.model) ? buildIld5500(cfg.model) : null;
      let led: THREE.MeshBasicMaterial;
      let anchor: THREE.Object3D;
      let baseline = 0.11; // laser exit to receiver lens
      const cablePath: THREE.Vector3[] = [];
      if (detailed) {
        detailed.group.position.set(x, SENSOR_BOTTOM, 0);
        this.gantry.add(detailed.group);
        led = detailed.led;
        anchor = detailed.anchor;
        baseline = detailed.baseline;
        // the cable leaves next to the holder, steps out in front of the crossbeam and climbs over it
        const exit = detailed.cableExit;
        cablePath.push(
          new THREE.Vector3(x + exit.x, SENSOR_BOTTOM + exit.y, 0),
          new THREE.Vector3(x + exit.x + 0.03, SENSOR_BOTTOM + exit.y - 0.01, 0.11),
          new THREE.Vector3(x + exit.x + 0.06, BEAM_Y - 0.1, 0.15),
          new THREE.Vector3(x + exit.x + 0.06, BEAM_Y + 0.12, 0.16),
        );
      } else {
        const body = add(new THREE.BoxGeometry(0.24, 0.42, 0.2), housing, x + 0.05, SENSOR_BOTTOM + 0.21, 0.0, this.gantry);
        // front window and status LED
        const windowMat = new THREE.MeshStandardMaterial({ color: "#10131a", roughness: 0.05, metalness: 0.2 });
        add(new THREE.BoxGeometry(0.2, 0.012, 0.16), windowMat, 0, -0.21 - 0.006, 0, body);
        led = new THREE.MeshBasicMaterial({ color: STATE_COLOR.ok, toneMapped: false });
        const ledMesh = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 12), led);
        ledMesh.position.set(0.07, 0.14, 0.101);
        body.add(ledMesh);
        anchor = new THREE.Object3D();
        anchor.position.set(0, 0.21, 0);
        body.add(anchor);
        cablePath.push(
          new THREE.Vector3(x + 0.05, SENSOR_BOTTOM + 0.42, 0.06),
          new THREE.Vector3(x + 0.05, BEAM_Y + 0.16, 0.14),
        );
      }

      const emitted = new Beam(0.006, 0.028);
      const reflected = new Beam(0.003, 0.016);
      reflected.haloMat.opacity = 0.12;
      this.scene.add(emitted.group, reflected.group);

      const spot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: STATE_COLOR.ok, toneMapped: false,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      spot.scale.setScalar(0.16);
      this.scene.add(spot);

      // the measuring range: a faint band from its start down to its end, where the readings are valid
      const band = new THREE.MeshBasicMaterial({ color: "#d8262c", transparent: true, opacity: 0.07, toneMapped: false,
        side: THREE.DoubleSide, depthWrite: false });
      const bandMesh = new THREE.Mesh(new THREE.BoxGeometry(0.5, RANGE_TOP - RANGE_BOTTOM, 0.36), band);
      bandMesh.position.set(x, (RANGE_TOP + RANGE_BOTTOM) / 2, 0);
      this.scene.add(bandMesh);
      for (const y of [RANGE_TOP, RANGE_BOTTOM]) {
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.5, 0.36)),
          new THREE.LineBasicMaterial({ color: "#d8262c", transparent: true, opacity: 0.35, toneMapped: false }));
        edge.rotation.x = -Math.PI / 2;
        edge.position.set(x, y, 0);
        this.scene.add(edge);
      }

      // the fixture plate on the table, and the part on it (both unit boxes, scaled every frame)
      const plate = add(new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: "#9aa3ad", roughness: 0.35, metalness: 0.85 }), x, TABLE_TOP, 0);
      plate.scale.set(1.4, 0.001, 0.9);
      const partMat = new THREE.MeshStandardMaterial({ color: PART_COLOR.waiting, roughness: 0.3, metalness: 0.55,
        emissive: new THREE.Color("#000000") });
      const part = add(new THREE.BoxGeometry(1, 1, 1), partMat, x, TABLE_TOP, 0);
      part.scale.set(0.46, 0.001, 0.3);
      part.visible = false;

      // sensor cable, routed up over the beam and down the nearest post
      const side = x < 0 ? -1 : 1;
      const cable = new THREE.CatmullRomCurve3([
        ...cablePath,
        new THREE.Vector3(side * 1.25, BEAM_Y + 0.12, 0.16),
        new THREE.Vector3(side * 1.56, BEAM_Y - 0.2, 0.15),
        new THREE.Vector3(side * 1.57, TABLE_TOP + 0.2, 0.15),
      ]);
      add(new THREE.TubeGeometry(cable, 48, 0.014, 8, false),
        new THREE.MeshStandardMaterial({ color: "#1c2027", roughness: 0.7 }), 0, 0, 0, this.gantry);

      this.rigs.push({
        cfg, anchor, emitted, reflected, spot, led,
        emitter: new THREE.Vector3(x, SENSOR_BOTTOM, 0),
        receiver: new THREE.Vector3(x + baseline, SENSOR_BOTTOM, 0),
        x, plate, part, partMat, band,
        plateY: RANGE_BOTTOM, surfaceY: RANGE_BOTTOM,
        farthest: new Map(), lastT: 0,
        color: STATE_COLOR.ok.clone(),
      });
    });
  }

  /** Screen position (CSS pixels inside the host) of each sensor's label anchor. */
  labelPositions(): { id: string; x: number; y: number; visible: boolean }[] {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const v = new THREE.Vector3();
    return this.rigs.map((rig) => {
      rig.anchor.getWorldPosition(v);
      v.project(this.camera);
      return { id: rig.cfg.id, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, visible: v.z < 1 };
    });
  }

  setMission(on: boolean): void {
    this.darkFrom = this.dark;
    this.darkTarget = on ? 1 : 0;
    this.darkAt = this.clock.elapsedTime;
    if (on) this.scanAt = this.clock.elapsedTime + 0.4;
  }

  private fit(): void {
    const w = Math.max(this.host.clientWidth, 1);
    const h = Math.max(this.host.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    // keep the whole machine in view on narrow screens
    this.camera.fov = w / h < 1.2 ? 46 : w / h > 2.6 ? 30 : 36;
    this.camera.updateProjectionMatrix();
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;

    // lights: ease between the measuring room and mission mode
    const p = Math.min(Math.max((t - this.darkAt) / 1.6, 0), 1);
    this.dark = this.darkFrom + (this.darkTarget - this.darkFrom) * (p * p * (3 - 2 * p));
    const k = this.dark;
    (this.scene.background as THREE.Color).lerpColors(LOOK.light.bg, LOOK.dark.bg, k);
    (this.scene.fog as THREE.Fog).color.copy(this.scene.background as THREE.Color);
    this.floorMat.opacity = THREE.MathUtils.lerp(LOOK.light.shadow, LOOK.dark.shadow, k);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(LOOK.light.env, LOOK.dark.env, k);
    this.key.intensity = THREE.MathUtils.lerp(LOOK.light.key, LOOK.dark.key, k);
    this.bloom.strength = THREE.MathUtils.lerp(LOOK.light.bloom, LOOK.dark.bloom, k);
    this.bloom.threshold = THREE.MathUtils.lerp(LOOK.light.threshold, LOOK.dark.threshold, k);
    this.gridMat.opacity = THREE.MathUtils.lerp(LOOK.light.grid, LOOK.dark.grid, k);
    const glow = THREE.MathUtils.lerp(LOOK.light.glow, LOOK.dark.glow, k);

    // scan sweep after switching to mission mode
    const scanT = (t - this.scanAt) / 1.8;
    const scanMat = this.scan.material as THREE.MeshBasicMaterial;
    if (scanT >= 0 && scanT <= 1) {
      this.scan.position.y = THREE.MathUtils.lerp(0.02, 2.4, scanT);
      scanMat.opacity = 0.22 * Math.sin(Math.PI * scanT);
    } else {
      scanMat.opacity = 0;
    }

    // auto-rotation of the camera resumes after a pause
    if (!this.controls.autoRotate && t - this.lastInteraction > 6) this.controls.autoRotate = true;

    // the plate, the part on it and the lasers follow the live readings
    for (const rig of this.rigs) {
      const id = rig.cfg.id;
      const state = this.source.state(id);
      const value = this.source.value(id);
      const lost = value === null || !Number.isFinite(value);
      const part = this.source.part(id);
      rig.color.lerp(STATE_COLOR[state], Math.min(dt * 6, 1));
      const flicker = state === "invalid" ? (Math.sin(t * 40) > 0 ? 1 : 0.05) : 1;

      // the plate: where the empty plate was taught, otherwise the farthest surface of the last minutes. When the
      // taught part itself is that farthest surface (the plate is out of range or was not seen for minutes), the
      // part would have no height: then the far end of the range stands in for the plate, so the part stays visible
      const far = this.farthest(rig);
      const partIsFarthest = far !== null && !lost && part?.state === "match" && Math.abs(far - (value as number)) <= PLATE_GAP_UM;
      const plateUm = part?.emptyUm ?? (partIsFarthest ? null : far);
      const plateTarget = this.yOf(rig.cfg, plateUm ?? rig.cfg.extHigh ?? rig.cfg.high);
      rig.plateY += (plateTarget - rig.plateY) * Math.min(dt * 4, 1);
      // the surface the laser meets: the part's top, never below the plate
      const surfaceTarget = lost ? rig.plateY : Math.max(this.yOf(rig.cfg, value), rig.plateY);
      rig.surfaceY += (surfaceTarget - rig.surfaceY) * Math.min(dt * 10, 1);

      const plateH = Math.max(rig.plateY - TABLE_TOP, 0.001);
      rig.plate.scale.y = plateH;
      rig.plate.position.y = TABLE_TOP + plateH / 2;
      const partH = rig.surfaceY - rig.plateY;
      rig.part.visible = !lost && partH > MIN_PART && part?.state !== "empty";
      if (rig.part.visible) {
        rig.part.scale.y = partH;
        rig.part.position.y = rig.plateY + partH / 2;
      }
      const verdict = part?.state ?? "waiting";
      rig.partMat.color.lerp(PART_COLOR[verdict], Math.min(dt * 6, 1));
      const alarm = verdict === "different" ? 0.25 + 0.2 * Math.sin(t * 6) : 0;
      rig.partMat.emissive.copy(PART_COLOR.different).multiplyScalar(alarm + 0.15 * k * (verdict === "match" ? 0 : 1));
      if (verdict === "match") rig.partMat.emissive.copy(PART_COLOR.match).multiplyScalar(0.25 * k);
      rig.band.opacity = 0.06 + 0.08 * k;

      const surface = new THREE.Vector3(rig.x, rig.surfaceY, 0);
      rig.emitted.set(rig.emitter, surface);
      rig.reflected.set(surface, rig.receiver);
      for (const beam of [rig.emitted, rig.reflected]) {
        beam.coreMat.color.copy(rig.color).multiplyScalar(HDR);
        beam.haloMat.color.copy(rig.color).multiplyScalar(1.4);
        beam.coreMat.opacity = (lost ? 0.25 : 1) * flicker;
      }
      rig.emitted.haloMat.opacity = glow * flicker;
      rig.reflected.haloMat.opacity = glow * 0.45 * flicker;
      rig.spot.position.copy(surface);
      rig.spot.material.color.copy(rig.color).multiplyScalar(HDR);
      rig.spot.material.opacity = flicker;
      rig.spot.scale.setScalar(0.13 + 0.06 * glow + (state === "ok" ? 0 : 0.04 * Math.sin(t * 10)));
      rig.led.color.copy(rig.color).multiplyScalar(HDR);
    }

    this.controls.update();
    this.composer.render(dt);
  };

  /** Height in the scene of a reading: the start of the measuring range is at the top, its end at the bottom. */
  private yOf(cfg: TwinSensor, value: number): number {
    const share = (value - cfg.low) / (cfg.high - cfg.low || 1);
    return THREE.MathUtils.clamp(RANGE_TOP - share * (RANGE_TOP - RANGE_BOTTOM), TABLE_TOP + 0.002, SENSOR_BOTTOM - 0.03);
  }

  /**
   * The farthest surface of the last minutes: with no empty plate taught, that is the plate. Each second counts
   * with its median, so the edge of a part sliding in does not count as a surface.
   */
  private farthest(rig: SensorRig): number | null {
    const now = this.source.now();
    let second = -1;
    let values: number[] = [];
    const close = () => {
      if (second < 0 || values.length < 3) return;
      values.sort((a, b) => a - b);
      rig.farthest.set(second, values[Math.floor(values.length / 2)]);
    };
    const from = rig.lastT > 0 ? Math.floor(rig.lastT) : now - PLATE_MEMORY_S;
    this.source.forEachSince(rig.cfg.id, from, (t, v) => {
      const s = Math.floor(t);
      if (s !== second) {
        close();
        second = s;
        values = [];
      }
      if (Number.isFinite(v)) values.push(v);
      rig.lastT = t;
    });
    // the second still running is left open: it is read again next frame
    let best: number | null = null;
    for (const [s, v] of rig.farthest) {
      if (s < now - PLATE_MEMORY_S) rig.farthest.delete(s);
      else if (best === null || v > best) best = v;
    }
    return best;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
