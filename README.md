# notification-test

A minimal MCP server that emits `notifications/claude/channel` events, used to experiment with Claude Code's [channels](https://code.claude.com/docs/en/channels-reference) feature.

Two server variants live in this repo:

- **`channel.ts`** — the canonical stdio channel server (what Claude Code actually expects). Spawned as a subprocess via `.mcp.json`, also opens port `8788` to receive external HTTP triggers.
- **`index.ts`** — an experiment to make channels work over the [mcp-use](https://github.com/mcp-use/mcp-use) HTTP/SSE transport instead of stdio. Monkey-patches the `claude/channel` capability onto the mcp-use server. Not officially supported by Claude Code, but useful to test how far the contract can stretch.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)
- Node.js 18+
- Claude Code **v2.1.80+** with **claude.ai login** (channels don't work with API-key auth)
- Install deps: `npm install`

## Option A — stdio channel (recommended, matches the docs)

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

2. Start Claude Code with the channel flag so it spawns `channel.ts` as a subprocess:
   ```bash
   claude --dangerously-load-development-channels server:notification-test
   ```

3. From another terminal, push an event into the session:
   ```bash
   curl -X POST localhost:8788 -d "hello from the outside"
   ```

   It arrives in your Claude Code session as:
   ```
   <channel source="notification-test" severity="info" source="notification-test">
   hello from the outside
   </channel>
   ```

## Option B — mcp-use HTTP server (experimental)

Starts a streamable-HTTP MCP server on port 3001 with a `send-notification` tool. The tool emits `notifications/claude/channel` over the SSE stream.

1. Start the server:
   ```bash
   npx mcp-use dev
   ```
   - MCP endpoint: `http://localhost:3001/mcp`
   - Inspector UI: `http://localhost:3001/inspector`

2. Register it with Claude Code and launch with the channel flag:
   ```bash
   claude mcp add --transport http notification-test http://localhost:3001/mcp
   claude --dangerously-load-development-channels server:notification-test
   ```

3. Call the `send-notification` tool from Claude to emit a channel event.

> **Note:** Claude Code's channel implementation was built with stdio transport in mind. The HTTP path advertises the `claude/channel` capability via a monkey-patch on `getServerForSession`, but whether Claude Code actually reacts to the notification depends on internal routing that may change.

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

## Troubleshooting

- **Connection refused on `localhost:8788`**: the stdio server isn't running — check that Claude Code was launched with the `--dangerously-load-development-channels` flag and that `.mcp.json` is in the current directory.
- **Notifications sent but Claude doesn't react**: verify `claude/channel` is in the init response. For Option B:
  ```bash
  curl -s -X POST http://localhost:3001/mcp \
    -H "Content-Type: application/json" -H "Accept: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
  ```
  Look for `"experimental":{"claude/channel":{}}` in the response.
- **"blocked by org policy"**: a Team/Enterprise admin needs to enable channels in managed settings.
