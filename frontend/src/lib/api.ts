// Thin client for the backend REST API.
import type {
  BoxplotData,
  ChartSpec,
  CockpitConfig,
  HistogramData,
  HistoryData,
  InsightStep,
  KnowledgeStatus,
  ManualDocument,
  ManualAnswer,
  ManualLibrary,
  ManualPassage,
  ChatTurn,
  PartCountsData,
  PartsData,
  PartState,
  RealtimeSession,
  StationState,
  ViewData,
} from "../types";

const TOKEN_KEY = "cockpit-token";

/** Reads ?token=... once, keeps it for the browser session and cleans the URL. */
export function initToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  }
}

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set("X-Cockpit-Token", token);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch {
      /* not JSON */
    }
    throw new ApiError(detail, response.status);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  config: () => request<CockpitConfig>("/api/config"),
  checkToken: () => request<{ ok: boolean }>("/api/auth/check"),
  history: (sensors: string[], windowS: number, maxPoints = 1200) =>
    request<HistoryData>(
      `/api/history?sensors=${encodeURIComponent(sensors.join(","))}&window_s=${windowS}&max_points=${maxPoints}`,
    ),
  getData: (sensor: string, windowS?: number) =>
    post<Record<string, unknown>>("/api/tools/get_data", { sensor, window_s: windowS }),
  analyze: (sensor: string, windowS?: number) =>
    post<Record<string, unknown>>("/api/tools/analyze", { sensor, window_s: windowS }),
  realtimeSession: () => post<RealtimeSession>("/api/realtime/session"),
  explore: (spec: ChartSpec) => {
    const q = new URLSearchParams({ chart: spec.view, sensors: spec.sensors.join(",") });
    if (spec.window_s) q.set("window_s", String(spec.window_s));
    if (spec.group_by) q.set("group_by", spec.group_by);
    return request<HistogramData | BoxplotData | PartsData | PartCountsData>(`/api/explore?${q}`);
  },
  insights: (spec: ChartSpec) => {
    const q = new URLSearchParams({ view: spec.view, sensors: spec.sensors.join(",") });
    if (spec.window_s) q.set("window_s", String(spec.window_s));
    return request<{ insights: InsightStep[] }>(`/api/insights?${q}`);
  },
  part: (sensor: string) => request<PartState>(`/api/part/${encodeURIComponent(sensor)}`),
  partLearn: (sensor: string, body: { kind?: "part" | "empty"; add?: boolean; margin_um?: number }) =>
    post<PartState>(`/api/part/${encodeURIComponent(sensor)}/learn`, body),
  partMargin: (sensor: string, margin_um: number) =>
    post<PartState>(`/api/part/${encodeURIComponent(sensor)}/margin`, { margin_um }),
  partForget: (sensor: string, what: "all" | "part" | "empty" = "all") =>
    post<PartState>(`/api/part/${encodeURIComponent(sensor)}/forget`, { what }),
  // the quality station
  parts: (sensor: string, limit = 50) =>
    request<StationState & { sensor: string }>(`/api/parts/${encodeURIComponent(sensor)}?limit=${limit}`),
  partsNewRun: (sensor: string) =>
    post<StationState & { sensor: string }>(`/api/parts/${encodeURIComponent(sensor)}/reset`),
  partsCsvUrl: (sensor: string) => `/api/parts/${encodeURIComponent(sensor)}/csv`,
  partPhoto: (sensor: string, number: number, photo: Blob) =>
    request<{ ok: boolean; url: string }>(`/api/parts/${encodeURIComponent(sensor)}/${number}/photo`,
      { method: "POST", body: photo, headers: { "Content-Type": "image/jpeg" } }),
  createReport: (eventId?: string) =>
    post<{ ok: boolean; id?: string; title?: string; error?: string }>("/api/tools/create_report", { event_id: eventId }),
  // manuals
  knowledge: () => request<KnowledgeStatus>("/api/knowledge"),
  uploadManual: async (file: File) =>
    request<KnowledgeStatus & { document: ManualDocument }>("/api/knowledge/upload", {
      method: "POST",
      body: await file.arrayBuffer(),
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
    }),
  deleteManual: (name: string) => request<KnowledgeStatus>(`/api/knowledge/${encodeURIComponent(name)}`, { method: "DELETE" }),
  searchManual: (query: string) => post<{ hits: ManualPassage[] }>("/api/knowledge/search", { query, k: 5 }),
  /** a written answer from the manuals, every value cited with section and page */
  askManual: (question: string) => post<ManualAnswer>("/api/knowledge/ask", { question }),
  /** the typed chat with the copilot when voice is off (same tools as voice) */
  chat: (items: Record<string, unknown>[], previousResponseId: string | null) =>
    post<ChatTurn>("/api/chat", { items, previous_response_id: previousResponseId }),
  manualUrl: (doc: string, page: number | null) =>
    `/api/knowledge/file/${encodeURIComponent(doc)}${page ? `#page=${page}` : ""}`,
  // the copilot's tools, called from the browser when the AI asks for them
  searchManualTool: (query: string, product?: string) =>
    post<Record<string, unknown>>("/api/tools/search_manual", { query, product: product || null }),
  manualLibrary: () => request<ManualLibrary>("/api/knowledge/library"),
};

/** Fetches whatever a chart spec needs. */
export function loadView(spec: ChartSpec): Promise<ViewData> {
  const sensors = spec.sensors.length ? spec.sensors : ["s1"];
  switch (spec.view) {
    case "histogram":
    case "boxplot":
    case "parts":
    case "part_counts":
    case "part_heights":
      return api.explore({ ...spec, sensors });
    default:
      return api.history([sensors[0]], spec.window_s ?? 300);
  }
}
