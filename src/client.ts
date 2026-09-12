/**
 * Thin HTTP client for the CraftStory public API (https://api.craftstory.com/api/v1/docs/public/).
 * Every method maps 1:1 onto a documented endpoint; no business logic lives here.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";

export const DEFAULT_BASE = "https://api.craftstory.com/api/v1";
export const USER_AGENT = "craftstory-mcp/0.1.2";
/** Per-request HTTP timeout; keeps every tool call well under MCP clients' ~60 s limit. */
export const REQUEST_TIMEOUT_MS = 25_000;

export type ModelId = "craftstory-2" | "minimax-h3";
export type JobKind = ModelId | "audio-clip";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** A file-or-URL input as the API accepts it: a URL string, or a local path that is uploaded. */
export async function fileOrUrl(input: { url?: string; path?: string }, field: string): Promise<{ url?: string; blob?: Blob; name?: string }> {
  if (input.url && input.path) throw new Error(`${field}: pass either a URL or a local path, not both`);
  if (input.url) return { url: input.url };
  if (input.path) {
    const path = input.path.startsWith("~/") ? homedir() + input.path.slice(1) : input.path;
    const bytes = await readFile(path);
    return { blob: new Blob([bytes]), name: basename(path) };
  }
  throw new Error(`${field}: a URL or a local file path is required`);
}

export class CraftStoryClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    // The bearer key and uploads travel to this host: plaintext HTTP only on explicit request.
    if (!this.base.startsWith("https://") && process.env.CRAFTSTORY_ALLOW_HTTP !== "1") {
      throw new Error(`CRAFTSTORY_API_BASE must use https:// (got ${this.base}); set CRAFTSTORY_ALLOW_HTTP=1 to override for local testing`);
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** timeoutMs caps this one request (default REQUEST_TIMEOUT_MS); wait_for_job passes its remaining budget. */
  private async request<T>(method: string, path: string, body?: FormData | Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}`, "User-Agent": USER_AGENT, Accept: "application/json" };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
    } catch (e) {
      // Node's fetch hides the reason behind "fetch failed"; surface the cause (DNS, TLS, reset...).
      if ((e as Error).name === "TimeoutError") throw new Error(`Timeout after ${Math.round(Math.max(1000, timeoutMs) / 1000)}s calling ${method} ${path}`);
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new Error(`Network error calling ${method} ${path}: ${cause?.code ?? ""} ${cause?.message ?? (e as Error).message}`.trim());
    }
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body (e.g. 502 page) stays as text */
    }
    if (!res.ok) throw new ApiError(res.status, data, describeError(res.status, data));
    return data as T;
  }

  get<T>(path: string, timeoutMs?: number) {
    return this.request<T>("GET", path, undefined, timeoutMs);
  }
  post<T>(path: string, body?: FormData | Record<string, unknown>) {
    return this.request<T>("POST", path, body);
  }

  // ---- catalogue -------------------------------------------------------
  listModels() {
    return this.get<unknown[]>("/models/");
  }
  listVoices() {
    return this.get<unknown[]>("/craftstory-2/voices/");
  }
  listUserVoices() {
    return this.get<unknown[]>("/craftstory-2/user-voices/");
  }
  listAvatars() {
    return this.get<unknown[]>("/craftstory-2/avatars/");
  }
  listAvatarScenes(avatarId: string) {
    return this.get<unknown[]>(`/craftstory-2/avatars/${avatarId}/scenes/`);
  }

  // ---- audio clips -----------------------------------------------------
  createAudioClipFromText(text: string, voice: { voice_id?: string; voice_user_id?: string }) {
    return this.post<{ id: string }>("/audio/clips/", { text, ...voice });
  }
  async createAudioClipFromFile(path: string) {
    const fd = new FormData();
    const { blob, name } = await fileOrUrl({ path }, "file");
    fd.append("file", blob!, name);
    return this.post<{ id: string }>("/audio/clips/", fd);
  }

  // ---- CraftStory 2.0 --------------------------------------------------
  previewCost(body: { audios: string[]; resolution: string; lipsync_mode?: string }) {
    return this.post<{ credits: number }>("/craftstory-2/preview-cost/", body);
  }
  async createCraftStory2(args: {
    image?: { url?: string; path?: string };
    scene_id?: string;
    avatar_id?: string;
    audios: string[];
    resolution: string;
    gestures?: string;
    lipsync_mode?: string;
    user_prompt?: string;
    faceswap?: boolean;
    name?: string;
  }) {
    const fd = new FormData();
    if (args.image?.url || args.image?.path) {
      const img = await fileOrUrl(args.image, "image");
      if (img.url) fd.append("image", img.url);
      else fd.append("image", img.blob!, img.name);
    }
    for (const a of args.audios) fd.append("audios", a);
    fd.append("resolution", args.resolution);
    for (const k of ["scene_id", "avatar_id", "gestures", "lipsync_mode", "user_prompt", "name"] as const) {
      const v = args[k];
      if (v !== undefined && v !== "") fd.append(k, String(v));
    }
    if (args.faceswap !== undefined) fd.append("faceswap", args.faceswap ? "true" : "false");
    return this.post<Record<string, unknown>>("/craftstory-2/", fd);
  }
  upscaleCraftStory2(id: string, resolution: "1080_1920" | "1920_1080") {
    return this.post<Record<string, unknown>>(`/craftstory-2/${id}/upscale/`, { resolution });
  }

  // ---- MiniMax H3 ------------------------------------------------------
  async createMiniMaxH3(args: {
    mode: "basic" | "reference";
    image: { url?: string; path?: string };
    user_prompt?: string;
    requested_duration_s?: number;
    audios?: string[];
    reference_files?: string[];
    reference_captions?: string[];
    name?: string;
  }) {
    const fd = new FormData();
    const img = await fileOrUrl(args.image, "image");
    if (img.url) fd.append("image", img.url);
    else fd.append("image", img.blob!, img.name);
    if (args.user_prompt) fd.append("user_prompt", args.user_prompt);
    if (args.name) fd.append("name", args.name);
    if (args.mode === "basic") {
      fd.append("requested_duration_s", String(args.requested_duration_s ?? 8));
      return this.post<Record<string, unknown>>("/minimax-h3/", fd);
    }
    for (const a of args.audios ?? []) fd.append("audios", a);
    const captions = args.reference_captions ?? [];
    for (const [i, p] of (args.reference_files ?? []).entries()) {
      const f = await fileOrUrl({ path: p }, "reference_files");
      fd.append("reference_files", f.blob!, f.name);
      fd.append("reference_captions", captions[i] ?? "");
    }
    return this.post<Record<string, unknown>>("/minimax-h3/reference/", fd);
  }
  upscaleMiniMaxH3(id: string) {
    return this.post<Record<string, unknown>>(`/minimax-h3/${id}/upscale/`);
  }

  // ---- generic job access ---------------------------------------------
  jobPath(kind: JobKind, id: string) {
    return kind === "audio-clip" ? `/audio/clips/${id}/` : `/${kind}/${id}/`;
  }
  getStatus(kind: JobKind, id: string, timeoutMs?: number) {
    return this.get<{ status: string; status_percentage?: number; status_failed?: string | null; credits_refunded?: unknown }>(
      `${this.jobPath(kind, id)}status/`,
      timeoutMs,
    );
  }
  getResult(kind: JobKind, id: string, timeoutMs?: number) {
    return this.get<Record<string, unknown>>(this.jobPath(kind, id), timeoutMs);
  }
}

/** Terminal-state classification shared by wait_for_job and the tool descriptions. */
export function classify(status: string): "done" | "failed" | "running" {
  if (status === "done") return "done";
  if (status.startsWith("failed") || status.startsWith("rejected_") || status === "not_pass_moderation") return "failed";
  return "running";
}

function describeError(status: number, body: unknown): string {
  if (status === 401) return `401 Unauthorized: ${flatten(body)} (check CRAFTSTORY_API_KEY and that the plan includes API access)`;
  if (status === 402 || (status === 400 && JSON.stringify(body).includes("Low credits"))) return `Low credits: ${flatten(body)}`;
  if (status === 503) return `503: the model is paused right now (see list_models); retry later`;
  return `HTTP ${status}: ${flatten(body)}`;
}

function flatten(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body.slice(0, 300);
  if (Array.isArray(body)) return body.map(flatten).join("; ");
  if (typeof body === "object") {
    return Object.entries(body as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${flatten(v)}`)
      .join("; ");
  }
  return String(body);
}
