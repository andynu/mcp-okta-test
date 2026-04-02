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

// OAuth Protected Resource Metadata (RFC 9728)
// Claude Desktop/Code fetches this to discover the authorization server
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  const issuer = process.env["OKTA_ISSUER"] ?? "";
  res.json({
    resource: `${_req.protocol}://${_req.get("host")}`,
    authorization_servers: [issuer],
    scopes_supported: ["openid"],
  });
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
 * Build an McpServer instance for the authenticated user.
 * If you're authenticated, you get all the tools. Simple.
 */
function createMcpServerForUser(claims: OktaClaims, groups: string[]) {
  const server = new McpServer({
    name: "stupid-example-mcp",
    version: "1.0.0",
  });

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
            text: `Rolled ${count}d${sides}: [${rolls.join(", ")}] = ${total}`,
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
            text: `Question: "${question}"\n   Answer: ${answer}`,
          },
        ],
      };
    }
  );

  server.tool("who_am_i", "Show your authenticated identity and groups.", async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sub: claims.sub,
            groups,
            node_version: process.version,
            uptime_seconds: Math.floor(process.uptime()),
          },
          null,
          2
        ),
      },
    ],
  }));

  server.tool(
    "echo",
    "Echo back whatever you send. For testing.",
    { message: z.string().describe("Message to echo back") },
    async ({ message }) => ({
      content: [{ type: "text" as const, text: `Echo: ${message}` }],
    })
  );

  return server;
}

// OAuth callback — exchanges the authorization code for a token
const OKTA_ISSUER = process.env["OKTA_ISSUER"] ?? "";
const OKTA_CLIENT_ID = process.env["OKTA_CLIENT_ID"] ?? "";
const OKTA_CLIENT_SECRET = process.env["OKTA_CLIENT_SECRET"] ?? "";

function tokenEndpoint(issuer: string): string {
  if (issuer.includes("/oauth2/")) {
    return `${issuer}/v1/token`;
  }
  return `${issuer}/oauth2/v1/token`;
}

app.get("/callback", async (req, res) => {
  const code = req.query["code"] as string | undefined;
  if (!code) {
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }

  if (!OKTA_CLIENT_ID || !OKTA_CLIENT_SECRET) {
    res.status(500).json({
      error: "OKTA_CLIENT_ID and OKTA_CLIENT_SECRET must be set for the callback to work",
    });
    return;
  }

  const redirectUri = `${req.protocol}://${req.get("host")}/callback`;

  try {
    const tokenRes = await fetch(tokenEndpoint(OKTA_ISSUER), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OKTA_CLIENT_ID,
        client_secret: OKTA_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await tokenRes.json() as Record<string, unknown>;

    if (!tokenRes.ok) {
      res.status(tokenRes.status).json(data);
      return;
    }

    const accessToken = data["access_token"] as string;

    res.json({
      message: "Authenticated! Use this token with the MCP endpoint.",
      access_token: accessToken,
      expires_in: data["expires_in"],
      usage: `curl -X POST ${req.protocol}://${req.get("host")}/mcp -H 'Authorization: Bearer ${accessToken.slice(0, 20)}...'`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    res.status(500).json({ error: message });
  }
});

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
