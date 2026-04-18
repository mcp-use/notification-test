import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";

const server = new MCPServer({
  name: "notification-test",
  version: "1.0.0",
  description: "Simple MCP server that sends notifications",
});

// Monkey-patch getServerForSession so every new session advertises claude/channel
const origGetServer = server.getServerForSession.bind(server);
server.getServerForSession = (sessionId?: string) => {
  const mcpServer = origGetServer(sessionId);
  const inner = (mcpServer as any).server;
  if (!inner._capabilities.experimental) {
    inner._capabilities.experimental = {};
  }
  inner._capabilities.experimental["claude/channel"] = {};
  return mcpServer;
};

server.tool(
  {
    name: "send-notification",
    description: "Sends a test notification to the client",
    schema: z.object({
      message: z.string().optional().describe("The notification message to send"),
    }),
  },
  async ({ message }, ctx) => {
    await server.sendNotification("notifications/claude/channel", {
      content: message ?? "Hello from notification-test!",
      meta: { severity: "info", source: "notification-test" },
    });

    return text(`Notification sent: "${message}"`);
  }
);

server.listen();
