# mcp-okta-test

A dumb example MCP server that authenticates via Okta and gates tool access by Okta group membership. Deployed on Railway.

Uses the [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) MCP transport in stateless mode -- each request is independently authenticated and gets its own server instance.

## MCP Tools

Tools are registered per-request based on which Okta groups the authenticated user belongs to.

### `mcp-users` group (also available to `mcp-admins`)

| Tool | Description | Parameters |
|------|-------------|------------|
| `greet` | Says hello. Tells you your authenticated identity. | `name` (string) |
| `roll_dice` | Rolls dice. | `sides` (number, 2-100, default 6), `count` (number, 1-20, default 1) |
| `magic_8ball` | Answers yes/no questions with guaranteed accuracy. | `question` (string) |

### `mcp-admins` group only

| Tool | Description | Parameters |
|------|-------------|------------|
| `server_info` | Returns node version, uptime, memory usage, your groups, Railway env. | (none) |
| `echo` | Echoes back whatever you send. | `message` (string) |

### No matching groups

If you authenticate successfully but aren't in `mcp-users` or `mcp-admins`, you get a single `access_denied` tool that tells you what groups you're missing.

## Railway Deployment

### 1. Connect the repo

- Go to [railway.com](https://railway.com), create a new project, and deploy from this GitHub repo.
- Railway auto-detects Node.js via `package.json` and uses the config in `railway.toml`.

### 2. Set environment variables

In the Railway service's **Variables** tab, add:

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `OKTA_ISSUER` | Yes | `https://yourorg.okta.com/oauth2/default` | Your Okta Custom Authorization Server issuer URL |
| `OKTA_AUDIENCE` | No | `api://default` | Expected `aud` claim (defaults to `api://default`) |
| `DEV_BYPASS_AUTH` | No | `true` | Bypasses auth entirely -- **never use in production** |

### 3. Generate a public domain

Settings > Networking > Public Networking > Generate Domain. You'll get a `*.railway.app` URL with automatic HTTPS.

### 4. What Railway does

Defined in `railway.toml`:

- **Build**: `npm run build` (runs `tsc` to compile TypeScript)
- **Start**: `npm start` (runs `node dist/server.js`)
- **Health check**: `GET /health` -- Railway won't route traffic until this returns 200
- **Restart policy**: restarts on failure

### Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/` | No | JSON info page (expected env vars, group names) |
| `/health` | No | Health check for Railway |
| `/mcp` | Yes | MCP Streamable HTTP endpoint (POST) |

## Okta Setup

You need a **Custom Authorization Server** (not the Org authorization server) because custom claims (like `groups`) can only be added to custom auth servers.

### 1. Create an OIDC application

In the Okta Admin Console:

1. **Applications > Applications > Create App Integration**
2. Select **OIDC - OpenID Connect**
3. Select **Web Application**
4. Set a sign-in redirect URI (not used by this server directly, but required by Okta)
5. Assign users/groups who should be able to authenticate
6. Note the **Client ID** and **Client Secret**

### 2. Add a `groups` claim to your authorization server

1. **Security > API > Authorization Servers**
2. Select your authorization server (e.g., `default`)
3. Go to the **Claims** tab
4. Click **Add Claim**:
   - **Name**: `groups`
   - **Include in token type**: **Access Token**
   - **Value type**: `Groups`
   - **Filter**: `Matches regex` with value `.*` (or a more specific pattern like `^mcp-`)
   - **Include in**: Any scope

### 3. Create the Okta groups

Create two groups in **Directory > Groups**:

- `mcp-users` -- basic tool access (greet, dice, 8-ball)
- `mcp-admins` -- admin tool access (server_info, echo) plus everything in mcp-users

Assign users to whichever group(s) they should have.

### 4. Get your issuer URL

Your issuer URL is on the authorization server's **Settings** tab. For the default custom auth server it's:

```
https://yourorg.okta.com/oauth2/default
```

This is what you set as `OKTA_ISSUER`.

### 5. Get a test token

Easiest way: **Security > API > Authorization Servers > default > Token Preview**. Select your app, a user, grant type, and scopes. Copy the generated access token.

Verify it contains groups:

```bash
# Decode the JWT payload (middle segment)
echo '<token>' | cut -d. -f2 | base64 -d 2>/dev/null | jq .
# Look for: "groups": ["mcp-users", "mcp-admins", ...]
```

## Local Development

```bash
# Without Okta (auth bypassed, all tools available)
DEV_BYPASS_AUTH=true npm run dev

# With Okta (need a valid token)
OKTA_ISSUER=https://yourorg.okta.com/oauth2/default npm run dev
```

### Wire into Claude Code

```bash
# Local dev with auth bypass
claude mcp add stupid-example --transport http http://localhost:3000/mcp

# Local dev with Okta
claude mcp add stupid-example \
  --transport http \
  --header "Authorization: Bearer <your-okta-token>" \
  http://localhost:3000/mcp

# Deployed on Railway
claude mcp add stupid-example \
  --transport http \
  --header "Authorization: Bearer <your-okta-token>" \
  https://your-app.railway.app/mcp
```

### Test with curl

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```
