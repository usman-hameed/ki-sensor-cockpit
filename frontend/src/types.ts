// Message and data shapes shared with the backend (see docs/CONTRACT.md).

export type Severity = "info" | "warning" | "critical";
export type EventKind = "out_of_range" | "invalid" | "wrong_part" | "jam" | "double_feed" | "trend";
export type SensorState = "ok" | "warning" | "critical";
export type ChartView = "timeseries" | ExploreChart;
export type ExploreChart = "histogram" | "boxplot" | PartChart;
/** charts of the part log: one value per part */
export type PartChart = "parts" | "part_counts" | "part_heights";

export interface Tolerance {
  low: number;
  high: number;
}

/** Positions are shown in the sensor's own unit (mm); the signal itself stays in `unit` (µm). */
export interface Display {
  unit: string;
  /** signal unit times scale is the shown unit */
  scale: number;
  decimals: number;
}

/** The data sheet of a known sensor model (see backend/app/sensor_specs.py). Distances are from the start of the range. */
export interface SensorSpecInfo {
  family: string;
  model: string;
  title: string;
  measuring_range_mm: number;
  start_mm: number;
  mid_mm: number;
  end_mm: number;
  /** extended range, measuring range and middle in signal units (µm) from the start of the measuring range */
  zones_um: { ext_low: number; low: number; mid: number; high: number; ext_high: number };
  linearity_um: number;
  repeatability_um: number;
  temperature_um_per_k: number;
  manual: string;
}

/** Where a reading lies, in the words of the sensor's state LED. */
export type RangeZone = "standard" | "before" | "after" | "outside";

export interface SensorInfo {
  id: string;
  name: string;
  model: string;
  unit: string;
  nominal: number;
  tolerance: Tolerance;
  /** part: the tolerance of the workpiece. measuring_range: the measuring range of the sensor */
  tolerance_kind: "part" | "measuring_range";
  /** what the limits are called in texts: "tolerance" or "measuring range" */
  limit_word: string;
  display: Display | null;
  spec: SensorSpecInfo | null;
  source: string;
}

export interface CockpitConfig {
  title: string;
  team: string;
  assistant_name: string;
  language: string;
  sensors: SensorInfo[];
  voice: { enabled: boolean; model: string };
  token_required: boolean;
  alert_prefix: string;
  version: string;
}

export interface CockpitEvent {
  type: "event";
  id: string;
  sensor: string;
  kind: EventKind;
  severity: Severity;
  t: number;
  numbers: Record<string, number | string>;
  summary: string;
  forecast_min: number | null;
  related_sensors: string[];
}

/** Connection of the sensor (the optoNCDT 5500 over Ethernet, or a MEDAQLib sensor). */
export interface LiveStatus {
  kind: string;
  /** offline: cannot connect. no_data: connected, nothing arrives. invalid: readings arrive but are mostly invalid. */
  state: "offline" | "no_data" | "streaming" | "invalid";
  message: string;
  host: string;
  port: number;
  rate_hz: number | null;
  article: number | null;
  serial: number | null;
  samples: number;
  invalid_percent: number | null;
  last_status: string | null;
  reference_mm: number | null;
  /** how the readings were counted: range_start (as the sensor reports), auto, mid or a number */
  reference?: string;
  /** why readings were invalid in the last seconds: status code name to share (0 to 1) */
  invalid_reasons?: Record<string, number>;
  intensity_percent: number | null;
  temperature_c: number | null;
}

/** The part check: one taught part, everything else is flagged. Positions are in the signal unit (µm). */
export interface PartState {
  supported: boolean;
  /** no_reference: nothing taught. match: the taught part. different: another part. empty: the taught empty plate. */
  state: "no_reference" | "waiting" | "match" | "different" | "empty";
  /** the last 0.4 s were steady enough to tell what lies under the sensor */
  steady: boolean;
  position_um: number | null;
  message: string;
  reference: {
    center_um: number; half_width_um: number; margin_um: number; parts: number;
    low_um: number; high_um: number; taught_at: number;
  } | null;
  empty_um: number | null;
  /** height of the taught part above the taught empty plate */
  height_um: number | null;
  alerts: number;
}

/** One part that rested under the sensor (backend station.py). */
export interface PartRecord {
  number: number;
  sensor: string;
  t_start: number;
  t_end: number;
  dwell_s: number;
  gap_s: number | null;
  /** top surface, µm from the start of the measuring range */
  position_um: number;
  /** height above the taught empty plate */
  height_um: number | null;
  /** top surface minus the taught part's */
  deviation_um: number;
  verdict: "good" | "different";
  /** jam, double_feed, unsteady */
  flags: string[];
  /** the height and the top surface as the sensor writes them, e.g. "6.0012 mm" */
  height?: string | null;
  position?: string;
  /** the camera picture of the part, if the cockpit's camera was on */
  photo?: string | null;
}

export interface StationState {
  ready: boolean;
  message: string;
  parts: number;
  good: number;
  different: number;
  jams: number;
  double_feeds: number;
  yield_percent: number | null;
  per_minute: number | null;
  rhythm: { known: boolean; dwell_s: number | null; gap_s: number | null };
  trend: {
    slope_um_per_part: number; r2: number; parts: number; parts_to_limit: number | null;
    direction: "higher" | "lower"; clear: boolean;
  } | null;
  /** the part under the sensor right now */
  current: { number: number; since_s: number; position_um: number | null; flags: string[] } | null;
  run_started: number | null;
  last: PartRecord | null;
  /** newest first, only from GET /api/parts */
  records?: PartRecord[];
}

export interface SensorStatus {
  latest: number | null;
  mean_1s: number | null;
  noise: number | null;
  state: SensorState;
  active: EventKind[];
  source: { type: string; error: string | null };
  live?: LiveStatus | null;
  part?: PartState;
  station?: StationState;
  read_error: string | null;
}

export interface StatusMessage {
  type: "status";
  t: number;
  uptime_s: number;
  clients: { cockpit: number; phone: number };
  sensors: Record<string, SensorStatus>;
}

export interface SamplesMessage {
  type: "samples";
  sensor: string;
  t0: number;
  dt: number;
  unit: string;
  values: (number | null)[];
}

export interface HelloMessage {
  type: "hello";
  config: CockpitConfig;
  events: CockpitEvent[];
  status: StatusMessage;
}

export type ServerMessage =
  | HelloMessage
  | StatusMessage
  | SamplesMessage
  | CockpitEvent
  | { type: "report"; id: string; title: string }
  | { type: "part"; sensor: string; part: PartRecord | null; station: StationState }
  | { type: "pong"; t: number };

export interface ChartSpec {
  view: ChartView;
  sensors: string[];
  window_s?: number;
  event_id?: string;
  group_by?: "minute" | "10min" | "hour";
}

/** What to point at while one explanation step is spoken (see backend insights.py). */
export interface Anchor {
  type: "x" | "point" | "xspan" | "yspan" | "grid" | "category" | "line" | "zoom";
  t?: number;
  x?: number;
  y?: number;
  t0?: number;
  t1?: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  index?: number;
  sensor?: string;
  label?: string;
}

export interface InsightStep {
  text: string;
  anchor: Anchor | null;
}

export interface HistogramData {
  /** part_heights is a histogram of the part log: one value per part */
  view: "histogram" | "part_heights";
  window_s: number;
  per: string;
  series: {
    sensor: string; name: string; unit: string; nominal: number; edges: number[]; counts: number[];
    n: number; mean: number; std: number; p05: number; p95: number; tolerance: Tolerance; cp: number; cpk: number;
    /** readings outside the tolerance (or measuring range), and the one furthest from nominal */
    outside: number; worst: number | null;
    display: Display | null; limit_word: string;
    /** false for a sensor's measuring range: Cp and Cpk judge a part's tolerance only */
    capability: boolean;
  }[];
  insights: InsightStep[];
}

export interface BoxplotData {
  view: "boxplot";
  window_s: number;
  group_by: string;
  per: string;
  unit: string;
  display: Display | null;
  sensors: string[];
  categories: string[];
  boxes: number[][];
  counts: number[];
  insights: InsightStep[];
}

export interface Series {
  sensor: string;
  name: string;
  unit: string;
  t0: number;
  dt: number;
  values: (number | null)[];
  tolerance: Tolerance;
  display?: Display | null;
  limit_word?: string;
}

export interface HistoryData {
  view: "timeseries";
  window_s: number;
  t_now: number;
  series: Series[];
  events: CockpitEvent[];
}

/** The height of every part in the order they came. */
export interface PartsData {
  view: "parts";
  sensor: string;
  name: string;
  unit: string;
  display: Display | null;
  window_s: number | null;
  parts: { number: number; height_um: number; verdict: "good" | "different"; t: number; dwell_s: number; flags: string[] }[];
  band: Tolerance | null;
  reference_um: number | null;
  trend: { x0: number; y0: number; x1: number; y1: number; um_per_part: number; clear: boolean; parts_to_limit: number | null } | null;
  counts: { parts: number; good: number; different: number };
  insights: InsightStep[];
}

/** Good and different parts per period. */
export interface PartCountsData {
  view: "part_counts";
  sensor: string;
  name: string;
  window_s: number | null;
  group_by: string;
  categories: string[];
  good: number[];
  different: number[];
  insights: InsightStep[];
}

export type ViewData = HistoryData | HistogramData | BoxplotData | PartsData | PartCountsData;

export interface RealtimeSession {
  client_secret: string;
  expires_at: number | null;
  model: string;
  calls_url: string;
  session_updates: Record<string, unknown>[];
  alert_prefix: string;
}

export type VoiceMode = "off" | "connecting" | "ready" | "error";
export type VoiceActivity = "idle" | "listening" | "thinking" | "speaking";

// -- recordings and incidents (backend recording_api.py, incidents.py) --------

export interface ManualDocument {
  name: string;
  kind: "pdf" | "text" | "markdown";
  pages: number;
  passages: number;
  bytes: number;
}

export interface KnowledgeStatus {
  documents: ManualDocument[];
  passages: number;
  warnings: string[];
  digest: string;
  embeddings: { enabled: boolean; model: string; ready: number; error: string | null };
  /** an OpenAI key is set, so the manuals are also searched by meaning */
  ai: boolean;
}

export interface ManualPassage {
  uid: string;
  doc: string;
  page: number | null;
  section: string;
  text: string;
  score?: number;
  via?: string;
  /** the library file at its page, when the passage comes from the manual library */
  url?: string;
  /** the product the passage is about, e.g. "optoNCDT 1420" */
  product?: string;
}

/** What a manual lookup found, shown on screen while the copilot speaks about it. */
export interface ManualHit {
  query: string;
  passages: ManualPassage[];
  message: string;
}

/** A written answer from the manuals: every value cited with section and page. */
export interface ManualSource {
  id: string;
  doc: string;
  doc_title: string;
  section: string;
  section_title: string;
  page: number | null;
  printed_page: number | null;
  citation: string;
  text: string;
  footnotes: string[];
  url: string;
  product?: string;
}

/** Which product's manuals an answer comes from: named in the question, the connected sensor, or all. */
export interface ManualScope {
  source: string;
  product: string | null;
  documents?: number;
}

/** How far the manual library is indexed. */
export interface ManualLibrary {
  state: string;
  documents: number;
  passages: number;
  embedded: number;
  families: Record<string, number>;
  active_product: string | null;
  search: "hybrid" | "keyword";
}

export interface ManualAnswer {
  question: string;
  found: boolean;
  answer: string;
  mode: "generated" | "extractive" | "none";
  search: "hybrid" | "keyword";
  sources: ManualSource[];
  scope?: ManualScope;
}

/** One turn of the typed chat: the model's text and the tools it wants run. */
export interface ChatTurn {
  id: string;
  text: string;
  calls: { call_id: string; name: string; arguments: string }[];
}
