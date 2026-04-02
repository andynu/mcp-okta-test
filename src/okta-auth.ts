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
const OKTA_AUDIENCE = process.env["OKTA_AUDIENCE"] ?? "api://default";
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

const JWKS = OKTA_ISSUER
  ? createRemoteJWKSet(new URL(`${OKTA_ISSUER}/v1/keys`))
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

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Bearer token" });
    return;
  }

  if (!JWKS || !OKTA_ISSUER) {
    res.status(500).json({ error: "OKTA_ISSUER not configured" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: OKTA_ISSUER,
      audience: OKTA_AUDIENCE,
    });
    req.oktaClaims = payload as OktaClaims;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token verification failed";
    res.status(401).json({ error: message });
  }
}

/**
 * Check if the authenticated user belongs to a specific Okta group.
 */
export function hasGroup(req: Request, group: string): boolean {
  return req.oktaClaims?.groups?.includes(group) ?? false;
}
