# MCP Server with Okta Auth on Railway

A template for adding Okta authentication to a remote MCP server deployed on Railway. The example tools are intentionally stupid -- the interesting part is the auth plumbing.

## How it works

```
Claude Desktop/Code                    This Server                         Okta
       |                                    |                               |
       |--- GET /.well-known/oauth-*  ----->|                               |
       |<-- {authorize, token URLs}  -------|                               |
       |                                    |                               |
       |--- GET /authorize?... ------------>|--- 302 redirect ------------->|
       |                                    |                               |
       |<-------------- Okta login page ------------------------------------|
       |--------------- user logs in --------------------------------------->|
       |<-------------- redirect to Claude with code ----------------------|
       |                                    |                               |
       |--- POST /token (code) ----------->|--- POST /oauth2/v1/token ---->|
       |<-- {access_token} ----------------|<-- {access_token} ------------|
       |                                    |                               |
       |--- POST /mcp (Bearer token) ----->|                               |
       |    oktaAuth validates JWT via JWKS |--- GET /oauth2/v1/keys ------>|
       |<-- MCP tool results --------------|                               |
```

The server proxies `/authorize` and `/token` to Okta because Okta's Org authorization server doesn't expose public discovery endpoints. Claude discovers these via standard OAuth metadata (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`).

If you have a Custom Authorization Server with public discovery, you could point `authorization_servers` directly at Okta and skip the proxy.

## Example Tools

All tools are available to any authenticated user.

| Tool | Description | Parameters |
|------|-------------|------------|
| `greet` | Says hello, shows your identity | `name` (string) |
| `roll_dice` | Rolls dice | `sides` (2-100, default 6), `count` (1-20, default 1) |
| `magic_8ball` | Answers yes/no questions | `question` (string) |
| `who_am_i` | Shows your Okta sub and groups | (none) |
| `echo` | Echoes a message back | `message` (string) |

## Setup

### 1. Okta

In the Okta Admin Console:

1. **Applications > Create App Integration > OIDC > Web Application**
2. Add these **Sign-in redirect URIs**:
   - `https://claude.ai/api/mcp/auth_callback` (Claude.ai / Claude Desktop)
   - `https://claude.com/api/mcp/auth_callback`
   - `http://localhost:8080/callback` (Claude Code CLI with `--callback-port 8080`)
3. Assign users/groups who should have access
4. Note the **Client ID** and **Client Secret**

**Groups claim** (optional -- needed if you want `who_am_i` to show groups):
- **With Custom Authorization Server**: Security > API > Authorization Servers > Claims tab > Add Claim (name: `groups`, type: Groups, filter: regex `.*`)
- **With Org Authorization Server**: Applications > your app > Sign On tab > OpenID Connect ID Token > Groups claim filter: `groups` matches regex `.*`

### 2. Railway

1. Deploy from GitHub: connect this repo on [railway.com](https://railway.com)
2. Generate a domain: Settings > Networking > Public Networking > Generate Domain
3. Set environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `OKTA_ISSUER` | Yes | Okta issuer URL (e.g., `https://yourorg.okta.com`) |
| `OKTA_AUDIENCE` | Yes | Expected `aud` claim (usually same as issuer for Org auth server) |
| `OKTA_CLIENT_ID` | Yes | From Okta app |
| `OKTA_CLIENT_SECRET` | Yes | From Okta app |
| `DEV_BYPASS_AUTH` | No | Set `true` to skip auth (local dev only) |

### 3. Connect from Claude

**Claude Desktop / claude.ai**: Add as a connector with:
- URL: `https://your-app.railway.app/mcp`
- Client ID and Client Secret from Okta

**Claude Code CLI**:
```bash
claude mcp add my-server \
  --transport http \
  --callback-port 8080 \
  https://your-app.railway.app/mcp
# Claude Code will prompt for client ID and secret
```

## Local Development

```bash
# Auth bypassed -- all tools available, no Okta needed
DEV_BYPASS_AUTH=true npm run dev

# With Okta auth
cp .env.example .env  # fill in your values
npm run dev
```

## Adapting for Your Own Server

The auth plumbing is in two files:

- **`src/okta-auth.ts`** -- Express middleware that validates Okta JWTs. Drop this into your project and apply it to your MCP route.
- **`src/server.ts`** -- The OAuth proxy routes (`/.well-known/*`, `/authorize`, `/token`) and the MCP endpoint. Copy the OAuth proxy section into your server, then replace the example tools with your own.

The key pieces to copy:
1. `trust proxy` setting (required behind Railway/any reverse proxy)
2. The four OAuth routes (two `.well-known`, `/authorize`, `/token`)
3. The `oktaAuth` middleware on your MCP endpoint
4. Environment variables: `OKTA_ISSUER`, `OKTA_AUDIENCE`, `OKTA_CLIENT_ID`, `OKTA_CLIENT_SECRET`
