# Changelog

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
