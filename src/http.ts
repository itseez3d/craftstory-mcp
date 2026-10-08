#!/usr/bin/env node
/**
 * Hosted CraftStory MCP server: Streamable HTTP + OAuth 2.1 (Auth0 as the
 * authorization server), for claude.ai connectors and other remote MCP clients.
 *
 * Every request carries an Auth0 access token minted for this resource; it is
 * verified here (JWKS, issuer, audience, expiry) and forwarded unchanged to the
 * CraftStory API as `Authorization: Auth0 <token>`, where the back resolves the
 * user. No credentials are stored on this host.
 *
 * Environment:
 *  MCP_PUBLIC_URL        - https://mcp.craftstory.com (no trailing slash); the MCP endpoint is <url>/mcp
 *  AUTH0_DOMAIN          - tenant domain, e.g. xxx.us.auth0.com
 *  MCP_AUDIENCE          - Auth0 API identifier; defaults to <MCP_PUBLIC_URL>/mcp
 *  MCP_SCOPES            - space-separated scopes this server advertises (default "craftstory")
 *  CRAFTSTORY_API_BASE   - defaults to https://api.craftstory.com/api/v1 (may be an internal address)
 *  MCP_PUBLIC_API_BASE   - public API base quoted to the model for self-uploads (default https://api.craftstory.com/api/v1)
 *  MCP_ALLOWED_ORIGINS   - comma-separated browser origins allowed to call /mcp (default: Anthropic's)
 *  PORT                  - default 8788
 *  MCP_TRUST_PROXY       - "1" behind a load balancer (X-Forwarded-For for rate limiting)
 */
import { createServer } from "./httpApp.js";

const publicUrl = (process.env.MCP_PUBLIC_URL ?? "").replace(/\/+$/, "");
const auth0Domain = process.env.AUTH0_DOMAIN;
if (!publicUrl || !auth0Domain) {
  console.error("craftstory-mcp-http: MCP_PUBLIC_URL and AUTH0_DOMAIN are required");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8788);
const app = createServer({
  publicUrl,
  issuer: `https://${auth0Domain}/`,
  jwksUrl: `https://${auth0Domain}/.well-known/jwks.json`,
  audience: process.env.MCP_AUDIENCE ?? `${publicUrl}/mcp`,
  scopes: (process.env.MCP_SCOPES ?? "craftstory").split(/\s+/).filter(Boolean),
  apiBase: process.env.CRAFTSTORY_API_BASE,
  publicApiBase: process.env.MCP_PUBLIC_API_BASE,
  allowedOrigins: process.env.MCP_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean),
  trustProxy: process.env.MCP_TRUST_PROXY === "1",
});

const server = app.listen(port, () => console.log(JSON.stringify({ msg: "craftstory-mcp-http listening", port, publicUrl })));
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
