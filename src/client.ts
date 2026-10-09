/**
 * Thin HTTP client for the CraftStory public API (https://api.craftstory.com/api/v1/docs/public/).
 * Every method maps 1:1 onto a documented endpoint; no business logic lives here.
 */
import { createWriteStream, openAsBlob } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_BASE = "https://api.craftstory.com/api/v1";
export const USER_AGENT = "craftstory-mcp/0.5.0";
/** Per-request HTTP timeout; keeps every tool call well under MCP clients' ~60 s limit. */
export const REQUEST_TIMEOUT_MS = 25_000;

export type ModelId = "craftstory-2" | "minimax-h3";
export type JobKind = ModelId | "audio-clip";
export type UploadKind = "image" | "audio" | "video";

/** Largest file the server pulls from an upload link into a temp file (the API's own caps are lower for some uses). */
export const MAX_UPLOAD_FETCH_BYTES = 100 * 1024 * 1024;
const UPLOAD_FETCH_TIMEOUT_MS = 90_000;
/** A multipart POST carrying up to 100 MB needs more than the usual 25 s. */
const MEDIA_POST_TIMEOUT_MS = 120_000;

export interface UploadInfo {
  id: string;
  kind?: UploadKind;
  status: string;
  file_url?: string | null;
  original_name?: string;
  content_type?: string;
  size?: number;
  expires_at: string;
}

/** A file pulled from an upload link onto local disk; call release() when done. */
export interface FetchedUpload {
  path: string;
  name: string;
  type: string;
  size: number;
  release: () => Promise<void>;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

export interface ClientOptions {
  /** sk-cs-... key (stdio mode). Exactly one of apiKey / authHeader is required. */
  apiKey?: string;
  /** Ready Authorization header value, e.g. "Auth0 <token>" in the hosted (OAuth) mode. */
  authHeader?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Whether `*_path` inputs may be read from this process's filesystem.
   * True for the stdio server running on the user's machine; false for the
   * hosted server, where a path would name a file on OUR host, not the user's.
   */
  allowLocalFiles?: boolean;
}

/** A file-or-URL input as the API accepts it: a URL string, or a local path that is uploaded. */
export async function fileOrUrl(input: { url?: string; path?: string }, field: string, allowLocalFiles = true): Promise<{ url?: string; blob?: Blob; name?: string }> {
  if (input.url && input.path) throw new Error(`${field}: pass either a URL or a local path, not both`);
  if (input.url) return { url: input.url };
  if (input.path && !allowLocalFiles) {
    throw new Error(`${field}: local file paths are not available on the hosted CraftStory connector. Call request_file_upload to get a one-time upload link for the user, then pass the file_url from wait_for_upload / get_upload as the URL`);
  }
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

  private readonly authorization: string;
  private readonly allowLocalFiles: boolean;

  constructor(private readonly opts: ClientOptions) {
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    if (!opts.apiKey && !opts.authHeader) throw new Error("CraftStoryClient: apiKey or authHeader is required");
    this.authorization = opts.authHeader ?? `Bearer ${opts.apiKey}`;
    this.allowLocalFiles = opts.allowLocalFiles ?? true;
    // The bearer key and uploads travel to this host: plaintext HTTP only on explicit request.
    if (!this.base.startsWith("https://") && process.env.CRAFTSTORY_ALLOW_HTTP !== "1") {
      throw new Error(`CRAFTSTORY_API_BASE must use https:// (got ${this.base}); set CRAFTSTORY_ALLOW_HTTP=1 to override for local testing`);
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** timeoutMs caps this one request (default REQUEST_TIMEOUT_MS); wait_for_job passes its remaining budget. */
  private async request<T>(method: string, path: string, body?: FormData | Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { Authorization: this.authorization, "User-Agent": USER_AGENT, Accept: "application/json" };
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
  post<T>(path: string, body?: FormData | Record<string, unknown>, timeoutMs?: number) {
    return this.request<T>("POST", path, body, timeoutMs);
  }

  // ---- upload links as file sources -----------------------------------
  /**
   * Pull an uploaded file (by upload id, never by a caller-supplied URL) into a
   * temp file, streaming with a byte cap. The read URL comes from our own API,
   * is https, and redirects are refused, so there is nothing to spoof here.
   */
  async fetchUpload(uploadId: string, maxBytes = MAX_UPLOAD_FETCH_BYTES): Promise<FetchedUpload> {
    const info = await this.getUpload(uploadId);
    if (info.status !== "uploaded" || !info.file_url) {
      throw new Error(`upload ${uploadId} is ${info.status}; it has to be uploaded first (wait_for_upload / get_upload)`);
    }
    if (!info.file_url.startsWith("https://") && process.env.CRAFTSTORY_ALLOW_HTTP !== "1") throw new Error(`upload ${uploadId}: unexpected file URL`);
    if (info.size && info.size > maxBytes) throw new Error(`upload ${uploadId} is ${Math.round(info.size / 1024 / 1024)} MB; the limit here is ${Math.round(maxBytes / 1024 / 1024)} MB`);
    const res = await this.fetchImpl(info.file_url, { redirect: "error", signal: AbortSignal.timeout(UPLOAD_FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`upload ${uploadId}: could not read the stored file (HTTP ${res.status})`);
    const path = join(tmpdir(), `craftstory-upload-${uploadId}-${process.pid}-${Date.now()}`);
    const release = async () => {
      await unlink(path).catch(() => undefined);
    };
    let size = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(new Error(`upload ${uploadId} exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`));
        else controller.enqueue(chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as import("node:stream/web").ReadableStream), createWriteStream(path));
    } catch (e) {
      await release();
      throw e;
    }
    const ext = info.content_type ? `.${(info.content_type.split("/")[1] ?? "bin").replace("mpeg", "mp3").replace("quicktime", "mov").replace("x-matroska", "mkv")}` : "";
    return { path, name: info.original_name || `upload${ext}`, type: info.content_type ?? "application/octet-stream", size, release };
  }

  private async appendFetchedUploads(fd: FormData, field: string, uploadIds: string[], captions: string[], captionOffset: number) {
    const fetched: FetchedUpload[] = [];
    for (const [i, id] of uploadIds.entries()) {
      const f = await this.fetchUpload(id);
      fetched.push(f);
      fd.append(field, await openAsBlob(f.path, { type: f.type }), f.name);
      fd.append("reference_captions", captions[captionOffset + i] ?? "");
    }
    return fetched;
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
    const { blob, name } = await fileOrUrl({ path }, "file", this.allowLocalFiles);
    fd.append("file", blob!, name);
    return this.post<{ id: string }>("/audio/clips/", fd, MEDIA_POST_TIMEOUT_MS);
  }
  /** A recording the user dropped on an upload link (kind audio). */
  async createAudioClipFromUpload(uploadId: string) {
    const f = await this.fetchUpload(uploadId);
    try {
      const fd = new FormData();
      fd.append("file", await openAsBlob(f.path, { type: f.type }), f.name);
      return await this.post<{ id: string }>("/audio/clips/", fd, MEDIA_POST_TIMEOUT_MS);
    } finally {
      await f.release();
    }
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
      const img = await fileOrUrl(args.image, "image", this.allowLocalFiles);
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
  upscaleCraftStory2(id: string, resolution: "1080_1920" | "1920_1080" | "1152_1440") {
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
    reference_uploads?: string[];
    reference_captions?: string[];
    name?: string;
    aspect_ratio?: string;
  }) {
    const fd = new FormData();
    if (args.aspect_ratio) fd.append("aspect_ratio", args.aspect_ratio);
    const img = await fileOrUrl(args.image, "image", this.allowLocalFiles);
    if (img.url) fd.append("image", img.url);
    else fd.append("image", img.blob!, img.name);
    if (args.user_prompt) fd.append("user_prompt", args.user_prompt);
    if (args.name) fd.append("name", args.name);
    if (args.mode === "basic") {
      fd.append("requested_duration_s", String(args.requested_duration_s ?? 8));
      return this.post<Record<string, unknown>>("/minimax-h3/", fd);
    }
    for (const a of args.audios ?? []) fd.append("audios", a);
    // No audio: the reference model voices the description, so the length is ours to send.
    if (!args.audios?.length) fd.append("requested_duration_s", String(args.requested_duration_s ?? 8));
    const captions = args.reference_captions ?? [];
    for (const [i, p] of (args.reference_files ?? []).entries()) {
      const f = await fileOrUrl({ path: p }, "reference_files", this.allowLocalFiles);
      fd.append("reference_files", f.blob!, f.name);
      fd.append("reference_captions", captions[i] ?? "");
    }
    const fetched = await this.appendFetchedUploads(fd, "reference_files", args.reference_uploads ?? [], captions, args.reference_files?.length ?? 0);
    try {
      return await this.post<Record<string, unknown>>("/minimax-h3/reference/", fd, MEDIA_POST_TIMEOUT_MS);
    } finally {
      await Promise.all(fetched.map((f) => f.release()));
    }
  }
  async createMiniMaxH3Avatar(args: {
    avatar_id: string;
    scene_id?: string;
    speech_text: string;
    user_prompt?: string;
    requested_duration_s?: number;
    reference_files?: string[];
    reference_uploads?: string[];
    reference_captions?: string[];
    name?: string;
    aspect_ratio?: string;
  }) {
    const fd = new FormData();
    if (args.aspect_ratio) fd.append("aspect_ratio", args.aspect_ratio);
    fd.append("avatar_id", args.avatar_id);
    if (args.scene_id) fd.append("scene_id", args.scene_id);
    fd.append("speech_text", args.speech_text);
    if (args.user_prompt) fd.append("user_prompt", args.user_prompt);
    if (args.requested_duration_s) fd.append("requested_duration_s", String(args.requested_duration_s));
    if (args.name) fd.append("name", args.name);
    const captions = args.reference_captions ?? [];
    for (const [i, p] of (args.reference_files ?? []).entries()) {
      const f = await fileOrUrl({ path: p }, "reference_files", this.allowLocalFiles);
      fd.append("reference_files", f.blob!, f.name);
      fd.append("reference_captions", captions[i] ?? "");
    }
    const fetched = await this.appendFetchedUploads(fd, "reference_files", args.reference_uploads ?? [], captions, args.reference_files?.length ?? 0);
    try {
      return await this.post<Record<string, unknown>>("/minimax-h3/avatar/", fd, MEDIA_POST_TIMEOUT_MS);
    } finally {
      await Promise.all(fetched.map((f) => f.release()));
    }
  }
  upscaleMiniMaxH3(id: string) {
    return this.post<Record<string, unknown>>(`/minimax-h3/${id}/upscale/`);
  }

  // ---- one-time upload links -------------------------------------------
  createUploadLink(body: { kind: UploadKind; hint?: string }) {
    return this.post<{ id: string; kind: UploadKind; upload_url: string; expires_at: string; status: string }>("/uploads/", body);
  }
  getUpload(id: string, timeoutMs?: number) {
    return this.get<UploadInfo>(`/uploads/${id}/`, timeoutMs);
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
  if (status === 401) {
    // The API's own detail (e.g. the plan gate with a pricing link) is the message; add the generic hint only when there is none.
    const detail = flatten(body);
    return detail ? `401 Unauthorized: ${detail}` : "401 Unauthorized (stdio: check CRAFTSTORY_API_KEY and that the plan includes API access; hosted connector: sign in again)";
  }
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
