# notification-test

A minimal MCP server that emits `notifications/claude/channel` events, used to experiment with Claude Code's [channels](https://code.claude.com/docs/en/channels-reference) feature.

## TL;DR — the interesting bit

The official docs say channels must run over **stdio** (Claude Code spawns your server as a subprocess). **That's not actually a hard requirement — channels also work over HTTP.** If your MCP server advertises `capabilities.experimental["claude/channel"] = {}` in its `initialize` response and emits `notifications/claude/channel`, Claude Code will react to the events over a streamable-HTTP/SSE connection just fine. No subprocess, no `.mcp.json` command entry — just a URL.

This repo has two server variants:

- **`index.ts` — mcp-use HTTP server. This is the cool one.** Undocumented, but works.
- **`channel.ts` — stdio channel.** Straightforward port of the docs example; boring but included for reference.

## Prerequisites

- [Bun](https://bun.sh) (only needed for the stdio variant)
- Node.js 18+
- Claude Code **v2.1.80+** with **claude.ai login** (channels don't work with API-key auth)
- `npm install`

## The HTTP version (the one worth looking at)

`index.ts` is a mcp-use streamable-HTTP server that declares the `claude/channel` capability and exposes a `send-notification` tool.

```bash
npx mcp-use dev
# MCP endpoint: http://localhost:3001/mcp
# Inspector UI: http://localhost:3001/inspector
```

Register it with Claude Code and launch with the channel flag:

```bash
claude mcp add --transport http notification-test http://localhost:3001/mcp
claude --dangerously-load-development-channels server:notification-test
```

Then call the `send-notification` tool — the event shows up in the Claude Code session as a `<channel>` tag.

### Why mcp-use needs a monkey-patch (for now)

The `MCPServer` class doesn't expose an `experimental` capability passthrough, and it creates a fresh `McpServer` per HTTP session via `getServerForSession`. So `index.ts` wraps that method and injects `experimental["claude/channel"]` into each session's `_capabilities` before it's returned:

```ts
const origGetServer = server.getServerForSession.bind(server);
server.getServerForSession = (sessionId?: string) => {
  const mcpServer = origGetServer(sessionId);
  const inner = (mcpServer as any).server;
  inner._capabilities.experimental ??= {};
  inner._capabilities.experimental["claude/channel"] = {};
  return mcpServer;
};
```

Upstreaming a proper `capabilities.experimental` config passthrough to mcp-use is a todo — the monkey-patch should go away.

### Verify the capability is advertised

```bash
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
```

Look for `"experimental":{"claude/channel":{}}` in the response. If it's missing, Claude Code won't register a listener for channel notifications.

## The stdio version (just follows the docs)

`channel.ts` is a vanilla `@modelcontextprotocol/sdk` server over `StdioServerTransport`, also running `Bun.serve` on :8788 so external HTTP POSTs can trigger channel events. Matches [the docs example](https://code.claude.com/docs/en/channels-reference#example-build-a-webhook-receiver) line for line.

1. Create a `.mcp.json` in this directory:
   ```json
   {
     "mcpServers": {
       "notification-test": {
         "command": "bun",
         "args": ["./channel.ts"]
       }
     }
   }
   ```

2. Start Claude Code:
   ```bash
   claude --dangerously-load-development-channels server:notification-test
   ```

3. Trigger an event:
   ```bash
   curl -X POST localhost:8788 -d "hello from the outside"
   ```

## Notification format

Both variants emit the format from the [channels reference](https://code.claude.com/docs/en/channels-reference#notification-format):

```ts
{
  method: "notifications/claude/channel",
  params: {
    content: "<event body>",
    meta: { severity: "info", source: "notification-test" },
  },
}
```

`content` becomes the body of the `<channel>` tag; each `meta` key becomes a tag attribute.
