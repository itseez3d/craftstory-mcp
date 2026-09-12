#!/usr/bin/env node
/** CraftStory MCP server over stdio. Configuration comes from the environment:
 *  CRAFTSTORY_API_KEY  - required, an sk-cs-... key from Account -> API Access
 *  CRAFTSTORY_API_BASE - optional, defaults to https://api.craftstory.com/api/v1
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CraftStoryClient, DEFAULT_BASE } from "./client.js";
import { buildServer } from "./server.js";

const apiKey = process.env.CRAFTSTORY_API_KEY;
if (!apiKey) {
  console.error("craftstory-mcp: set CRAFTSTORY_API_KEY (create a key in the CraftStory app: Account -> API Access)");
  process.exit(1);
}

const client = new CraftStoryClient({ apiKey, baseUrl: process.env.CRAFTSTORY_API_BASE ?? DEFAULT_BASE });
const server = buildServer(client);
const transport = new StdioServerTransport();
await server.connect(transport);
