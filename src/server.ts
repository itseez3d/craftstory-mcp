/**
 * MCP server definition: every tool is a thin, documented wrapper over one
 * CraftStory public API call. Long generations (CraftStory 2.0: 8-15 min,
 * MiniMax H3: 1-3 min) return a job id immediately; `wait_for_job` polls in
 * bounded slices so agent runtimes never hang on a single call.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { classify, CraftStoryClient, type JobKind } from "./client.js";

const RESOLUTIONS = ["480_832", "832_480", "720_1280", "1280_720"] as const;
const GESTURES = ["normal", "calm", "expressive"] as const;
const LIPSYNC = ["craftstory", "sync_so", "empty"] as const;
const JOB_KINDS = ["craftstory-2", "minimax-h3", "audio-clip"] as const;

const text = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({ isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] });

export function buildServer(client: CraftStoryClient): McpServer {
  const server = new McpServer({ name: "craftstory", version: "0.1.1" });

  server.registerTool(
    "list_models",
    {
      title: "List CraftStory video models",
      description:
        "Catalogue of the video models behind this server with their status, modes, limits and credit prices. " +
        "Two models today: craftstory-2 (a talking video of any length from one photo plus an audio clip; 8-15 min) " +
        "and minimax-h3 (a clip of up to 15 s from one photo, either description-driven with generated sound or audio-driven with lip-sync; 1-3 min). " +
        "Call this first when unsure which model fits, or to check that a model is not paused.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await client.listModels());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_voices",
    {
      title: "List voices for text-to-speech",
      description:
        "Library voices (id, name, language, gender) usable as voice_id in create_audio_clip. " +
        "With include_cloned=true also returns the account's own cloned voices, usable as voice_user_id. Voices are cloned in the CraftStory app, not via the API.",
      inputSchema: { include_cloned: z.boolean().optional().describe("Also return the account's cloned voices (default false)") },
    },
    async ({ include_cloned }) => {
      try {
        const library = await client.listVoices();
        const cloned = include_cloned ? await client.listUserVoices() : undefined;
        return text(cloned ? { library, cloned } : { library });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_avatars",
    {
      title: "List custom avatars (and their scenes)",
      description:
        "Custom avatars trained in the CraftStory app that craftstory-2 can generate with (pass an id as avatar_id). " +
        "Each avatar may carry a default voice {id, voice_kind}: voice_kind 'user' means send it as voice_user_id, 'library' as voice_id in create_audio_clip. " +
        "Pass avatar_id to list that avatar's scenes; a scene id can replace the photo (scene_id) in create_craftstory2_video.",
      inputSchema: { avatar_id: z.string().uuid().optional().describe("Return the scenes of this avatar instead of the avatar list") },
    },
    async ({ avatar_id }) => {
      try {
        return text(avatar_id ? await client.listAvatarScenes(avatar_id) : await client.listAvatars());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_audio_clip",
    {
      title: "Create an audio clip (speech from text, or upload a recording)",
      description:
        "The soundtrack every video model takes as input. Either text (up to 2000 characters) plus exactly one voice (voice_id from list_voices, or voice_user_id for a cloned voice), " +
        "or file_path to upload a local WAV/MP3/M4A recording. Returns the clip id; it is ready when wait_for_job(model='audio-clip') reports done (usually seconds). " +
        "Longer scripts: create several clips and pass all ids to create_craftstory2_video in order.",
      inputSchema: {
        text: z.string().max(2000).optional().describe("Script to synthesize (<= 2000 chars)"),
        voice_id: z.string().uuid().optional().describe("Library voice id (from list_voices)"),
        voice_user_id: z.string().uuid().optional().describe("Cloned voice id (from list_voices with include_cloned)"),
        file_path: z.string().optional().describe("Local path of a recording to upload instead of text"),
      },
    },
    async ({ text: script, voice_id, voice_user_id, file_path }) => {
      try {
        if (file_path) return text(await client.createAudioClipFromFile(file_path));
        if (!script) throw new Error("Pass text (with a voice) or file_path");
        if (!voice_id && !voice_user_id) throw new Error("Pass voice_id (library voice) or voice_user_id (cloned voice) with text");
        return text(await client.createAudioClipFromText(script, voice_id ? { voice_id } : { voice_user_id }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "preview_cost",
    {
      title: "Estimate the credit cost of a CraftStory 2.0 video",
      description:
        "Credits a craftstory-2 job would cost for the given audio clips and settings, without creating anything. " +
        "Rate per second of audio: 480p 2.2 (2 with lipsync_mode=empty), 720p 3.3 (3 with empty); rounded up per job. MiniMax H3 is a flat 3.3 credits per billed second.",
      inputSchema: {
        audio_clip_ids: z.array(z.string().uuid()).min(1),
        resolution: z.enum(RESOLUTIONS),
        lipsync_mode: z.enum(LIPSYNC).optional(),
      },
    },
    async ({ audio_clip_ids, resolution, lipsync_mode }) => {
      try {
        return text(await client.previewCost({ audios: audio_clip_ids, resolution, lipsync_mode }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_craftstory2_video",
    {
      title: "Create a CraftStory 2.0 talking video (photo + audio)",
      description:
        "Start a craftstory-2 generation: a photo of a person (image_url or image_path, or a custom avatar scene via scene_id) speaks the given audio clips with lip-sync, gestures and natural motion; any length. " +
        "resolution is WIDTH_HEIGHT (480_832 / 720_1280 portrait, 832_480 / 1280_720 landscape); 1080p is available afterwards via upscale_video. " +
        "Credits are charged on create (see preview_cost) and refunded if the job fails. Returns the job id and initial status; generation takes 8-15 minutes, " +
        "so call wait_for_job(model='craftstory-2') repeatedly until it reports done, then get_job_result for the video URL.",
      inputSchema: {
        image_url: z.string().url().optional().describe("Public URL of the photo (JPG/PNG)"),
        image_path: z.string().optional().describe("Local path of the photo to upload (<= 20 MB)"),
        scene_id: z.string().uuid().optional().describe("Custom avatar scene id (from list_avatars) used instead of a photo"),
        avatar_id: z.string().uuid().optional().describe("Custom avatar id (from list_avatars); its trained model drives identity"),
        audio_clip_ids: z.array(z.string().uuid()).min(1).describe("Audio clip ids (from create_audio_clip), played in order"),
        resolution: z.enum(RESOLUTIONS),
        gestures: z.enum(GESTURES).optional().describe("How much the avatar moves (default normal)"),
        lipsync_mode: z.enum(LIPSYNC).optional().describe("craftstory (default) / sync_so (alternative engine) / empty (no lip-sync)"),
        user_prompt: z.string().max(1000).optional().describe("Optional motion / scene hint"),
        faceswap: z.boolean().optional().describe("Identity pass on the result (default true; off for custom avatars)"),
        name: z.string().optional().describe("Label, used as the download file name"),
      },
    },
    async (a) => {
      try {
        if (!a.image_url && !a.image_path && !a.scene_id) throw new Error("Pass image_url, image_path or scene_id");
        const r = await client.createCraftStory2({
          image: { url: a.image_url, path: a.image_path },
          scene_id: a.scene_id,
          avatar_id: a.avatar_id,
          audios: a.audio_clip_ids,
          resolution: a.resolution,
          gestures: a.gestures,
          lipsync_mode: a.lipsync_mode,
          user_prompt: a.user_prompt,
          faceswap: a.faceswap,
          name: a.name,
        });
        return text({ id: r.id, status: r.status, credits: r.credits, next: "wait_for_job(model='craftstory-2', id=...) until done (8-15 min), then get_job_result" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_minimax_h3_video",
    {
      title: "Create a MiniMax H3 clip (up to 15 s)",
      description:
        "Start a minimax-h3 generation from one photo. mode='basic': user_prompt (scene description) + requested_duration_s (5-15); the model animates the photo and generates the soundtrack itself. " +
        "mode='reference': one audio_clip_id drives the clip with lip-sync (first 15 s billed); user_prompt is optional; up to 8 extra image / 3 video / 2 audio reference_files with reference_captions keep a product or background consistent. " +
        "Output is 768 px on the short side, orientation follows the photo. Cost 3.3 credits per billed second, charged on create. Returns the job id; call wait_for_job(model='minimax-h3') until done (1-3 min).",
      inputSchema: {
        mode: z.enum(["basic", "reference"]),
        image_url: z.string().url().optional(),
        image_path: z.string().optional(),
        user_prompt: z.string().optional().describe("Scene / motion description (required in basic mode)"),
        requested_duration_s: z.number().int().min(5).max(15).optional().describe("Clip length in basic mode (default 8)"),
        audio_clip_id: z.string().uuid().optional().describe("Reference mode: the clip that drives the video"),
        reference_files: z.array(z.string()).optional().describe("Reference mode: local paths of extra reference images/videos/audio"),
        reference_captions: z.array(z.string()).optional().describe("One caption per reference file, same order"),
        name: z.string().optional(),
      },
    },
    async (a) => {
      try {
        if (!a.image_url && !a.image_path) throw new Error("Pass image_url or image_path");
        if (a.mode === "basic" && !a.user_prompt) throw new Error("basic mode needs user_prompt");
        if (a.mode === "reference" && !a.audio_clip_id) throw new Error("reference mode needs audio_clip_id");
        const r = await client.createMiniMaxH3({
          mode: a.mode,
          image: { url: a.image_url, path: a.image_path },
          user_prompt: a.user_prompt,
          requested_duration_s: a.requested_duration_s,
          audios: a.audio_clip_id ? [a.audio_clip_id] : undefined,
          reference_files: a.reference_files,
          reference_captions: a.reference_captions,
          name: a.name,
        });
        return text({ id: r.id, status: r.status, credits: r.credits, next: "wait_for_job(model='minimax-h3', id=...) until done (1-3 min), then get_job_result" });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Get a job's status",
      description:
        "Status of a video job or audio clip: status, status_percentage, status_failed, credits_refunded. Terminal states: done; failed*, rejected_* and not_pass_moderation (audio) are failures. " +
        "Prefer wait_for_job, which polls for you.",
      inputSchema: { model: z.enum(JOB_KINDS), id: z.string().uuid() },
    },
    async ({ model, id }) => {
      try {
        return text(await client.getStatus(model, id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_job_result",
    {
      title: "Get a finished job (video URL and details)",
      description:
        "Full record of a job. For craftstory-2 the video is in `video`, for minimax-h3 in `video_url`, for audio clips in `file`; all are signed URLs valid for 7 days (call again for a fresh link). Also returns the parameters used and the credits charged.",
      inputSchema: { model: z.enum(JOB_KINDS), id: z.string().uuid() },
    },
    async ({ model, id }) => {
      try {
        return text(await client.getResult(model, id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "wait_for_job",
    {
      title: "Wait for a job (bounded polling)",
      description:
        "Polls a job's status every few seconds for up to timeout_s (default 45, max 55 - most MCP clients cut a tool call at 60 s) and returns as soon as it is terminal. " +
        "If it returns state='running', call it again - craftstory-2 jobs take 8-15 minutes, minimax-h3 1-3 minutes, audio clips seconds. Reports progress notifications when the client supports them.",
      inputSchema: {
        model: z.enum(JOB_KINDS),
        id: z.string().uuid(),
        timeout_s: z.number().int().min(5).max(55).optional().describe("How long this call may wait (default 45, max 55)"),
      },
    },
    async ({ model, id, timeout_s }, extra) => {
      const deadline = Date.now() + (timeout_s ?? 45) * 1000;
      const token = extra._meta?.progressToken;
      let last: Awaited<ReturnType<CraftStoryClient["getStatus"]>> | undefined;
      try {
        while (true) {
          if (Date.now() >= deadline && last) return text({ state: "running", ...last, hint: "still running - call wait_for_job again" });
          last = await client.getStatus(model as JobKind, id);
          const state = classify(last.status);
          if (token !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: last.status_percentage ?? 0, total: 100, message: last.status },
            });
          }
          if (state !== "running") {
            const result = state === "done" ? await client.getResult(model as JobKind, id) : undefined;
            return text({ state, ...last, ...(result ? { result } : {}) });
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return text({ state: "running", ...last, hint: "still running - call wait_for_job again" });
          await new Promise((r) => setTimeout(r, Math.min(model === "audio-clip" ? 2000 : 5000, remaining)));
        }
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "upscale_video",
    {
      title: "Upscale a finished video (new job)",
      description:
        "Creates a NEW job with the upscaled result; the original stays. craftstory-2: only 720p sources, resolution 1080_1920 (from 720_1280) or 1920_1080 (from 1280_720). minimax-h3: always 2x, no resolution needed. " +
        "Costs 0.2 credits per second. Poll the returned id with wait_for_job.",
      inputSchema: {
        model: z.enum(["craftstory-2", "minimax-h3"]),
        id: z.string().uuid(),
        resolution: z.enum(["1080_1920", "1920_1080"]).optional().describe("craftstory-2 only"),
      },
    },
    async ({ model, id, resolution }) => {
      try {
        if (model === "craftstory-2") {
          if (!resolution) throw new Error("craftstory-2 upscale needs resolution 1080_1920 or 1920_1080");
          const r = await client.upscaleCraftStory2(id, resolution);
          return text({ id: r.id, status: r.status, credits: r.credits });
        }
        const r = await client.upscaleMiniMaxH3(id);
        return text({ id: r.id, status: r.status, credits: r.credits });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerPrompt(
    "talking_video_from_photo",
    {
      title: "Talking video from a photo",
      description: "Step-by-step recipe: script -> voice -> audio clip -> CraftStory 2.0 video -> download.",
      argsSchema: { script: z.string().describe("What the person should say"), photo: z.string().describe("Photo URL or local path") },
    },
    ({ script, photo }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Make a talking video of the person in ${photo} saying: "${script}".\n` +
              "1) list_voices and pick a fitting voice. 2) create_audio_clip with the script and that voice; wait_for_job(model='audio-clip') until done. " +
              "3) preview_cost, then create_craftstory2_video with the clip id, the photo and resolution 720_1280 (portrait) or 1280_720 (landscape). " +
              "4) wait_for_job(model='craftstory-2') repeatedly until done (8-15 minutes). 5) get_job_result and give me the video URL.",
          },
        },
      ],
    }),
  );

  return server;
}
