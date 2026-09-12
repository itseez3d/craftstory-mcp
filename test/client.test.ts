import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, classify, CraftStoryClient } from "../src/client.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: BodyInit | null };

function fakeFetch(status: number, payload: unknown, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers as Record<string, string>, body: init?.body });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("classify: terminal states", () => {
  assert.equal(classify("done"), "done");
  assert.equal(classify("failed"), "failed");
  assert.equal(classify("failed_tts"), "failed");
  assert.equal(classify("rejected_image"), "failed");
  assert.equal(classify("not_pass_moderation"), "failed");
  assert.equal(classify("in_progress_20_video_generating"), "running");
  assert.equal(classify("created"), "running");
});

test("requests carry the key, the user agent and the base url", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "sk-cs-test", baseUrl: "https://api.example/api/v1/", fetchImpl: fakeFetch(200, [{ id: "craftstory-2" }], calls) });
  const models = await c.listModels();
  assert.deepEqual(models, [{ id: "craftstory-2" }]);
  assert.equal(calls[0].url, "https://api.example/api/v1/models/");
  assert.equal(calls[0].headers.Authorization, "Bearer sk-cs-test");
  assert.match(calls[0].headers["User-Agent"], /^craftstory-mcp\//);
});

test("create_craftstory2 sends multipart with the public field names", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "j1", status: "created", credits: 33 }, calls) });
  const r = await c.createCraftStory2({
    image: { url: "https://x/p.jpg" }, audios: ["a1", "a2"], resolution: "720_1280", lipsync_mode: "craftstory", gestures: "calm", faceswap: false, name: "t",
  });
  assert.equal(r.id, "j1");
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/craftstory-2/");
  const fd = calls[0].body as FormData;
  assert.equal(fd.get("image"), "https://x/p.jpg");
  assert.deepEqual(fd.getAll("audios"), ["a1", "a2"]);
  assert.equal(fd.get("resolution"), "720_1280");
  assert.equal(fd.get("lipsync_mode"), "craftstory");
  assert.equal(fd.get("gestures"), "calm");
  assert.equal(fd.get("faceswap"), "false");
  assert.equal(fd.get("name"), "t");
  assert.equal(fd.get("scene_id"), null);
});

test("minimax h3 routes basic and reference modes to their endpoints", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "h" }, calls) });
  await c.createMiniMaxH3({ mode: "basic", image: { url: "https://x/p.jpg" }, user_prompt: "waves", requested_duration_s: 5 });
  await c.createMiniMaxH3({ mode: "reference", image: { url: "https://x/p.jpg" }, audios: ["a1"] });
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/minimax-h3/");
  assert.equal((calls[0].body as FormData).get("requested_duration_s"), "5");
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/minimax-h3/reference/");
  assert.deepEqual((calls[1].body as FormData).getAll("audios"), ["a1"]);
});

test("job paths per kind and a readable 401", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "bad", fetchImpl: fakeFetch(401, { detail: "Subscription expired." }, calls) });
  assert.equal(c.jobPath("audio-clip", "x"), "/audio/clips/x/");
  assert.equal(c.jobPath("minimax-h3", "x"), "/minimax-h3/x/");
  await assert.rejects(c.getStatus("craftstory-2", "x"), (e: unknown) => e instanceof ApiError && e.status === 401 && /Subscription expired/.test(e.message));
});
