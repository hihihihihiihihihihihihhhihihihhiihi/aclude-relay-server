/**
 * Auth module — validates session tokens on WebSocket upgrade.
 *
 * For now, uses a shared secret (RELAY_AUTH_TOKEN env var).
 * In production, this should validate JWTs from the Aclude platform.
 */

import { IncomingMessage } from "http";

const AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;

export function validateAuth(req: IncomingMessage): boolean {
  // If no auth token is configured, allow all connections (dev mode)
  if (!AUTH_TOKEN) {
    console.warn("[auth] No RELAY_AUTH_TOKEN set — allowing all connections");
    return true;
  }

  // Check query params
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken === AUTH_TOKEN) return true;

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    if (bearer === AUTH_TOKEN) return true;
  }

  return false;
}
