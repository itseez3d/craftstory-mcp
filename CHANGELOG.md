# Changelog

## 0.8.0

- `create_cloud_video` and `preview_cloud_video_cost`: six photo-as-first-frame models through one tool - `seedance-2.5`,
  `flux-3-video`, `flux-3-max`, `minimax-h3-max`, `heygen-video`, `gemini-omni-flash` - with their limits and prices in the
  tool description. `wait_for_job`, `get_job_status`, `get_job_result` and `upscale_video` take the same model ids.

## 0.7.0

- `create_image`: two more models, `seedream-5-pro` (ByteDance Seedream 5.0 Pro, 13 credits) and `flux-3`
  (Black Forest Labs FLUX.3 Image, 14 credits); prices now 10 for `nano-banana` and 39 for `nano-banana-pro`.

## 0.6.0

- `create_image`: Nano Banana / Nano Banana Pro images from a prompt and up to 8 source pictures
  (URLs, local files, or image upload ids), with `aspect_ratio` 9:16, 16:9, 4:5, 1:1, 3:4 or 4:3.
- `create_music`: ElevenLabs music tracks of 5-180 s, instrumental by default.
- `create_sound_effect`: ElevenLabs sound effects and ambience of 0.5-30 s (or auto length), optional seamless loop.
- `wait_for_job`, `get_job_status`, `get_job_result` take `model: "image" | "music" | "sound-effect"`; a music prompt declined
  for naming an artist or a song returns the provider's `prompt_suggestion` right away.
- A 503 now carries the API's own reason (for example, music switched off) instead of a generic "paused".

## 0.5.1

- `create_craftstory2_video`: with `avatar_id` a photo is optional; without `scene_id` the avatar's first scene
  is the frame, so an assistant no longer waits for an upload when the user named an avatar or a scene.

## 0.5.0

- Upload links take audio and video (100 MB): `request_file_upload(kind)`. `create_audio_clip` accepts
  `audio_upload_id`; the MiniMax H3 tools accept `reference_upload_ids`. The server pulls the stored file
  by upload id (never by a caller-supplied URL) into a temp file and sends it to the API as multipart.

## 0.4.0

- 4:5 portrait: `create_craftstory2_video` accepts `resolution: "768_960"` (billed as 720p, audio under
  30 minutes); `upscale_video` takes `1152_1440` for it.
- `lipsync_mode` now defaults to `sync_so` on the server (as in the web app); pass `craftstory` for the built-in engine.

## 0.3.0

- Upload links: `request_file_upload` gives the user a one-time page to drop a photo (15 minutes, one file);
  `wait_for_upload` / `get_upload` return a `file_url` that the create tools accept as `image_url`.
  Solves "attach a photo in claude.ai" for the hosted connector, where chat attachments never reach the server.

## 0.2.0

- Hosted mode: `craftstory-mcp-http` serves the same tools over Streamable HTTP with OAuth 2.1 (Auth0), for
  claude.ai custom connectors; RFC 9728 protected-resource metadata, stateless transport, per-user rate limit.
- Client accepts a ready `Authorization` header and can refuse local file paths (hosted mode).
- Dockerfile for the hosted image.

## 0.1.8 - 2026-10-08

- `aspect_ratio` on `create_minimax_h3_video` and `create_minimax_h3_avatar_video`: auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21, or 4:5 (rendered as 3:4 and center-cropped for ads).

## 0.1.7 - 2026-10-07

- Copy: tool texts say "custom avatar" instead of "LoRA avatar"; `list_avatars` rows now also carry `lora_status` / `h3_status` where the API provides them (an avatar is usable with minimax-h3 right after upload, with craftstory-2 once training finishes).

## 0.1.6 - 2026-10-07

- New tool `create_minimax_h3_avatar_video`: a custom avatar (from `list_avatars`, `models` incl. `minimax-h3`) speaks `speech_text` in its own voice inside one of its scenes; 5-14 s, up to 3 extra image/audio references, 5.6 credits per second (`POST /api/v1/minimax-h3/avatar/`).
- `list_avatars` rows carry `models`: which endpoints take the id (`craftstory-2`, `minimax-h3`).

## 0.1.5 - 2026-10-06

- Pricing text follows the new per-mode MiniMax H3 rates: 4.2 credits per billed second in basic and reference modes, 5.6 in avatar mode (was a flat 3.3). No tool or parameter changes.

## 0.1.4 - 2026-10-03
- create_minimax_h3_video: reference mode no longer needs audio_clip_id - with requested_duration_s and a user_prompt that holds the spoken line in quotes, the reference model voices it (API: POST /minimax-h3/reference/ without `audios`)

## 0.1.3 - 2026-09-12
- tool annotations (readOnlyHint / destructiveHint) on every tool; Privacy Policy section in the README
- MCPB bundle for Claude Desktop (manifest.json, icon) attached to GitHub releases
- `mcpName` for the official MCP Registry; server.json

## 0.1.2 - 2026-09-12
- package metadata: public repository and issue tracker on GitHub (itseez3d/craftstory-mcp); CHANGELOG shipped
- wait_for_job: every request inside the wait is capped by the time left, so the call really returns within timeout_s (+ a few seconds for the result fetch)
- create_audio_clip rejects ambiguous input (both voice ids, or a file together with text)
- image_path / file_path accept ~/ and are documented as absolute paths
- CRAFTSTORY_API_BASE must be https unless CRAFTSTORY_ALLOW_HTTP=1
- Node >= 20 (matches the dependency tree); prepack builds; SECURITY.md; GitHub Actions CI

## 0.1.1 - 2026-09-12
- wait_for_job: default 45 s, max 55 s, deadline-aware polling (stays under the 60 s tool-call limit of most MCP clients)
- every API request has a 25 s HTTP timeout; network errors report their cause
- removed an internal repository URL from package metadata (0.1.0 is deprecated for that reason)

## 0.1.0 - 2026-09-12
- first release: 11 tools over the CraftStory public API (models, voices, avatars, audio clips, cost preview,
  CraftStory 2.0 and MiniMax H3 generation, status, result, bounded wait, upscale) and one prompt
