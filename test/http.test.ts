import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import express from "express";
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from "jose";

import { createServer } from "../src/httpApp.js";

const ISSUER = "https://tenant.test.auth0.com/";
const AUDIENCE = "https://mcp.test/mcp";

let privateKey: KeyLike;
let otherKey: KeyLike;
let authServer: Server;
let apiServer: Server;
let mcpServer: Server;
let mcpUrl: string;
const apiCalls: { path: string; authorization?: string }[] = [];

async function mint(opts: { aud?: string; iss?: string; key?: KeyLike; exp?: string; sub?: string } = {}) {
  return new SignJWT({ scope: "craftstory", azp: "client-1" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(opts.sub ?? "auth0|u1")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(opts.key ?? privateKey);
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${mcpUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

before(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  ({ privateKey: otherKey } = await generateKeyPair("RS256"));
  const realPublic = await exportJWK(pair.publicKey);

  const auth = express();
  auth.get("/.well-known/jwks.json", (_req, res) => res.json({ keys: [{ ...realPublic, kid: "k1", alg: "RS256", use: "sig" }] }));
  authServer = await listen(auth);

  const api = express();
  api.use((req, _res, next) => {
    apiCalls.push({ path: req.path, authorization: req.headers.authorization });
    next();
  });
  api.get("/api/v1/models/", (_req, res) => res.json([{ id: "craftstory-2" }, { id: "minimax-h3" }]));
  apiServer = await listen(api);

  process.env.CRAFTSTORY_ALLOW_HTTP = "1";
  mcpServer = await listen(
    createServer({
      publicUrl: "https://mcp.test",
      issuer: ISSUER,
      jwksUrl: `${urlOf(authServer)}/.well-known/jwks.json`,
      audience: AUDIENCE,
      scopes: ["craftstory"],
      apiBase: `${urlOf(apiServer)}/api/v1`,
      rateLimitPerMinute: 1000,
    }),
  );
  mcpUrl = urlOf(mcpServer);
});

after(() => {
  authServer.close();
  apiServer.close();
  mcpServer.close();
});

test("protected resource metadata is public and points at the authorization server", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const res = await fetch(`${mcpUrl}${path}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.resource, "https://mcp.test/mcp");
    assert.deepEqual(body.authorization_servers, [ISSUER]);
    assert.deepEqual(body.scopes_supported, ["craftstory"]);
    assert.deepEqual(body.bearer_methods_supported, ["header"]);
  }
});

test("no token: 401 with a WWW-Authenticate challenge naming the resource metadata", async () => {
  const res = await rpc(INIT);
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
});

test("wrong audience, wrong issuer, foreign key and expired tokens are rejected", async () => {
  for (const token of [
    await mint({ aud: "https://other/" }),
    await mint({ iss: "https://evil.example/" }),
    await mint({ key: otherKey }),
    await mint({ exp: "-1m" }),
  ]) {
    const res = await rpc(INIT, { Authorization: `Bearer ${token}` });
    assert.equal(res.status, 401);
  }
});

test("GET and DELETE are not offered in stateless mode", async () => {
  const res = await fetch(`${mcpUrl}/mcp`);
  assert.equal(res.status, 405);
  assert.equal((await fetch(`${mcpUrl}/mcp`, { method: "DELETE" })).status, 405);
});

test("unknown browser origin is refused before token verification", async () => {
  const res = await rpc(INIT, { Authorization: `Bearer ${await mint()}`, Origin: "https://evil.example" });
  assert.equal(res.status, 403);
});

test("valid token: initialize, tools/list and a tool call that forwards the token to the API", async () => {
  const token = await mint();
  const init = await rpc(INIT, { Authorization: `Bearer ${token}`, Origin: "https://claude.ai" });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("access-control-allow-origin"), "https://claude.ai");
  const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(initBody.result.serverInfo.name, "craftstory");

  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { Authorization: `Bearer ${token}` });
  assert.equal(list.status, 200);
  const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.ok(tools.includes("list_models"));
  assert.ok(tools.includes("create_minimax_h3_video"));

  apiCalls.length = 0;
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_models", arguments: {} } }, { Authorization: `Bearer ${token}` });
  assert.equal(call.status, 200);
  const result = (await call.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.ok(!result.result.isError, JSON.stringify(result));
  assert.match(result.result.content[0].text, /minimax-h3/);
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].path, "/api/v1/models/");
  assert.equal(apiCalls[0].authorization, `Auth0 ${token}`);
});

test("local file paths are refused on the hosted server", async () => {
  const token = await mint();
  const call = await rpc(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_minimax_h3_video", arguments: { mode: "basic", image_path: "/etc/passwd", user_prompt: "hi", requested_duration_s: 5 } } },
    { Authorization: `Bearer ${token}` },
  );
  const result = (await call.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /local file paths are not available/);
});
