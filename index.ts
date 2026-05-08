import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";

const server = new MCPServer({
  name: "notification-test",
  version: "1.0.0",
  description: "MCP server enabling Claude-to-Claude messaging via channel notifications",
});

// agentId -> sessionId
const agents = new Map<string, string>();
let nextAgentNum = 1;

const agentIdFor = (sessionId: string): string | undefined => {
  for (const [id, sid] of agents) if (sid === sessionId) return id;
  return undefined;
};

// Monkey-patch getServerForSession to (1) advertise claude/channel and
// (2) auto-register every connecting session as agent-N.
const origGetServer = server.getServerForSession.bind(server);
server.getServerForSession = (sessionId?: string) => {
  const mcpServer = origGetServer(sessionId);
  const inner = (mcpServer as any).server;
  if (!inner._capabilities.experimental) {
    inner._capabilities.experimental = {};
  }
  inner._capabilities.experimental["claude/channel"] = {};

  if (sessionId && !agentIdFor(sessionId)) {
    agents.set(`agent-${nextAgentNum++}`, sessionId);
  }
  return mcpServer;
};

server.tool(
  {
    name: "rename-agent",
    description:
      "Claim a friendlier agent ID (e.g. 'planner', 'coder') instead of the auto-assigned 'agent-N'. Other agents address you by this ID.",
    schema: z.object({
      agentId: z.string().describe("New agent ID for this session"),
    }),
  },
  async ({ agentId }, ctx) => {
    const sessionId = ctx.session.sessionId;
    const existing = agents.get(agentId);
    if (existing && existing !== sessionId) {
      return text(`"${agentId}" is already taken by another agent.`);
    }
    const old = agentIdFor(sessionId);
    if (old) agents.delete(old);
    agents.set(agentId, sessionId);
    return text(`Renamed${old ? ` from "${old}"` : ""} to "${agentId}".`);
  }
);

server.tool(
  {
    name: "list-agents",
    description: "List all currently connected agent IDs.",
    schema: z.object({}),
  },
  async (_args, ctx) => {
    const active = new Set(server.getActiveSessions());
    const live: string[] = [];
    for (const [id, sid] of agents) {
      if (active.has(sid)) live.push(id);
      else agents.delete(id);
    }
    const me = agentIdFor(ctx.session.sessionId);
    return text(
      live.length === 0
        ? "No agents registered."
        : `Connected agents: ${live.join(", ")}${me ? ` (you are "${me}")` : ""}`
    );
  }
);

server.tool(
  {
    name: "send-message",
    description:
      "Send a message to another connected agent. The recipient receives it as a channel notification.",
    schema: z.object({
      to: z.string().describe("agentId of the recipient (see list-agents)"),
      message: z.string().describe("Message body"),
    }),
  },
  async ({ to, message }, ctx) => {
    const targetSession = agents.get(to);
    if (!targetSession) return text(`Unknown agent "${to}". Try list-agents.`);

    const active = new Set(server.getActiveSessions());
    if (!active.has(targetSession)) {
      agents.delete(to);
      return text(`Agent "${to}" is no longer connected.`);
    }

    const from = agentIdFor(ctx.session.sessionId) ?? "unknown";

    const ok = await ctx.sendNotificationToSession(targetSession, "notifications/claude/channel", {
      content: message,
      meta: { severity: "info", source: "agent-message", from, to },
    });

    return text(ok ? `Sent to "${to}" (from "${from}").` : `Delivery to "${to}" failed.`);
  }
);

server.listen();
