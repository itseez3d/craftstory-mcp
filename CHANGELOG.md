# Changelog

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
