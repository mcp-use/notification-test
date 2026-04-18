#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcp = new Server(
  { name: "notification-test", version: "1.0.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      'Events from the notification-test channel arrive as <channel source="notification-test" ...>. They are one-way: read them and act, no reply expected.',
  }
);

await mcp.connect(new StdioServerTransport());

// HTTP listener — POST a message here and it gets pushed to Claude
Bun.serve({
  port: 8788,
  hostname: "127.0.0.1",
  async fetch(req) {
    const body = await req.text();
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: body,
        meta: { severity: "info", source: "notification-test" },
      },
    });
    return new Response("ok");
  },
});
