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

test("create_craftstory2 with an avatar and no photo uses the avatar's first scene", async () => {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    n += 1;
    const body = n === 1 ? [{ id: "11111111-1111-4111-8111-111111111111", name: "mia-car-9x16-b" }, { id: "22222222-2222-4222-8222-222222222222" }] : { id: "j2", status: "created", credits: 60 };
    return new Response(JSON.stringify(body), { status: n === 1 ? 200 : 201, headers: { "Content-Type": "application/json" } });
  };
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl });
  const r = await c.createCraftStory2({ avatar_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", audios: ["a1"], resolution: "768_960" });
  assert.equal(r.id, "j2");
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/craftstory-2/avatars/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/scenes/");
  const fd = calls[1].body as FormData;
  assert.equal(fd.get("scene_id"), "11111111-1111-4111-8111-111111111111");
  assert.equal(fd.get("avatar_id"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(fd.get("image"), null);
});

test("minimax h3 routes basic and reference modes to their endpoints", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "h" }, calls) });
  await c.createMiniMaxH3({ mode: "basic", image: { url: "https://x/p.jpg" }, user_prompt: "waves", requested_duration_s: 5 });
  await c.createMiniMaxH3({ mode: "reference", image: { url: "https://x/p.jpg" }, audios: ["a1"] });
  await c.createMiniMaxH3({ mode: "reference", image: { url: "https://x/p.jpg" }, user_prompt: 'says "hi"', requested_duration_s: 7 });
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/minimax-h3/");
  assert.equal((calls[0].body as FormData).get("requested_duration_s"), "5");
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/minimax-h3/reference/");
  assert.deepEqual((calls[1].body as FormData).getAll("audios"), ["a1"]);
  assert.equal((calls[1].body as FormData).get("requested_duration_s"), null); // the audio sets the length
  assert.equal(calls[2].url, "https://api.craftstory.com/api/v1/minimax-h3/reference/");
  assert.deepEqual((calls[2].body as FormData).getAll("audios"), []);
  assert.equal((calls[2].body as FormData).get("requested_duration_s"), "7");
});

test("job paths per kind and a readable 401", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "bad", fetchImpl: fakeFetch(401, { detail: "Subscription expired." }, calls) });
  assert.equal(c.jobPath("audio-clip", "x"), "/audio/clips/x/");
  assert.equal(c.jobPath("minimax-h3", "x"), "/minimax-h3/x/");
  await assert.rejects(c.getStatus("craftstory-2", "x"), (e: unknown) => e instanceof ApiError && e.status === 401 && /Subscription expired/.test(e.message));
});

test("a per-request timeout budget aborts a hung status call", async () => {
  const never: typeof fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))))) as typeof fetch;
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: never });
  // AbortSignal.timeout() timers are unref'd; a real request keeps the loop alive via its socket,
  // the fake one does not, so hold the loop open for the duration of the test.
  const keepAlive = setInterval(() => {}, 100);
  try {
    const t0 = Date.now();
    await assert.rejects(c.getStatus("minimax-h3", "x", 1000), /Timeout after 1s/);
    assert.ok(Date.now() - t0 < 3000, "returned promptly after the budget");
  } finally {
    clearInterval(keepAlive);
  }
});

test("plaintext API base is refused unless explicitly allowed", () => {
  assert.throws(() => new CraftStoryClient({ apiKey: "k", baseUrl: "http://localhost:8000/api/v1" }), /must use https/);
  process.env.CRAFTSTORY_ALLOW_HTTP = "1";
  try {
    assert.ok(new CraftStoryClient({ apiKey: "k", baseUrl: "http://localhost:8000/api/v1" }));
  } finally {
    delete process.env.CRAFTSTORY_ALLOW_HTTP;
  }
});

test("~/ in a local path expands to the home directory", async () => {
  const { fileOrUrl } = await import("../src/client.js");
  await assert.rejects(fileOrUrl({ path: "~/definitely-missing-craftstory-mcp.jpg" }, "image"), (e: NodeJS.ErrnoException) => e.code === "ENOENT" && !e.message.includes("~/"));
});

test("create_image sends JSON when every source is a URL, upload ids become their file URLs", async () => {
  const calls: Call[] = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    n += 1;
    const body = n === 1
      ? { id: "u1", kind: "image", status: "uploaded", file_url: "https://bucket.s3.amazonaws.com/u1.png", expires_at: "" }
      : { id: "i1", status: "created", model: "nano-banana-pro", aspect_ratio: "4:5", credits: 25 };
    return new Response(JSON.stringify(body), { status: n === 1 ? 200 : 201, headers: { "Content-Type": "application/json" } });
  };
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl });
  const r = await c.createImage({ prompt: "on a bench", model: "nano-banana-pro", aspect_ratio: "4:5", image_urls: ["https://x/a.png"], image_upload_ids: ["u1"] });
  assert.equal(r.id, "i1");
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/images/");
  assert.equal(calls[1].headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(calls[1].body)), {
    prompt: "on a bench", model: "nano-banana-pro", aspect_ratio: "4:5", images: ["https://x/a.png", "https://bucket.s3.amazonaws.com/u1.png"],
  });
});

test("create_image refuses an upload that is not there yet", async () => {
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(200, { id: "u1", kind: "image", status: "pending", expires_at: "" }, []) });
  await assert.rejects(c.createImage({ prompt: "x", image_upload_ids: ["u1"] }), /pending/);
});

test("create_image refuses local paths on the hosted connector", async () => {
  const c = new CraftStoryClient({ apiKey: "k", allowLocalFiles: false, fetchImpl: fakeFetch(201, {}, []) });
  await assert.rejects(c.createImage({ prompt: "x", image_paths: ["/tmp/a.png"] }), /request_file_upload/);
});

test("create_music posts JSON and image/music jobs poll their own paths", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "m1", status: "created", credits: 30 }, calls) });
  await c.createMusic({ prompt: "lo-fi", duration_s: 30 });
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/music/");
  assert.deepEqual(JSON.parse(String(calls[0].body)), { prompt: "lo-fi", duration_s: 30 });
  await c.getStatus("image", "i1");
  await c.getStatus("music", "m1");
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/images/i1/status/");
  assert.equal(calls[2].url, "https://api.craftstory.com/api/v1/music/m1/status/");
});

test("503 carries the API's own reason", async () => {
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(503, { detail: "Music generation is temporarily unavailable" }, []) });
  await assert.rejects(c.createMusic({ prompt: "x" }), /Music generation is temporarily unavailable/);
});

test("create_sound_effect posts JSON and polls /sound-effects/", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "s1", status: "created", credits: 2 }, calls) });
  await c.createSoundEffect({ prompt: "door creak", loop: false });
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/sound-effects/");
  assert.deepEqual(JSON.parse(String(calls[0].body)), { prompt: "door creak", loop: false });
  await c.getStatus("sound-effect", "s1");
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/sound-effects/s1/status/");
});

test("cloud models post to their own mount, seedance to /seedance/, auto ratio is omitted", async () => {
  const calls: Call[] = [];
  const c = new CraftStoryClient({ apiKey: "k", fetchImpl: fakeFetch(201, { id: "c" }, calls) });
  await c.createCloudVideo({ model: "flux-3-max", image: { url: "https://x/p.jpg" }, user_prompt: "waves", duration_s: 5, resolution: "720p", aspect_ratio: "16:9", seed: 7 });
  await c.createCloudVideo({ model: "seedance-2.5", image: { url: "https://x/p.jpg" }, user_prompt: "waves", duration_s: 5, resolution: "720p", aspect_ratio: "auto" });
  await c.previewCloudCost("gemini-omni-flash", { duration_s: 5, resolution: "720p" });
  await c.upscaleCloudVideo("heygen-video", "h1");
  assert.equal(calls[0].url, "https://api.craftstory.com/api/v1/flux-3-max/");
  const fd = calls[0].body as FormData;
  assert.equal(fd.get("image"), "https://x/p.jpg");
  assert.deepEqual([fd.get("duration_s"), fd.get("resolution"), fd.get("aspect_ratio"), fd.get("seed")], ["5", "720p", "16:9", "7"]);
  assert.equal(calls[1].url, "https://api.craftstory.com/api/v1/seedance/");
  assert.equal((calls[1].body as FormData).get("aspect_ratio"), null);
  assert.equal(calls[2].url, "https://api.craftstory.com/api/v1/gemini-omni-flash/preview-cost/");
  assert.equal(calls[3].url, "https://api.craftstory.com/api/v1/heygen-video/h1/upscale/");
  assert.equal(c.jobPath("seedance-2.5", "x"), "/seedance/x/");
  assert.equal(c.jobPath("minimax-h3-max", "x"), "/minimax-h3-max/x/");
});
