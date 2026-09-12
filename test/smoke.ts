/**
 * Live smoke over stdio with the official MCP client: lists tools/prompts, then
 * runs the non-GPU tools against the API named by CRAFTSTORY_API_BASE.
 * Usage: CRAFTSTORY_API_KEY=... CRAFTSTORY_API_BASE=... npx tsx test/smoke.ts [--h3]
 * --h3 also creates a 5 s MiniMax H3 basic job (COSTS CREDITS: 17) from SMOKE_IMAGE (a local photo) and waits for it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const withH3 = process.argv.includes("--h3");
const client = new Client({ name: "smoke", version: "0.0.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } as Record<string, string> });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
const prompts = await client.listPrompts();
console.log("prompts:", prompts.prompts.map((p) => p.name).join(", "));

let failures = 0;
async function call(name: string, args: Record<string, unknown>, expectError = false) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  if (Boolean(r.isError) !== expectError) { failures++; console.error(`  !! ${name}: unexpected ${r.isError ? "error" : "success"}`); }
  const body = (r.content as { type: string; text: string }[])[0]?.text ?? "";
  let parsed: unknown = body;
  try { parsed = JSON.parse(body); } catch { /* plain text */ }
  return { isError: r.isError === true, body: parsed };
}

const models = await call("list_models", {});
console.log("list_models:", models.isError ? body(models) : (models.body as { id: string; status: string }[]).map((m) => `${m.id}=${m.status}`).join(" "));

const voices = await call("list_voices", {});
const lib = (voices.body as { library: { id: string; name: string }[] }).library;
console.log(`list_voices: ${lib.length} voices, first ${lib[0].name}`);

const clip = await call("create_audio_clip", { text: "Hello from the CraftStory MCP server.", voice_id: lib[0].id });
console.log("create_audio_clip:", clip.isError ? body(clip) : "id " + (clip.body as { id: string }).id);
const clipId = (clip.body as { id: string }).id;

const waited = await call("wait_for_job", { model: "audio-clip", id: clipId, timeout_s: 20 });
const w = waited.body as { state: string; status: string };
console.log(`wait_for_job(audio-clip): state=${w.state} status=${w.status}`);
if (w.state !== "done") failures++;

const cost = await call("preview_cost", { audio_clip_ids: [clipId], resolution: "720_1280" });
console.log("preview_cost:", body(cost));

const bad = await call("create_audio_clip", { text: "x", voice_id: "11111111-1111-1111-1111-111111111111" }, true);
console.log("bad voice -> isError", bad.isError, "|", String(body(bad)).slice(0, 140));

const p = await client.getPrompt({ name: "talking_video_from_photo", arguments: { script: "Hi", photo: "a.jpg" } });
console.log("prompt renders:", (p.messages[0].content as { text: string }).text.slice(0, 60) + "...");

if (withH3) {
  const image_path = process.env.SMOKE_IMAGE ?? "portrait.jpg";
  const h3 = await call("create_minimax_h3_video", { mode: "basic", image_path, user_prompt: "She looks up, smiles and waves at the camera; soft cafe noise", requested_duration_s: 5, name: "mcp smoke" });
  console.log("create_minimax_h3_video:", body(h3));
  const id = (h3.body as { id: string }).id;
  for (let i = 0; i < 8; i++) {
    const r = await call("wait_for_job", { model: "minimax-h3", id, timeout_s: 55 });
    const s = r.body as { state: string; status: string; status_percentage?: number; result?: { video_url?: string; credits?: number } };
    console.log(`  wait_for_job: ${s.state} ${s.status} ${s.status_percentage ?? ""}%`);
    if (s.state !== "running") { console.log("  result:", s.result?.video_url ? "video_url ok" : "no video", "credits", s.result?.credits); break; }
  }
}

await client.close();
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
process.exit(0);

function body(r: { body: unknown }) { return typeof r.body === "string" ? r.body : JSON.stringify(r.body); }
