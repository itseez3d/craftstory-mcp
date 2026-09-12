# CraftStory MCP server

Generate talking-avatar videos from Claude, Cursor, Claude Code or any other [MCP](https://modelcontextprotocol.io) client, using the [CraftStory](https://craftstory.com) API:

- **CraftStory 2.0** - a talking video of any length from one photo plus an audio clip (script + voice, your own recording, or a custom avatar). 8-15 minutes per video.
- **MiniMax H3** - a clip of up to 15 s from one photo: description-driven with generated sound, or audio-driven with lip-sync. 1-3 minutes.

You need a CraftStory account on a plan with API access and an API key (app: **Account -> API Access**, keys look like `sk-cs-...`). Generations are billed in credits exactly like in the app; failed jobs are refunded.

## Install

### Claude Code

```bash
claude mcp add craftstory -e CRAFTSTORY_API_KEY=sk-cs-... -- npx -y @craftstory/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings -> Developer -> Edit Config):

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

Same shape in `.cursor/mcp.json` (or the client's MCP config): command `npx`, args `["-y", "@craftstory/mcp"]`, env `CRAFTSTORY_API_KEY`.

Environment variables: `CRAFTSTORY_API_KEY` (required), `CRAFTSTORY_API_BASE` (optional, default `https://api.craftstory.com/api/v1`).

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

> Make a 15-second portrait video of the person in `~/photos/anna.jpg` saying "Welcome to our spring collection", calm gestures.

The assistant will: `list_voices` -> `create_audio_clip` -> `wait_for_job(audio-clip)` -> `preview_cost` -> `create_craftstory2_video` (resolution `720_1280`, gestures `calm`) -> `wait_for_job(craftstory-2)` a few times -> `get_job_result` -> the video URL.

Long jobs: `wait_for_job` never blocks longer than `timeout_s` (max 55 s, under the 60 s tool-call limit of most clients). A CraftStory 2.0 video needs several calls; that is by design so agent runtimes do not time out.

## Local files vs URLs

Photos accept `image_url` or `image_path`; recordings and extra references are local paths (uploaded as multipart). Photos up to 20 MB (JPG/PNG/HEIC), audio WAV/MP3/M4A.

## Development

```bash
npm install
npm run build
CRAFTSTORY_API_KEY=sk-cs-... npm run smoke       # live check over stdio (add -- --h3 to also render a 5 s H3 clip)
npm test
```

Full API reference: https://api.craftstory.com/api/v1/docs/public/ and the curl walkthrough at https://api.craftstory.com/api/v1/docs/samples/curl/.

## License

MIT
