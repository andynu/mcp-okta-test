import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { oktaAuth, type OktaClaims } from "./okta-auth.js";

const app = express();
app.set("trust proxy", 1); // Railway terminates TLS; trust proxy for correct req.protocol
app.use(express.json());

// ---------------------------------------------------------------------------
// OAuth discovery + proxy
//
// Okta's Org authorization server doesn't expose public discovery endpoints,
// so we present *this server* as the authorization server in the metadata and
// proxy /authorize and /token through to Okta.
//
// If you have a Custom Authorization Server with public discovery, you could
// point authorization_servers directly at Okta instead of proxying.
// ---------------------------------------------------------------------------

const OKTA_ISSUER = process.env["OKTA_ISSUER"] ?? "";
const OKTA_CLIENT_ID = process.env["OKTA_CLIENT_ID"] ?? "";
const OKTA_CLIENT_SECRET = process.env["OKTA_CLIENT_SECRET"] ?? "";

function oktaAuthorizeUrl(issuer: string): string {
  if (issuer.includes("/oauth2/")) return `${issuer}/v1/authorize`;
  return `${issuer}/oauth2/v1/authorize`;
}

function oktaTokenUrl(issuer: string): string {
  if (issuer.includes("/oauth2/")) return `${issuer}/v1/token`;
  return `${issuer}/oauth2/v1/token`;
}

// RFC 9728 — tells Claude where to find the authorization server
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    scopes_supported: ["openid"],
  });
});

// RFC 8414 — tells Claude where /authorize and /token live
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["openid"],
  });
});

// Redirect to Okta's authorize endpoint, passing all query params through
app.get("/authorize", (req, res) => {
  const params = new URLSearchParams(req.query as Record<string, string>);
  if (!params.has("client_id")) params.set("client_id", OKTA_CLIENT_ID);
  res.redirect(`${oktaAuthorizeUrl(OKTA_ISSUER)}?${params.toString()}`);
});

// Proxy to Okta's token endpoint, injecting client credentials
app.post("/token", express.text({ type: "application/x-www-form-urlencoded" }), async (req, res) => {
  try {
    const body = new URLSearchParams(typeof req.body === "string" ? req.body : "");
    if (!body.has("client_id")) body.set("client_id", OKTA_CLIENT_ID);
    if (!body.has("client_secret") && OKTA_CLIENT_SECRET) body.set("client_secret", OKTA_CLIENT_SECRET);

    const tokenRes = await fetch(oktaTokenUrl(OKTA_ISSUER), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    });
    const data = await tokenRes.json() as Record<string, unknown>;
    res.status(tokenRes.status).json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token exchange failed";
    res.status(500).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Health check (unauthenticated — Railway uses this)
// ---------------------------------------------------------------------------

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// MCP tools — replace these with your own
// ---------------------------------------------------------------------------

function createMcpServerForUser(claims: OktaClaims) {
  const server = new McpServer({
    name: "stupid-example-mcp",
    version: "1.0.0",
  });

  server.tool(
    "greet",
    "Say hello. Very advanced AI technology.",
    { name: z.string().describe("Who to greet") },
    async ({ name }) => ({
      content: [{ type: "text" as const, text: `Hello, ${name}! You are authenticated as ${claims.sub}. Wow.` }],
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
      const rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      const total = rolls.reduce((a, b) => a + b, 0);
      return {
        content: [{ type: "text" as const, text: `Rolled ${count}d${sides}: [${rolls.join(", ")}] = ${total}` }],
      };
    }
  );

  server.tool(
    "magic_8ball",
    "Ask the magic 8-ball a question. Guaranteed accurate.",
    { question: z.string().describe("Your yes/no question") },
    async ({ question }) => {
      const answers = [
        "It is certain.", "Without a doubt.", "Don't count on it.",
        "My reply is no.", "Ask again later.", "Cannot predict now.",
        "Outlook not so good.", "Signs point to yes.",
        "Better not tell you now.", "Concentrate and ask again.",
      ];
      const answer = answers[Math.floor(Math.random() * answers.length)]!;
      return {
        content: [{ type: "text" as const, text: `Question: "${question}"\nAnswer: ${answer}` }],
      };
    }
  );

  server.tool("who_am_i", "Show your authenticated identity and Okta groups.", async () => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        sub: claims.sub,
        groups: claims.groups ?? [],
      }, null, 2),
    }],
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

// ---------------------------------------------------------------------------
// MCP endpoint — protected by Okta auth
// ---------------------------------------------------------------------------

app.post("/mcp", oktaAuth, async (req, res) => {
  const claims = req.oktaClaims!;
  const server = createMcpServerForUser(claims);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", oktaAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Use POST." });
});

app.delete("/mcp", oktaAuth, async (_req, res) => {
  res.status(405).json({ error: "Method not allowed. Stateless server, no sessions to delete." });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on http://0.0.0.0:${PORT}`);
  console.log(`  Health:    http://0.0.0.0:${PORT}/health`);
  console.log(`  MCP:       http://0.0.0.0:${PORT}/mcp`);
  console.log(`  OKTA_ISSUER: ${OKTA_ISSUER || "(not set!)"}`);
});
