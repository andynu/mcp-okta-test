import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Request, Response, NextFunction } from "express";

export interface OktaClaims extends JWTPayload {
  sub: string;
  groups?: string[];
}

// Augment Express Request to carry verified claims
declare global {
  namespace Express {
    interface Request {
      oktaClaims?: OktaClaims;
    }
  }
}

const OKTA_ISSUER = process.env["OKTA_ISSUER"]; // e.g. https://yourorg.okta.com/oauth2/default
const OKTA_AUDIENCE = process.env["OKTA_AUDIENCE"]; // Client ID for Org auth server, api://default for Custom
const DEV_BYPASS_AUTH = process.env["DEV_BYPASS_AUTH"] === "true";

if (DEV_BYPASS_AUTH) {
  console.warn(
    "WARNING: DEV_BYPASS_AUTH=true — auth is bypassed! " +
      "All requests get fake claims with mcp-users + mcp-admins groups."
  );
} else if (!OKTA_ISSUER) {
  console.warn(
    "WARNING: OKTA_ISSUER not set. Auth will reject all requests. " +
      "Set OKTA_ISSUER to your Okta authorization server issuer URL."
  );
}

// Org auth server uses /oauth2/v1/keys, custom auth server uses {issuer}/v1/keys
function jwksUrl(issuer: string): URL {
  if (issuer.includes("/oauth2/")) {
    // Custom authorization server: https://org.okta.com/oauth2/ausXXX
    return new URL(`${issuer}/v1/keys`);
  }
  // Org authorization server: https://org.okta.com
  return new URL(`${issuer}/oauth2/v1/keys`);
}

const JWKS = OKTA_ISSUER
  ? createRemoteJWKSet(jwksUrl(OKTA_ISSUER))
  : null;

/**
 * Express middleware that validates Okta Bearer tokens and attaches
 * decoded claims (including groups) to req.oktaClaims.
 */
export async function oktaAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Dev bypass: skip auth entirely, inject fake claims
  if (DEV_BYPASS_AUTH) {
    req.oktaClaims = {
      sub: "dev-user@example.com",
      groups: ["mcp-users", "mcp-admins"],
    };
    next();
    return;
  }

  const resourceMetadataUrl = `${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource`;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`)
      .json({ error: "Missing Bearer token" });
    return;
  }

  if (!JWKS || !OKTA_ISSUER) {
    res.status(500).json({ error: "OKTA_ISSUER not configured" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const verifyOptions: { issuer: string; audience?: string } = {
      issuer: OKTA_ISSUER,
    };
    if (OKTA_AUDIENCE) {
      verifyOptions.audience = OKTA_AUDIENCE;
    }
    const { payload } = await jwtVerify(token, JWKS, verifyOptions);
    req.oktaClaims = payload as OktaClaims;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token verification failed";
    res
      .status(401)
      .set("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token"`)
      .json({ error: message });
  }
}

/**
 * Check if the authenticated user belongs to a specific Okta group.
 */
export function hasGroup(req: Request, group: string): boolean {
  return req.oktaClaims?.groups?.includes(group) ?? false;
}
