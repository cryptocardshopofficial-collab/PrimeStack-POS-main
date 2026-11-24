import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { redis } from "../core/redis.js";
import { ForbiddenError } from "../core/errors.js";
import { config } from "../config/index.js";
import { logger } from "../core/logger.js";
import { recordSecurityEvent } from "../modules/monitoring/security-events.js";

/**
 * Security Shield Plugin
 *
 * Blocks banned IPs, malicious user agents (scanners, proxies) and suspicious
 * requests, and auto-bans IPs that repeatedly fail authentication.
 *
 * Redis only ever backs this shield's ban lists. A shield must never be the
 * thing that takes the API down, so every Redis call degrades gracefully: if the
 * store is unreachable the check is skipped rather than throwing a 500.
 */

const AUTH_FAIL_LIMIT = 5;
const AUTH_FAIL_WINDOW = 600; // seconds
const AUTH_BAN_DURATION = 3600; // seconds

const BLOCKED_UA = [
  "sqlmap", "nikto", "nmap", "masscan", "dirb", "gobuster", "wfuzz",
  "hydra", "metasploit", "burp", "zap", "w3af", "skipfish", "arachni",
  "wpscan", "joomscan", "droopescan", "whatweb", "httprobe",
  "scout", "fingerprint", "securitytrails", "shodan", "censys",
  "zoomeye", "quake", "fofa", "leakix", "fullhunt",
];

const MALICIOUS_URL = [
  /\.\.[\\/]/, /%2e%2e/, /%252e%252e/, /\.\.%2f/,
  /<script/, /javascript:/, /onerror=/, /eval\(/,
  /phpinfo/, /wp-admin/, /wp-login/, /phpmyadmin/,
  /\.env/, /\.git/, /\.ssh/, /config\.php/,
  /etc\/passwd/, /etc\/shadow/, /proc\/self/,
  /file:\/\//, /dict:\/\//, /gopher:\/\//,
];

const SQL_INJECTION = [
  /union\s+select/, /drop\s+table/, /insert\s+into/,
  /delete\s+from/, /or\s+1\s*=\s*1/, /;\s*drop\s/,
  /--\s*$/, /sleep\s*\(/, /benchmark\s*\(/,
  /information_schema/,
];

// ── Redis helpers — never throw ─────────────────────────────────────────────
async function safeGet(key: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
}

async function safeSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, value, "EX", ttlSeconds);
  } catch (err) {
    logger.debug({ err }, "security-shield: redis set skipped");
  }
}

async function safeDel(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch {
    /* ignore */
  }
}

async function safeIncrWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, ttlSeconds);
    return count;
  } catch {
    return null;
  }
}

// ── Public helpers used by the auth flow ────────────────────────────────────

/** Throttle intelligence-event writes so a flood of attacks cannot hammer the DB. */
const lastRecordedAt = new Map<string, number>();
const RECORD_THROTTLE_MS = 60_000;

function eventTypeForReason(reason: string): string {
  if (reason.startsWith("blocked-ua")) return "BLOCKED_USER_AGENT";
  if (reason.startsWith("malicious-url")) return "PATH_TRAVERSAL_ATTEMPT";
  if (reason.startsWith("sql-injection")) return "SQL_INJECTION_ATTEMPT";
  if (reason === "auth-failures") return "IP_AUTO_BANNED";
  return "IP_BANNED";
}

function reportBan(ip: string, reason: string): void {
  const key = reason + "|" + ip;
  const now = Date.now();
  const last = lastRecordedAt.get(key) ?? 0;
  if (now - last < RECORD_THROTTLE_MS) return;
  lastRecordedAt.set(key, now);
  if (lastRecordedAt.size > 5000) lastRecordedAt.clear();

  void recordSecurityEvent({
    eventType: eventTypeForReason(reason),
    summary: `Blocked and banned source ${ip} (reason: ${reason})`,
    ip,
    severity: "WARNING",
    confidence: 90,
  }).catch(() => {});
}

export async function recordAuthFailure(ip: string, reason: string): Promise<void> {
  const count = await safeIncrWithTtl("sec:authfail:" + ip, AUTH_FAIL_WINDOW);
  if (count !== null && count >= AUTH_FAIL_LIMIT) {
    await safeSet("sec:ban:" + ip, reason, AUTH_BAN_DURATION);
    await safeDel("sec:authfail:" + ip);
    logger.warn({ ip, reason }, "IP auto-banned for auth failures");
    reportBan(ip, reason);
  }
}

export async function clearAuthFailures(ip: string): Promise<void> {
  await safeDel("sec:authfail:" + ip);
}

export async function banIp(ip: string, reason: string, duration = 3600): Promise<void> {
  await safeSet("sec:ban:" + ip, reason, duration);
  logger.warn({ ip, reason }, "IP banned");
  reportBan(ip, reason);
}

/** Lift a ban (used by the intelligence "unblock" action). */
export async function unbanIp(ip: string): Promise<void> {
  await safeDel("sec:ban:" + ip);
  logger.warn({ ip }, "IP ban lifted");
}

/** List currently banned IPs with their reasons. */
export async function listBans(): Promise<Array<{ ip: string; reason: string | null }>> {
  try {
    const keys = await redis.keys("sec:ban:*");
    if (keys.length === 0) return [];
    const reasons = await redis.mget(...keys);
    return keys.map((key, index) => ({
      ip: key.replace("sec:ban:", ""),
      reason: reasons[index] ?? null,
    }));
  } catch {
    return [];
  }
}

export const securityShieldPlugin = fp(
  async (app: FastifyInstance) => {
    app.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
      const ip = request.ip || "unknown";

      // 1. Ban list
      const banned = await safeGet("sec:ban:" + ip);
      if (banned) {
        throw new ForbiddenError("Access denied");
      }

      // 2. User-agent screen. An absent UA is only suspicious on state-changing
      //    requests — blocking every UA-less GET would break internal health calls.
      const ua = ((request.headers["user-agent"] || "") as string).toLowerCase();
      if (ua) {
        for (const blocked of BLOCKED_UA) {
          if (ua.includes(blocked)) {
            await banIp(ip, "blocked-ua:" + blocked, 7200);
            throw new ForbiddenError("Access denied");
          }
        }
      } else if (request.method !== "GET" && request.method !== "HEAD") {
        throw new ForbiddenError("Access denied");
      }

      // 3. Path traversal / known exploit paths
      const url = request.url.toLowerCase();
      for (const pattern of MALICIOUS_URL) {
        if (pattern.test(url)) {
          await banIp(ip, "malicious-url", 7200);
          throw new ForbiddenError("Access denied");
        }
      }

      // 4. SQL injection in the query string
      const qs = (request.url.split("?")[1] || "").toLowerCase();
      if (qs) {
        for (const pattern of SQL_INJECTION) {
          if (pattern.test(qs)) {
            await banIp(ip, "sql-injection", 7200);
            throw new ForbiddenError("Access denied");
          }
        }
      }
    });

    // The body is only parsed after onRequest, so payload screening runs here.
    app.addHook("preHandler", async (request: FastifyRequest, _reply: FastifyReply) => {
      if (!request.body || typeof request.body !== "object") return;
      const bodyStr = JSON.stringify(request.body).toLowerCase();
      if (bodyStr.length > 16_384) return; // do not scan unbounded payloads
      for (const pattern of SQL_INJECTION) {
        if (pattern.test(bodyStr)) {
          await banIp(request.ip || "unknown", "sql-injection-body", 7200);
          throw new ForbiddenError("Access denied");
        }
      }
    });

    // Strip identifying headers on every response.
    app.addHook("onSend", async (_request: FastifyRequest, reply: FastifyReply, payload) => {
      reply.removeHeader("X-Powered-By");
      reply.removeHeader("Server");
      if (config.app.env === "production") {
        reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
      }
      reply.header("X-Frame-Options", "DENY");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-XSS-Protection", "1; mode=block");
      reply.header("Cross-Origin-Resource-Policy", "same-origin");
      return payload;
    });

    logger.info("Security Shield active");
  },
  { name: "security-shield" },
);

export default securityShieldPlugin;
