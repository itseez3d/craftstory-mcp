/**
 * Express application for the hosted server. Kept apart from the entrypoint so
 * tests can mount it on a random port with a local JWKS.
 */
import { createHash } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { CraftStoryClient, DEFAULT_BASE } from "./client.js";
import { buildServer } from "./server.js";

export interface HttpServerOptions {
  /** Public origin of this server, no trailing slash. */
  publicUrl: string;
  /** Expected `iss` (Auth0: https://<domain>/). */
  issuer: string;
  /** JWKS of the authorization server. */
  jwksUrl: string;
  /** Expected `aud` (the Auth0 API identifier). */
  audience: string;
  /** Scopes advertised in the protected-resource metadata. */
  scopes: string[];
  apiBase?: string;
  allowedOrigins?: string[];
  trustProxy?: boolean;
  /** Requests per minute per user (default 60). */
  rateLimitPerMinute?: number;
}

export const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com", "https://www.anthropic.com"];

/** Verifies an Auth0 access token against the tenant's JWKS; returns the SDK's AuthInfo. */
export function makeVerifier(opts: Pick<HttpServerOptions, "issuer" | "jwksUrl" | "audience">): OAuthTokenVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: opts.issuer, audience: opts.audience, algorithms: ["RS256"] }));
      } catch (e) {
        // Any verification failure is a 401 with the challenge, never a 500 (the SDK maps only its own error types).
        throw new InvalidTokenError((e as Error).message);
      }
      return {
        token,
        clientId: String(payload.azp ?? payload.client_id ?? ""),
        scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
        expiresAt: payload.exp,
        extra: { sub: payload.sub },
      };
    },
  };
}

function subOf(req: Request): string {
  const sub = (req.auth?.extra as { sub?: string } | undefined)?.sub ?? req.ip ?? "anonymous";
  return createHash("sha256").update(sub).digest("hex").slice(0, 16);
}

export function createServer(opts: HttpServerOptions) {
  const app = express();
  app.disable("x-powered-by");
  if (opts.trustProxy) app.set("trust proxy", 1);

  const resourceMetadataUrl = `${opts.publicUrl}/.well-known/oauth-protected-resource/mcp`;
  const metadata = {
    resource: `${opts.publicUrl}/mcp`,
    authorization_servers: [opts.issuer],
    scopes_supported: opts.scopes,
    bearer_methods_supported: ["header"],
    resource_name: "CraftStory",
    resource_documentation: "https://craftstory.com/mcp/",
  };
  const serveMetadata = (_req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=3600").json(metadata);
  };
  // RFC 9728: path-aware location first, root location for clients that ignore the path.
  app.get("/.well-known/oauth-protected-resource/mcp", serveMetadata);
  app.get("/.well-known/oauth-protected-resource", serveMetadata);

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/", (_req, res) => res.redirect(302, "https://craftstory.com/mcp/"));

  // Browser callers must come from a known origin; non-browser clients send no Origin.
  const allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS);
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32000, message: "Origin not allowed" }, id: null });
      return;
    }
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Accept");
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Expose-Headers", "WWW-Authenticate");
      res.set("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const bearer = requireBearerAuth({ verifier: makeVerifier(opts), resourceMetadataUrl });
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: opts.rateLimitPerMinute ?? 60,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: subOf,
    // The limiter runs after bearer auth, so the key is the hashed token subject, never an IP.
    validate: { keyGeneratorIpFallback: false },
    message: { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests; slow down" }, id: null },
  });

  app.post("/mcp", bearer, limiter, express.json({ limit: "1mb" }), async (req, res) => {
    // Stateless: one MCP server + transport per request. Nothing survives the response,
    // so restarts and several replicas need no shared session store.
    const client = new CraftStoryClient({
      authHeader: `Auth0 ${req.auth!.token}`,
      baseUrl: opts.apiBase ?? DEFAULT_BASE,
      allowLocalFiles: false,
    });
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(JSON.stringify({ msg: "mcp request failed", user: subOf(req), error: (e as Error).message }));
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  // No server-initiated streams and no sessions in stateless mode.
  app.all("/mcp", (_req, res) => {
    res.set("Allow", "POST, OPTIONS").status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  });

  return app;
}

export type { JWTPayload };
