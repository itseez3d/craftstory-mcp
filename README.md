# CraftStory MCP server

Generate talking-avatar videos from Claude, Cursor, Claude Code or any other [MCP](https://modelcontextprotocol.io) client, using the [CraftStory](https://craftstory.com) API:

- **CraftStory 2.0** - a talking video of any length from one photo plus an audio clip (script + voice, your own recording, or a custom avatar). 8-15 minutes per video.
- **MiniMax H3** - a clip of up to 15 s from one photo: description-driven with generated sound, or audio-driven with lip-sync. 1-3 minutes.

You need Node.js 20 or newer, a CraftStory account on a plan with API access, and an API key (app: **Account -> API Access**, keys look like `sk-cs-...`). Generations are billed in credits exactly like in the app; failed jobs are refunded.

## Install

### Claude Code

```bash
claude mcp add --scope user craftstory -e CRAFTSTORY_API_KEY=sk-cs-... -- npx -y @craftstory/mcp
```

(`--scope user` makes it available in every project; drop it to install for the current project only.)

### Claude Desktop

Add to `claude_desktop_config.json` (Settings -> Developer -> Edit Config), then restart Claude Desktop; the server shows up under the tools icon:

```json
{
  "mcpServers": {
    "craftstory": {
      "command": "npx",
      "args": ["-y", "@craftstory/mcp"],
      "env": { "CRAFTSTORY_API_KEY": "sk-cs-..." }
    }
  }
}
```

### Cursor / other clients

Same shape in `~/.cursor/mcp.json` (user-level, so the key never lands in a repository): command `npx`, args `["-y", "@craftstory/mcp"]`, env `CRAFTSTORY_API_KEY`. In a project-level `.cursor/mcp.json` prefer `"CRAFTSTORY_API_KEY": "${env:CRAFTSTORY_API_KEY}"` and keep the real key in your shell environment.

Environment variables: `CRAFTSTORY_API_KEY` (required), `CRAFTSTORY_API_BASE` (optional, default `https://api.craftstory.com/api/v1`; must be https unless `CRAFTSTORY_ALLOW_HTTP=1`).

## Tools

| Tool | What it does |
|---|---|
| `list_models` | Models, status (a paused model answers 503), limits and prices |
| `list_voices` | Library voices; `include_cloned` adds your cloned voices |
| `list_avatars` | Your custom avatars, or the scenes of one avatar |
| `create_audio_clip` | Speech from text + voice, or upload a local recording |
| `preview_cost` | Credit estimate for a CraftStory 2.0 video |
| `create_craftstory2_video` | Start a CraftStory 2.0 job (photo or avatar scene + audio clips) |
| `create_minimax_h3_video` | Start a MiniMax H3 job (basic or reference mode) |
| `get_job_status` | Status, percentage, failure reason, refund flag |
| `get_job_result` | Full record with the signed video URL (valid 7 days) |
| `wait_for_job` | Bounded polling (default 45 s, max 55 s); call again while `state` is `running` |
| `upscale_video` | New job with the upscaled result (CraftStory 2.0 720p -> 1080p, H3 2x) |

Plus the prompt `talking_video_from_photo` (script + photo) that walks the model through the whole flow.

## Example

> Make a portrait video of the person in `/Users/me/photos/portrait.jpg` saying "Welcome to our spring collection", calm gestures.

The assistant will: `list_voices` -> `create_audio_clip` -> `wait_for_job(audio-clip)` -> `preview_cost` -> `create_craftstory2_video` (resolution `720_1280`, gestures `calm`) -> `wait_for_job(craftstory-2)` a few times -> `get_job_result` -> the video URL.

Long jobs: `wait_for_job` returns within `timeout_s` (default 45 s, max 55 s) plus a few seconds for the final result fetch; every request inside it is capped by the time left, so it stays under the 60 s tool-call limit of most clients. A CraftStory 2.0 video needs several calls; that is by design so agent runtimes do not time out. A CraftStory 2.0 video needs several calls; that is by design so agent runtimes do not time out.

## Local files vs URLs

Photos accept `image_url` (JPG/PNG) or `image_path` (absolute path or `~/...`; JPG/PNG/HEIC, up to 20 MB, uploaded as multipart). Recordings and extra references are local paths too. Anything you pass as a path is uploaded to the CraftStory API, so keep your client's tool-approval prompts on (see SECURITY.md).

## Development

```bash
npm install
npm run build
CRAFTSTORY_API_KEY=sk-cs-... npm run smoke       # live check over stdio: lists tools, makes an audio clip, previews cost
# add "-- --h3" and SMOKE_IMAGE=/path/to/photo.jpg to also render a 5 s MiniMax H3 clip (costs 17 credits)
npm test
```

Full API reference: https://api.craftstory.com/api/v1/docs/public/ and the curl walkthrough at https://api.craftstory.com/api/v1/docs/samples/curl/.

## Privacy Policy

This server runs on your machine and keeps no data of its own. It sends your API key and the inputs you pass to tools
(text, photos, audio, reference files) only to the CraftStory API at `CRAFTSTORY_API_BASE` (default
`https://api.craftstory.com`), where they are processed under the CraftStory privacy policy:
https://craftstory.com/privacy/. Generated videos and uploaded files are stored in your CraftStory account and can be
deleted there or via the API; nothing is retained locally by the server. No analytics or third-party services are
called by the server itself. Questions: support via https://craftstory.com/contacts/.

## License

MIT
