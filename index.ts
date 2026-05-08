import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";

const server = new MCPServer({
  name: "notification-test",
  version: "1.0.0",
  description: "MCP server enabling Claude-to-Claude messaging via channel notifications",
});

const log = (event: string, data: Record<string, unknown> = {}) => {
  const ts = new Date().toISOString().slice(11, 23);
  const parts = Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  console.log(`[${ts}] ${event.padEnd(18)} ${parts.join(" ")}`);
};

const short = (sid: string | undefined) => (sid ? sid.slice(0, 8) : "—");

const encoder = new TextEncoder();

// Write directly to the GET SSE stream controller for a session,
// bypassing transport.send() which fails when no active request is in flight.
const sendToSession = async (sessionId: string, method: string, params: Record<string, unknown>): Promise<boolean> => {
  const sessionsMap = (server as any).sessions as Map<string, any> | undefined;
  const data = sessionsMap?.get(sessionId);
  const transport = data?.transport as any;
  const sseId = transport?._standaloneSseStreamId ?? "_GET_stream";
  const controller = transport?._streamMapping?.get(sseId)?.controller;
  if (!controller) return false;
  const notification = { jsonrpc: "2.0", method, params };
  const sseData = `event: message\ndata: ${JSON.stringify(notification)}\n\n`;
  try {
    controller.enqueue(encoder.encode(sseData));
    return true;
  } catch {
    return false;
  }
};

// agentId -> sessionId
const agents = new Map<string, string>();
let nextAgentNum = 1;

const agentIdFor = (sessionId: string): string | undefined => {
  for (const [id, sid] of agents) if (sid === sessionId) return id;
  return undefined;
};

const dumpRoster = () => {
  const active = new Set(server.getActiveSessions());
  const rows = [...agents.entries()].map(([id, sid]) => `${id}=${short(sid)}${active.has(sid) ? "" : "·dead"}`);
  log("ROSTER", { active: active.size, registered: agents.size, agents: rows });
};

const dumpSessions = () => {
  const sessionsMap = (server as any).sessions as Map<string, any> | undefined;
  if (!sessionsMap) return log("dumpSessions", { error: "server.sessions missing" });
  for (const [sid, data] of sessionsMap) {
    const transport = data.transport as any;
    const streamMapping = transport?._streamMapping;
    const streamKeys = streamMapping ? [...streamMapping.keys()] : [];
    const standaloneSseId = transport?._standaloneSseStreamId;
    log("SESSION", {
      session: short(sid),
      transportType: transport?.constructor?.name,
      streamKeys,
      standaloneSseId,
      hasLocalStream: streamMapping?.has(standaloneSseId ?? "_GET_stream"),
      client: data.clientInfo?.name,
    });
  }
};

// Monkey-patch getServerForSession so the claude/channel capability is
// advertised on every per-session McpServer instance.
const origGetServer = server.getServerForSession.bind(server);
server.getServerForSession = (sessionId?: string) => {
  const mcpServer = origGetServer(sessionId);
  const inner = (mcpServer as any).server;
  if (!inner._capabilities.experimental) inner._capabilities.experimental = {};
  inner._capabilities.experimental["claude/channel"] = {};
  return mcpServer;
};

// Auto-register on initialize via mcp-use middleware. This is the proper hook —
// `getServerForSession` isn't called per-session in the current HTTP path.
(server as any).use("mcp:initialize", async (ctx: any, next: any) => {
  const result = await next();
  const sid = ctx.session?.sessionId;
  if (sid && !agentIdFor(sid)) {
    const id = `agent-${nextAgentNum++}`;
    agents.set(id, sid);
    log("SESSION_INIT", { agent: id, session: short(sid) });
  }
  return result;
});

// Reconcile the agents map with mcp-use's active sessions:
//  - drop entries whose session has disconnected
//  - assign agent-N to any active session we haven't seen yet
const isStreamingSession = (sid: string): boolean => {
  const sessionsMap = (server as any).sessions as Map<string, any> | undefined;
  if (!sessionsMap) return false;
  const data = sessionsMap.get(sid);
  const transport = data?.transport as any;
  const sseId = transport?._standaloneSseStreamId ?? "_GET_stream";
  return transport?._streamMapping?.has(sseId) === true;
};

const reconcile = () => {
  const active = server.getActiveSessions();
  const activeSet = new Set(active);

  for (const [id, sid] of [...agents]) {
    if (!activeSet.has(sid)) {
      log("PRUNE dead", { agent: id, session: short(sid) });
      agents.delete(id);
    } else if (!isStreamingSession(sid)) {
      log("PRUNE non-streaming", { agent: id, session: short(sid) });
      agents.delete(id);
    }
  }

  for (const sid of active) {
    if (!agentIdFor(sid) && isStreamingSession(sid)) {
      const id = `agent-${nextAgentNum++}`;
      agents.set(id, sid);
      log("AUTO_REGISTER streaming", { agent: id, session: short(sid) });
    }
  }
};

const ensureRegistered = (sessionId: string) => {
  if (!agentIdFor(sessionId)) reconcile();
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
    ensureRegistered(sessionId);
    log("TOOL rename", { session: short(sessionId), to: agentId });

    const existing = agents.get(agentId);
    if (existing && existing !== sessionId) {
      log("rename DENIED", { reason: "taken", agentId });
      return text(`"${agentId}" is already taken by another agent.`);
    }
    const old = agentIdFor(sessionId);
    if (old) agents.delete(old);
    agents.set(agentId, sessionId);
    log("rename OK", { from: old ?? "(none)", to: agentId });
    dumpRoster();
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
    log("TOOL list-agents", { session: short(ctx.session.sessionId) });
    dumpSessions();
    reconcile();
    const live = [...agents.keys()];
    const me = agentIdFor(ctx.session.sessionId);
    log("list-agents OK", { live, caller: me });
    return text(
      live.length === 0
        ? "No agents connected."
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
    const senderSession = ctx.session.sessionId;
    reconcile();
    const from = agentIdFor(senderSession) ?? "unknown";
    log("TOOL send-message", { from, to, session: short(senderSession), msg: message });

    const targetSession = agents.get(to);
    if (!targetSession) {
      log("send DENIED", { reason: "unknown-agent", to });
      dumpRoster();
      return text(`Unknown agent "${to}". Try list-agents.`);
    }

    const active = new Set(server.getActiveSessions());
    if (!active.has(targetSession)) {
      log("send DENIED", { reason: "target-disconnected", to, target: short(targetSession) });
      agents.delete(to);
      return text(`Agent "${to}" is no longer connected.`);
    }

    const notification = {
      content: message,
      meta: { severity: "info", source: "agent-message", from, to },
    };

    log("send DISPATCH", { from, to, target: short(targetSession) });
    const ok = await sendToSession(targetSession, "notifications/claude/channel", notification);
    log(ok ? "send OK" : "send FAIL", { from, to, target: short(targetSession) });

    if (!ok) return text(`Delivery to "${to}" failed.`);
    return text(`Sent to "${to}" (from "${from}").`);
  }
);

log("SERVER START", { name: "notification-test" });
server.listen();
