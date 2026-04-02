import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { oktaAuth, hasGroup, type OktaClaims } from "./okta-auth.js";

const app = express();
app.use(express.json());

// Health check (unauthenticated — Railway uses this)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Info endpoint so you can see what env vars are expected
app.get("/", (_req, res) => {
  res.json({
    name: "Stupid Example MCP Server with Okta Auth",
    mcp_endpoint: "/mcp",
    env_vars_needed: [
      "OKTA_ISSUER  — e.g. https://yourorg.okta.com/oauth2/default",
      "OKTA_AUDIENCE — e.g. api://default (optional, defaults to api://default)",
    ],
    okta_groups_used: [
      "mcp-users  — basic access to greeting and dice tools",
      "mcp-admins — access to admin tools (server info, echo)",
    ],
  });
});

/**
 * Build an McpServer instance scoped to the authenticated user.
 * Tools are registered based on the user's Okta group membership.
 */
function createMcpServerForUser(claims: OktaClaims, groups: string[]) {
  const server = new McpServer({
    name: "stupid-example-mcp",
    version: "1.0.0",
  });

  const isUser = groups.includes("mcp-users") || groups.includes("mcp-admins");
  const isAdmin = groups.includes("mcp-admins");

  // --- Tools available to mcp-users ---

  if (isUser) {
    server.tool(
      "greet",
      "Say hello. Very advanced AI technology.",
      { name: z.string().describe("Who to greet") },
      async ({ name }) => ({
        content: [
          {
            type: "text" as const,
            text: `Hello, ${name}! You are authenticated as ${claims.sub}. Wow.`,
          },
        ],
      })
    );

    server.tool(
      "roll_dice",
      "Roll some dice. Because every example needs dice.",
      {
        sides: z.number().min(2).max(100).default(6).describe("Number of sides"),
        count: z.number().min(1).max(20).default(1).describe("Number of dice"),
      },
      async ({ sides, count }) => {
        const rolls = Array.from({ length: count }, () =>
          Math.floor(Math.random() * sides) + 1
        );
        const total = rolls.reduce((a, b) => a + b, 0);
        return {
          content: [
            {
              type: "text" as const,
              text: `🎲 Rolled ${count}d${sides}: [${rolls.join(", ")}] = ${total}`,
            },
          ],
        };
      }
    );

    server.tool(
      "magic_8ball",
      "Ask the magic 8-ball a question. Guaranteed accurate.",
      { question: z.string().describe("Your yes/no question") },
      async ({ question }) => {
        const answers = [
          "It is certain.",
          "Without a doubt.",
          "Don't count on it.",
          "My reply is no.",
          "Ask again later.",
          "Cannot predict now.",
          "Outlook not so good.",
          "Signs point to yes.",
          "Better not tell you now.",
          "Concentrate and ask again.",
        ];
        const answer = answers[Math.floor(Math.random() * answers.length)]!;
        return {
          content: [
            {
              type: "text" as const,
              text: `🎱 Question: "${question}"\n   Answer: ${answer}`,
            },
          ],
        };
      }
    );
  }

  // --- Tools available to mcp-admins only ---

  if (isAdmin) {
    server.tool("server_info", "Get server info (admin only).", async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              node_version: process.version,
              uptime_seconds: Math.floor(process.uptime()),
              memory_mb: Math.floor(process.memoryUsage().rss / 1024 / 1024),
              user_sub: claims.sub,
              user_groups: groups,
              env: {
                RAILWAY_ENVIRONMENT: process.env["RAILWAY_ENVIRONMENT"] ?? "unknown",
              },
            },
            null,
            2
          ),
        },
      ],
    }));

    server.tool(
      "echo",
      "Echo back whatever you send (admin only). For testing.",
      { message: z.string().describe("Message to echo back") },
      async ({ message }) => ({
        content: [{ type: "text" as const, text: `Echo: ${message}` }],
      })
    );
  }

  // If the user has no relevant groups, give them a single tool that tells them so
  if (!isUser && !isAdmin) {
    server.tool("access_denied", "You don't have access.", async () => ({
      content: [
        {
          type: "text" as const,
          text:
            `You are authenticated as ${claims.sub}, but you are not in the ` +
            `"mcp-users" or "mcp-admins" Okta groups. Your groups: [${groups.join(", ")}]`,
        },
      ],
    }));
  }

  return server;
}

// MCP endpoint — protected by Okta auth
app.post("/mcp", oktaAuth, async (req, res) => {
  const claims = req.oktaClaims!;
  const groups = claims.groups ?? [];

  const server = createMcpServerForUser(claims, groups);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  // Pass auth info to transport so MCP SDK can access it
  (req as any).auth = { token: req.headers.authorization?.slice(7), clientId: claims.sub };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Also handle GET and DELETE for the MCP endpoint (spec compliance)
app.get("/mcp", oktaAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

app.delete("/mcp", oktaAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Stateless server, no sessions to delete." });
});

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Health: http://0.0.0.0:${PORT}/health`);
  console.log(`  MCP:    http://0.0.0.0:${PORT}/mcp`);
  console.log(`  OKTA_ISSUER: ${process.env["OKTA_ISSUER"] ?? "(not set!)"}`);
});
