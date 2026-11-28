// The cockpit's brain on the browser side: routes live data, alerts, voice,
// typed commands and the tool calls from the AI.
import { api, ApiError, getToken, initToken, setToken } from "./lib/api";
import { Camera, camera } from "./lib/camera";
import { parseCommand, phrase, windowWords, type Intent, type Lang } from "./lib/commands";
import { KIND_LABEL, setRangeWording } from "./lib/format";
import { setChartTheme } from "./lib/charts";
import { ingest, meters, setServerTime } from "./lib/live";
import { LiveSocket } from "./lib/socket";
import { setSoundEnabled, unlockAudio } from "./lib/sound";
import { PushToTalkRecognizer, recognitionAvailable, speak, stopSpeaking } from "./lib/speech";
import { RealtimeVoice } from "./lib/voice";
import { useStore } from "./state/store";
import type {
  ChartSpec, ChartView, CockpitConfig, CockpitEvent, ExploreChart, InsightStep, ManualPassage, ServerMessage, StatusMessage,
  ViewData,
} from "./types";

type StageApi = { dissolveFront: () => boolean };

const VIEWS: ChartView[] = ["timeseries"];
const EXPLORE: ExploreChart[] = ["histogram", "boxplot", "parts", "part_counts", "part_heights"];
/** direct commands that run at once without the AI, e.g. "show the signal", "back", "clear" */
const QUICK_COMMAND_RE = /^(please |bitte )?(show|display|plot|open|zeig\w*|öffne|back|go back|zurück|dismiss|clear|close|leeren|mission\b|jarvis|help|hilfe)\b(?![^?]*\?$)/;

/** A chart explanation in progress: which panel, its steps, and how speech is driving it. */
interface Tour {
  panelId: string;
  steps: InsightStep[];
  mode: "ai" | "browser";
  ended: boolean;
}
const store = () => useStore.getState();

class Controller {
  private socket: LiveSocket | null = null;
  private voice: RealtimeVoice | null = null;
  private recognizer: PushToTalkRecognizer | null = null;
  /** the typed chat's conversation with the model (voice off) */
  private chatId: string | null = null;
  private stageApi: StageApi | null = null;
  private lastSensor: string | undefined;
  /** latest data of each chart panel, so explanations can use what is on screen */
  private panelData = new Map<string, ViewData>();
  private tour: Tour | null = null;
  private tourTimer = 0;
  private pttActive = false;
  private alertTimer = 0;
  private started = false;

  // -- start-up --------------------------------------------------------

  /** Keeps the configuration and the words that depend on it (a measuring range or a tolerance) together. */
  private useConfig(config: CockpitConfig): void {
    setRangeWording(config.sensors.length > 0 && config.sensors.every((s) => s.tolerance_kind === "measuring_range"));
    store().patch({ config });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    initToken();
    try {
      const config = await api.config();
      this.useConfig(config);
      if (config.token_required) void this.checkToken();
      else store().patch({ tokenOk: true });
    } catch (error) {
      store().toast(`Backend not reachable: ${String(error)}`, "error");
    }
    this.socket = new LiveSocket("/ws/cockpit", (m) => this.onMessage(m), (s) => store().patch({ socket: s }));
    this.socket.start();
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    void this.refreshKnowledge();
  }

  // -- charts the copilot builds, and their explanations -----------------

  rememberPanelData(panelId: string, data: ViewData): void {
    this.panelData.set(panelId, data);
    if (this.panelData.size > 20) this.panelData.delete(this.panelData.keys().next().value as string);
  }

  /** Shows a histogram or a box plot and returns its findings. */
  async makeChart(spec: ChartSpec, speakFinding = false): Promise<Record<string, unknown>> {
    const sensors = spec.sensors.length ? spec.sensors : [this.lastSensor ?? this.firstSensor()];
    const clean: ChartSpec = { ...spec, sensors };
    try {
      const data = await api.explore(clean);
      this.show(clean);
      const findings = data.insights.map((s) => s.text);
      if (speakFinding && findings[0]) this.say(findings[0]);
      return { ok: true, chart: clean.view, findings };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Walks through the chart in front: each step is highlighted while it is spoken. */
  async explainChart(): Promise<{ ok: boolean; steps?: string[]; error?: string }> {
    const front = store().stage.find((p) => !p.leaving);
    if (!front) return { ok: false, error: "There is no chart on screen." };
    let steps: InsightStep[] | undefined;
    const data = this.panelData.get(front.id);
    if (data && "insights" in data && Array.isArray(data.insights)) steps = data.insights;
    if (!steps && VIEWS.includes(front.spec.view)) {
      try {
        steps = (await api.insights(front.spec)).insights;
      } catch {
        steps = undefined;
      }
    }
    if (!steps?.length) return { ok: false, error: "There is nothing to explain on this chart yet." };
    this.startTour(front.id, steps);
    return { ok: true, steps: steps.map((s, i) => `${i + 1}. ${s.text}`) };
  }

  /** Starts walking through a chart's explanation: the AI voice follows its speech, the browser voice speaks the steps. */
  private startTour(panelId: string, steps: InsightStep[]): void {
    this.endTour();
    const mode = this.voice?.connected ? "ai" : "browser";
    this.tour = { panelId, steps, mode, ended: false };
    store().setTour(panelId, { steps, shown: 0 });
    if (mode === "browser") this.speakTourStep(0);
  }

  private revealStep(count: number): void {
    const tour = this.tour;
    if (!tour) return;
    const panel = store().stage.find((p) => p.id === tour.panelId && !p.leaving);
    if (!panel) {
      this.endTour();
      return;
    }
    const shown = Math.min(Math.max(count, panel.tour?.shown ?? 0), tour.steps.length);
    if (shown !== panel.tour?.shown) {
      store().setTour(tour.panelId, { steps: tour.steps, shown });
    }
    if (shown >= tour.steps.length) this.finishTour();
  }

  /** Browser voice: speak one step, highlight it as it starts, then go on. */
  private speakTourStep(index: number): void {
    const tour = this.tour;
    if (!tour || tour.mode !== "browser" || index >= tour.steps.length) return;
    this.revealStep(index + 1);
    const text = tour.steps[index].text;
    store().addCaption("ai", text, true);
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      if (this.tour === tour) window.setTimeout(() => this.speakTourStep(index + 1), 350);
    };
    if (store().soundOn) {
      speak(text, "en", next);
      // some speech engines never report the end of an utterance
      window.setTimeout(next, 2000 + text.length * 95);
    } else {
      window.setTimeout(next, 2600 + text.length * 35);
    }
  }

  /** AI voice: the first step lights up as it starts talking, the next one after each sentence. */
  private followSpeech(text: string, final: boolean): void {
    const tour = this.tour;
    if (!tour || tour.mode !== "ai" || tour.ended) return;
    const sentences = (text.match(/[.!?](\s|$)/g) ?? []).length;
    this.revealStep(final ? tour.steps.length : 1 + sentences);
  }

  private finishTour(): void {
    const tour = this.tour;
    if (!tour || tour.ended) return;
    tour.ended = true;
    // keep the marks up for a while, then let the chart go live again
    window.clearTimeout(this.tourTimer);
    this.tourTimer = window.setTimeout(() => {
      if (this.tour === tour) this.endTour();
    }, 16000);
  }

  endTour(): void {
    window.clearTimeout(this.tourTimer);
    if (this.tour) {
      if (store().stage.some((p) => p.id === this.tour?.panelId)) store().setTour(this.tour.panelId, undefined);
      this.tour = null;
    }
  }

  // -- mission mode, reports and the part check ---------------------------

  toggleMission(on = !store().mission): void {
    if (on === store().mission) return;
    setChartTheme(on);
    window.clearTimeout(this.missionChartTimer);
    // mission mode starts on the machine; charts fly in when something happens
    if (on) store().patch({ stage: [] });
    store().patch({ mission: on, missionSince: on ? Date.now() : store().missionSince });
    const first = store().config?.sensors[0]?.id;
    if (!on && !store().stage.length && first) this.show({ view: "timeseries", sensors: [first], window_s: 300 });
  }

  private missionChartTimer = 0;
  private autoPanelId: string | null = null;

  openReport(eventId?: string): void {
    const id = eventId ?? store().events[store().events.length - 1]?.id;
    if (!id) {
      store().toast("No alert yet, so there is nothing to report.", "info");
      return;
    }
    store().patch({ reportId: id, partFor: null, partsFor: null });
  }

  openPartCheck(sensor?: string): void {
    store().patch({ partFor: this.resolveSensor(sensor ?? this.lastSensor ?? this.firstSensor()), reportId: null, partsFor: null });
  }

  // -- the camera: a picture of every part while it rests under the sensor ---------------

  private snapped = new Map<string, number>();

  async toggleCamera(next = false): Promise<void> {
    if (camera.on && !next) {
      camera.stop();
      store().patch({ camera: { ...store().camera, on: false } });
      return;
    }
    try {
      let id = Camera.saved();
      if (next) {
        const all = await Camera.list();
        const now = all.findIndex((d) => d.deviceId === id);
        id = all.length ? all[(now + 1) % all.length].deviceId : null;
      }
      const label = await camera.start(id);
      store().patch({ camera: { ...store().camera, on: true, label } });
      store().toast(`Camera on: ${label}. Each part is photographed while it rests under the sensor.`, "ok");
    } catch (error) {
      store().patch({ camera: { ...store().camera, on: false } });
      store().toast(`The camera did not start: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  /** Switch to the camera the operator picked from the list. */
  async useCamera(deviceId: string): Promise<void> {
    try {
      const label = await camera.start(deviceId, true);
      store().patch({ camera: { ...store().camera, on: true, label } });
      store().toast(`Camera: ${label}`, "ok");
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      store().toast(`This camera did not start (${text}). Close other apps that use it (Camera, Teams, Zoom) and try again.`, "error");
      void this.toggleCamera();   // back to a working camera
    }
  }

  private snapParts(message: StatusMessage): void {
    if (!camera.on) return;
    for (const [sid, status] of Object.entries(message.sensors)) {
      const current = status.station?.current;
      if (current && current.since_s >= 0.5) void this.snapPart(sid, current.number);
    }
  }

  async snapPart(sensor: string, number: number): Promise<void> {
    if (!camera.on || this.snapped.get(sensor) === number) return;
    this.snapped.set(sensor, number);
    const photo = await camera.snapshot();
    if (!photo) return;
    store().patch({ camera: { ...store().camera, snapAt: Date.now(), snapPart: number } });
    try {
      await api.partPhoto(sensor, number, photo);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) store().toast("Unlock the cockpit to keep the camera pictures.", "warn");
    }
  }

  /** The quality station sheet: counters, rhythm, trend and the part log. */
  openParts(sensor?: string): void {
    const sid = this.resolveSensor(sensor ?? this.lastSensor ?? this.firstSensor());
    store().patch({ partsFor: sid, partFor: null, reportId: null });
    void this.loadParts(sid);
  }

  async loadParts(sensor: string): Promise<void> {
    try {
      const data = await api.parts(sensor, 200);
      store().patch({ partLog: { ...store().partLog, [sensor]: data.records ?? [] } });
    } catch {
      // the list fills from the live messages too
    }
  }

  async newRun(sensor: string): Promise<boolean> {
    try {
      const data = await api.partsNewRun(sensor);
      this.snapped.delete(sensor);
      store().addPart(sensor, null, data);
      store().toast("New run started: the part log is empty.", "ok");
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        store().toast("Unlock the cockpit first, then start the new run.", "warn");
        void this.enterToken();
      } else {
        store().toast(String(error instanceof Error ? error.message : error), "error");
      }
      return false;
    }
  }

  registerStage(stageApi: StageApi | null): void {
    this.stageApi = stageApi;
  }

  async checkToken(): Promise<boolean> {
    if (!getToken()) {
      store().patch({ tokenOk: false });
      return false;
    }
    try {
      await api.checkToken();
      store().patch({ tokenOk: true });
      return true;
    } catch {
      store().patch({ tokenOk: false });
      return false;
    }
  }

  async enterToken(): Promise<void> {
    const token = window.prompt("Cockpit token (COCKPIT_TOKEN in backend/.env)");
    if (token === null) return;
    setToken(token);
    const ok = await this.checkToken();
    store().toast(ok ? "Cockpit unlocked" : "Wrong token", ok ? "ok" : "error");
  }

  // -- manuals -------------------------------------------------------------

  async refreshKnowledge(): Promise<void> {
    try {
      store().patch({ knowledge: await api.knowledge() });
    } catch {
      // the cockpit works without the manual panel
    }
  }

  // -- live data -------------------------------------------------------

  private onMessage(message: ServerMessage): void {
    switch (message.type) {
      case "hello":
        this.useConfig(message.config);
        store().patch({ status: message.status });
        setServerTime(message.status.t);
        message.events.forEach((e) => store().addEvent(e));
        if (!store().stage.length) this.show({ view: "timeseries", sensors: [message.config.sensors[0]?.id ?? "s1"], window_s: 300 });
        break;
      case "status":
        setServerTime(message.t);
        store().patch({ status: message });
        this.snapParts(message);
        break;
      case "samples":
        ingest(message);
        break;
      case "event":
        this.onEvent(message);
        break;
      case "report":
        store().pushFeed({ id: `rep-${message.id}-${Date.now()}`, t: Date.now() / 1000, type: "report",
          reportId: message.id, title: message.title });
        store().patch({ reportId: message.id, partFor: null, partsFor: null });
        break;
      case "part":
        if (!message.part) this.snapped.delete(message.sensor);   // a new run: the numbers start again
        store().addPart(message.sensor, message.part, message.station);
        break;
      default:
        break;
    }
  }

  private onEvent(event: CockpitEvent): void {
    store().addEvent(event);
    if (event.kind === "wrong_part" && camera.on) {
      const station = store().status?.sensors[event.sensor]?.station;
      if (station) void this.snapPart(event.sensor, station.current?.number ?? station.parts + 1);
    }
    store().patch({ alert: event });
    window.clearTimeout(this.alertTimer);
    if (event.severity !== "critical") {
      this.alertTimer = window.setTimeout(() => {
        if (store().alert?.id === event.id) store().patch({ alert: null });
      }, 15000);
    }
    // a part alert is shown by the twin itself (the part turns red), so no chart covers it
    const partAlert = event.kind === "wrong_part" || event.kind === "jam" || event.kind === "double_feed";
    if (store().mission && !partAlert) {
      // hands-free pitch: the matching chart follows the alert, and clears itself later,
      // unless someone has asked for another chart in the meantime
      window.setTimeout(() => {
        this.showForEvent(event, true);
        this.autoPanelId = store().stage.find((p) => !p.leaving)?.id ?? null;
      }, 2600);
      window.clearTimeout(this.missionChartTimer);
      this.missionChartTimer = window.setTimeout(() => {
        const front = store().stage.find((p) => !p.leaving);
        if (store().mission && front && front.id === this.autoPanelId) this.dismiss();
      }, 26000);
    }
    if (!store().speakAlerts) return;
    if (this.voice?.connected) {
      this.voice.announce(event);
    } else {
      // the alert is already in the conversation, so it is only spoken, not repeated
      window.setTimeout(() => this.say(event.summary, "en", false), 450);
    }
  }

  // -- the stage -------------------------------------------------------

  show(spec: ChartSpec): { ok: boolean; view: string; sensors: string[] } {
    const sensors = spec.sensors?.length ? spec.sensors : [this.lastSensor ?? this.firstSensor()];
    const clean: ChartSpec = { ...spec, sensors };
    this.endTour();
    store().pushPanel(clean);
    this.lastSensor = clean.sensors[0];
    return { ok: true, view: clean.view, sensors: clean.sensors };
  }

  back(): boolean {
    this.endTour();
    const visible = store().stage.filter((p) => !p.leaving);
    if (visible.length < 2) return false;
    const front = visible[0];
    store().markLeaving(front.id, "forward");
    window.setTimeout(() => store().removePanel(front.id), 750);
    return true;
  }

  dismiss(): boolean {
    this.endTour();
    const front = store().stage.find((p) => !p.leaving);
    if (!front) return false;
    this.stageApi?.dissolveFront();
    store().markLeaving(front.id, "dust");
    window.setTimeout(() => store().removePanel(front.id), 60);
    return true;
  }

  showForEvent(event: CockpitEvent, keepAlert = false): void {
    if (!keepAlert) store().patch({ alert: null });
    switch (event.kind) {
      case "out_of_range":
        this.show({ view: "timeseries", sensors: [event.sensor], window_s: 300 });
        break;
      case "trend":
        // a trend lives in the part log, not in the last minute of the signal
        void this.makeChart({ view: "parts", sensors: [event.sensor] }, false);
        break;
      default:
        this.show({ view: "timeseries", sensors: [event.sensor], window_s: 60 });
    }
  }

  // -- voice: AI mode or offline mode ------------------------------------

  async connectVoice(): Promise<void> {
    unlockAudio();
    const config = store().config;
    if (!config?.voice.enabled) {
      store().toast("AI voice is off (no OPENAI_API_KEY). Using offline voice.", "warn");
      return;
    }
    if (config.token_required && !(await this.checkToken())) {
      await this.enterToken();
      if (!store().tokenOk) return;
    }
    this.voice?.disconnect();
    this.voice = new RealtimeVoice({
      onMode: (mode, error) => {
        store().patch({ voiceMode: mode, voiceError: error ?? null });
        if (mode === "error" && error) store().toast(`Voice: ${error}`, "error");
        if (mode === "ready") store().toast("AI voice connected", "ok");
      },
      onActivity: (activity) => store().patch({ activity }),
      onUserText: (text) => store().addCaption("you", text),
      onAssistantText: (text, final) => {
        store().addCaption("ai", text, final);
        this.followSpeech(text, final);
      },
      onToolCall: (name, args) => this.runTool(name, args),
      onLevel: (level) => {
        meters.level = level;
      },
      onError: (message) => store().addCaption("system", message),
    });
    try {
      await this.voice.connect();
    } catch (error) {
      console.error(error);
    }
  }

  disconnectVoice(): void {
    this.voice?.disconnect();
    this.voice = null;
    store().patch({ voiceMode: "off", activity: "idle" });
  }

  get aiVoice(): boolean {
    return Boolean(this.voice?.connected);
  }

  pttDown(): void {
    if (this.pttActive) return;
    this.pttActive = true;
    unlockAudio();
    stopSpeaking();
    if (this.aiVoice) {
      this.voice?.pttStart();
      return;
    }
    if (!recognitionAvailable()) {
      store().toast("This browser has no speech recognition. Type the command instead.", "warn");
      this.pttActive = false;
      return;
    }
    this.recognizer ??= new PushToTalkRecognizer((text) => store().addCaption("you", text, false));
    try {
      this.recognizer.start(this.language());
      store().patch({ activity: "listening" });
    } catch (error) {
      store().toast(String(error), "error");
      this.pttActive = false;
    }
  }

  async pttUp(): Promise<void> {
    if (!this.pttActive) return;
    this.pttActive = false;
    if (this.aiVoice) {
      this.voice?.pttEnd();
      return;
    }
    if (!this.recognizer) return;
    store().patch({ activity: "thinking" });
    const text = await this.recognizer.stop();
    if (!text) {
      store().patch({ activity: "idle" });
      return;
    }
    store().addCaption("you", text, true);
    await this.handleLocal(text);
  }

  async submitText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    unlockAudio();
    store().addCaption("you", trimmed, true);
    if (this.aiVoice) {
      this.voice?.sendText(trimmed);
      return;
    }
    await this.handleLocal(trimmed);
  }

  // -- tools the AI calls ----------------------------------------------

  async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const sensor = String(args.sensor ?? this.lastSensor ?? this.firstSensor());
    const windowS = typeof args.window_s === "number" ? args.window_s : undefined;
    switch (name) {
      case "get_data":
        this.lastSensor = sensor;
        return api.getData(sensor, windowS);
      case "analyze":
        this.lastSensor = sensor;
        return api.analyze(sensor, windowS);
      case "show_chart": {
        const view = VIEWS.includes(args.view as ChartView) ? (args.view as ChartView) : "timeseries";
        const sensors = Array.isArray(args.sensors) ? args.sensors.map((s) => this.resolveSensor(String(s))) : [];
        return this.show({ view, sensors, window_s: windowS });
      }
      case "stage_control":
        return args.action === "dismiss" ? { ok: this.dismiss() } : { ok: this.back() };
      case "make_chart": {
        const chart = EXPLORE.includes(args.chart as ExploreChart) ? (args.chart as ExploreChart) : "histogram";
        const sensors = Array.isArray(args.sensors) ? args.sensors.map((s) => this.resolveSensor(String(s))) : [];
        return this.makeChart({ view: chart, sensors, window_s: windowS, group_by: args.group_by as ChartSpec["group_by"] });
      }
      case "explain_chart":
        return this.explainChart();
      case "get_part_check":
        this.lastSensor = sensor;
        return api.part(this.resolveSensor(sensor));
      case "get_parts": {
        this.lastSensor = sensor;
        const data = await api.parts(this.resolveSensor(sensor), 10);
        // the copilot gets numbers it can say: heights in millimetres, not raw micrometres
        return { ...data, records: (data.records ?? []).map((r) => ({
          number: r.number, verdict: r.verdict, height: r.height, stay_s: r.dwell_s,
          gap_s: r.gap_s, flags: r.flags.filter((f) => f !== "unsteady") })) };
      }
      case "create_report": {
        const eventId = typeof args.event_id === "string" && args.event_id ? args.event_id : undefined;
        return api.createReport(eventId);
      }
      case "search_manual": {
        const query = String(args.query ?? "").trim();
        const product = typeof args.product === "string" ? args.product.trim() : "";
        try {
          const result = await api.searchManualTool(query, product);
          const passages = Array.isArray(result.passages) ? (result.passages as ManualPassage[]) : [];
          store().patch({ manualHit: { query, passages, message: String(result.message ?? "") } });
          return result;
        } catch (error) {
          return { ok: false, error: error instanceof ApiError ? error.message : String(error) };
        }
      }
      default:
        return { ok: false, error: `unknown tool ${name}` };
    }
  }

  // -- offline commands --------------------------------------------------

  /** Typed chat with the AI copilot: same instructions and tools as voice, run turn by turn. */
  async chat(text: string): Promise<void> {
    store().patch({ activity: "thinking" });
    let items: Record<string, unknown>[] = [{ role: "user", content: text }];
    try {
      for (let round = 0; round < 6; round++) {
        let turn;
        try {
          turn = await api.chat(items, this.chatId);
        } catch (error) {
          if (!this.chatId || round > 0) throw error;
          this.chatId = null; // the old conversation expired: start a new one
          turn = await api.chat(items, null);
        }
        this.chatId = turn.id;
        if (turn.text) this.reply(turn.text);
        if (!turn.calls.length) break;
        items = [];
        for (const call of turn.calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch {
            /* the model sent no valid JSON: run with defaults */
          }
          let output: unknown;
          try {
            output = await this.runTool(call.name, args);
          } catch (error) {
            output = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output ?? {}) });
        }
      }
    } catch (error) {
      this.chatId = null;
      this.say(`The AI chat is not available: ${error instanceof ApiError ? error.message : String(error)}`);
    } finally {
      if (store().activity === "thinking") store().patch({ activity: "idle" });
    }
  }

  /** A written answer: the chat shows all of it, the browser voice reads the first sentence. */
  private reply(text: string): void {
    store().addCaption("ai", text, true);
    const plain = text.replace(/\[[^\]]*\]/g, "").replace(/[*#|`_]/g, "").replace(/\s+/g, " ").trim();
    const first = plain.split(/(?<=[.!?])\s/)[0] ?? plain;
    this.say(first, "en", false);
  }

  async handleLocal(text: string): Promise<void> {
    const config = store().config;
    if (!config) return;
    const lower = text.toLowerCase();
    if (/\b(run report|report (of|on|for) (the|this) run|summary of the run|all parts report|laufbericht)\b/.test(lower)) {
      store().patch({ reportId: `run:${this.resolveSensor(this.lastSensor ?? this.firstSensor())}`, partsFor: null, partFor: null });
      this.say("Here is the report of this run: every part and every alert. Scan the code to take it along.");
      return;
    }
    // With AI, the chat answers everything (questions, follow-ups, small talk) except short direct
    // commands, which stay instant.
    if (config.voice.enabled && !QUICK_COMMAND_RE.test(lower.trim())) {
      await this.chat(text);
      return;
    }
    if (/\b(report|bericht|ticket)\b/.test(lower)) {
      const result = await api.createReport();
      if (!result.ok) this.say(result.error ?? "There is no alert to report yet.");
      else this.say(`The report on ${result.title} is on screen.`);
      return;
    }
    if (/\b(mission|jarvis)\b/.test(lower)) {
      this.toggleMission();
      return;
    }
    if (/\b(explain|walk me through|erkl(ä|ae)r|what am i (looking at|seeing)|what does (this|the) chart)/.test(lower)) {
      const result = await this.explainChart();
      if (!result.ok) this.say(result.error ?? "There is no chart to explain.");
      return;
    }
    const mentioned = config.sensors.filter((s) => lower.includes(s.name.toLowerCase()) || new RegExp(`\\b${s.id}\\b`).test(lower));
    const ids = mentioned.map((s) => s.id);
    const local = (spec: Omit<ChartSpec, "sensors">, sensors = ids) => this.makeChart({ ...spec, sensors }, true);
    if (/\b(histogram|distribution|distributed|spread|verteilung|streuung|capab\w*|cpk|f(ä|ae)hig)/.test(lower)) {
      await local({ view: "histogram" }, ids.length ? ids : [this.lastSensor ?? this.firstSensor()]);
      return;
    }
    const one = [ids[0] ?? this.lastSensor ?? this.firstSensor()];
    if (/\b(bar ?chart|bar graph|bars|balken\w*)\b/.test(lower)) {
      await local({ view: "part_counts" }, one);
      return;
    }
    if (/\b(part heights?|heights? of (the|every|each|all) parts?|height chart|each part|every part|teileh(ö|oe)hen?|h(ö|oe)he der teile)\b/.test(lower)) {
      await local({ view: "parts" }, one);
      return;
    }
    if (/\b(how many parts|parts so far|count\w* parts|yield|part log|parts? list|list of parts|wie viele teile|teileliste|ausbeute|st(ü|ue)ckzahl)\b/.test(lower)) {
      this.openParts(one[0]);
      const station = store().status?.sensors[one[0]]?.station;
      if (!station) this.say("The quality station is not running yet.");
      else if (!station.ready) this.say(station.message);
      else this.say(`${station.parts} parts so far, ${station.good} of them the taught part${station.yield_percent !== null ? `, a yield of ${Math.round(station.yield_percent)} percent` : ""}.`);
      return;
    }
    if (/\b(box ?plot|per minute|per hour|hourly|calm\w*|unsettled|ruhig\w*)\b/.test(lower)) {
      await local({ view: "boxplot", window_s: 900, group_by: "minute" }, [ids[0] ?? this.lastSensor ?? this.firstSensor()]);
      return;
    }
    const { intent, lang } = parseCommand(text, {
      sensors: config.sensors,
      events: store().events,
      lastSensor: this.lastSensor,
    });
    try {
      await this.execute(intent, lang);
    } catch (error) {
      this.say(String(error instanceof Error ? error.message : error), lang);
    }
  }

  private async execute(intent: Intent, lang: Lang): Promise<void> {
    switch (intent.kind) {
      case "show": {
        const { spec } = intent;
        const result = this.show(spec);
        const name = this.sensorName(result.sensors[0]);
        this.say(phrase("show_timeseries", lang, { name, window: windowWords(spec.window_s ?? 300, lang) }), lang);
        return;
      }
      case "stage":
        if (intent.action === "back") this.say(phrase(this.back() ? "back" : "nothing_back", lang), lang);
        else if (this.dismiss()) this.say(phrase("dismiss", lang), lang);
        return;
      case "partcheck":
        this.openPartCheck(intent.sensor);
        this.say(phrase("partcheck_open", lang), lang);
        return;
      case "status": {
        const sensors = intent.sensor ? [intent.sensor] : (store().config?.sensors ?? []).map((s) => s.id);
        const parts: string[] = [];
        for (const sid of sensors) {
          const result = (await api.analyze(sid, 60)) as { latest?: number; within_tolerance?: boolean; observations?: string[]; name?: string };
          const name = result.name ?? this.sensorName(sid);
          // a sensor with a data sheet is read in millimetres and judged by its measuring range
          const info = store().config?.sensors.find((s) => s.id === sid);
          const inRange = info?.tolerance_kind === "measuring_range" && info.display !== null;
          const value = typeof result.latest !== "number" ? "?"
            : inRange ? (result.latest * (info?.display?.scale ?? 0.001)).toFixed(3) : result.latest.toFixed(1);
          const key = inRange ? (result.within_tolerance === false ? "status_out_range" : "status_ok_range")
            : (result.within_tolerance === false ? "status_out" : "status_ok");
          parts.push(phrase(key, lang, { name, value }));
          const notable = (result.observations ?? []).filter((o) => !o.startsWith("Nothing unusual"));
          if (notable.length && lang === "en") parts.push(notable[0]);
        }
        this.say(parts.join(" "), lang);
        return;
      }
      case "help":
        this.say(phrase("help", lang), lang);
        return;
      default:
        this.say(phrase("unknown", lang), lang);
    }
  }

  /** Caption plus browser speech (offline mode and alert fallback). */
  say(text: string, lang: Lang = "en", caption = true): void {
    if (caption) store().addCaption("ai", text, true);
    if (!store().soundOn) {
      store().patch({ activity: "idle" });
      return;
    }
    store().patch({ activity: "speaking" });
    meters.level = 0.6;
    speak(text, lang, () => {
      meters.level = 0;
      if (store().activity === "speaking") store().patch({ activity: "idle" });
    });
  }

  // -- settings ----------------------------------------------------------

  toggleSound(): void {
    const soundOn = !store().soundOn;
    setSoundEnabled(soundOn);
    if (!soundOn) stopSpeaking();
    store().patch({ soundOn });
  }

  setPublicUrl(url: string): void {
    // keep only the site address: a pasted "/phone" would double up in the QR
    // link, and a "?token=..." must never end up on the judges' phones
    const clean = url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/phone$/i, "").replace(/\/+$/, "");
    try {
      localStorage.setItem("cockpit-public-url", clean);
    } catch {
      /* private mode */
    }
    store().patch({ publicUrl: clean });
  }

  // -- keyboard ----------------------------------------------------------

  private typing(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement | null;
    return Boolean(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable));
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.typing(event)) return;
    if (event.code === "Space") {
      event.preventDefault();
      if (!event.repeat) this.pttDown();
      return;
    }
    if (event.repeat) return;
    const s = store();
    switch (event.key) {
      case "ArrowLeft":
        this.back();
        break;
      case "Delete":
      case "Backspace":
        this.dismiss();
        break;
      case "q":
      case "Q":
        s.patch({ qrOpen: !s.qrOpen });
        break;
      case "c":
      case "C":
        void this.toggleCamera();
        break;
      case "m":
      case "M":
        this.toggleSound();
        break;
      case "Escape":
        if (s.reportId || s.partFor || s.partsFor) s.patch({ reportId: null, partFor: null, partsFor: null });
        else if (s.manualsOpen) s.patch({ manualsOpen: false });
        else if (s.manualHit) s.patch({ manualHit: null });
        else s.patch({ qrOpen: false, alert: null });
        break;
      case "r":
      case "R":
        this.openReport();
        break;
      default:
        break;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space" && !this.typing(event)) {
      event.preventDefault();
      void this.pttUp();
    }
  };

  // -- helpers -----------------------------------------------------------

  private language(): Lang {
    return store().config?.language?.startsWith("de") ? "de" : "en";
  }

  private firstSensor(): string {
    return store().config?.sensors[0]?.id ?? "s1";
  }

  sensorName(id: string): string {
    return store().config?.sensors.find((s) => s.id === id)?.name ?? id;
  }

  private resolveSensor(text: string): string {
    const sensors = store().config?.sensors ?? [];
    const lower = text.toLowerCase().trim();
    const direct = sensors.find((s) => s.id === lower || s.name.toLowerCase() === lower);
    if (direct) return direct.id;
    const digit = lower.match(/\d+/)?.[0];
    return sensors.find((s) => s.id === `s${digit}`)?.id ?? this.firstSensor();
  }

  eventLabel(event: CockpitEvent): string {
    return `${KIND_LABEL[event.kind]} · ${this.sensorName(event.sensor)}`;
  }
}

export const controller = new Controller();
