import { createHmac, timingSafeEqual } from "crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/index.js";
import { prisma } from "../core/database.js";
import { HmacSignatureError, UnauthorizedError } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { decryptSecret } from "../modules/s2s-engine/s2s-crypto.js";

/**
 * HMAC Authentication Plugin
 *
 * Verifies incoming API requests signed with HMAC-SHA256.
 *
 * Headers required:
 *   x-primestack-key-id:    The public key identifier
 *   x-primestack-timestamp: Unix timestamp (rejects if > 5 min old)
 *   x-primestack-nonce:     Unique request nonce
 *   x-primestack-signature: HMAC-SHA256(keyId + timestamp + nonce + body)
 *
 * On success, attaches the merchant to the request for downstream use.
 */

declare module "fastify" {
  interface FastifyRequest {
    merchant?: {
      id: string;
      code: string;
      preferredLang: string;
    };
    agent?: {
      id: string;
      code: string;
      name: string;
    };
    apiKey?: {
      keyId: string;
      merchantId: string;
    };
  }
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

function computeSignature(secret: string, data: string): string {
  return createHmac(config.hmac.algorithm, secret).update(data).digest("hex");
}

export async function hmacAuthPlugin(app: FastifyInstance): Promise<void> {
  app.addHook(
    "preValidation",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const path = request.url.split("?")[0];
      // Skip auth for health, docs, and admin login routes
      if (
        request.url.startsWith("/health") ||
        request.url.startsWith("/docs") ||
        request.url.startsWith("/admin/login") ||
        path === "/merchant-portal" ||
        path.startsWith("/merchant-portal/") ||
        path === "/network" ||
        path.startsWith("/network/") ||
        path === "/ledger" ||
        path.startsWith("/ledger/") ||
        path === "/public/terminal-registration" ||
        path === "/public/agent-portal/login" ||
        path.startsWith("/public/agent-portal/") ||
        path === "/t2t/whitelist" ||
        path.startsWith("/t2t/whitelist/") ||
        // Administrator-only inbound credit uses the JWT session, not merchant HMAC.
        path === "/t2t/inbound" ||
        // The inbound funds webhook carries its own shared-secret signature.
        path === "/webhooks/inbound" ||
        // Public dead-man's-switch ping for an external uptime monitor.
        path === "/alarm/ping" ||
        // Wise signs its webhook body with RSA (X-Signature-SHA256), verified
        // inside the route.
        path.startsWith("/wise/webhook") ||
        // The SUPE settlement ingest verifies its own raw-byte HMAC
        // (X-PrimeStack-Signature) plus a SHA256 checksum, matching the
        // partner manifest letter ΓÇö it does not use the 4-header scheme.
        path === "/supe/ingest/xml"
      ) {
        return;
      }

      // Admin routes use JWT (handled by @fastify/jwt decorators)
      if (request.url.startsWith("/admin")) {
        return;
      }

      const prefix = config.hmac.headerPrefix.toLowerCase();
      const normalizedHeaders = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const isAgentRoute = path === "/agent" || path.startsWith("/agent/");
      const keyId = normalizedHeaders[`${prefix}-key-id`];
      const timestamp = normalizedHeaders[`${prefix}-timestamp`];
      const nonce = normalizedHeaders[`${prefix}-nonce`];
      const signature = normalizedHeaders[`${prefix}-signature`];

      if (
        typeof keyId !== "string" ||
        typeof timestamp !== "string" ||
        typeof nonce !== "string" ||
        typeof signature !== "string"
      ) {
        throw new UnauthorizedError("Missing HMAC authentication headers");
      }
      if (!/^\d{13}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) {
        throw new HmacSignatureError("Invalid timestamp or signature format");
      }
      if (
        nonce.length < 16 ||
        nonce.length > 128 ||
        !/^[A-Za-z0-9_-]+$/.test(nonce)
      ) {
        throw new HmacSignatureError("Invalid nonce");
      }

      // Validate timestamp freshness
      const ts = Number(timestamp);
      const drift = Date.now() - ts;
      if (
        !Number.isSafeInteger(ts) ||
        drift > MAX_TIMESTAMP_DRIFT_MS ||
        drift < -MAX_TIMESTAMP_DRIFT_MS
      ) {
        throw new HmacSignatureError("Timestamp expired or invalid");
      }

      // Look up the HMAC key ΓÇö try cache first, fall back to DB
      const hmacKey = await prisma.hmacKey.findFirst({
        where: { keyId, status: "ACTIVE" },
        include: {
          merchant: { select: { id: true, code: true, preferredLang: true } },
          agent: { select: { id: true, code: true, name: true, status: true } },
        },
      });

      if (!hmacKey) {
        throw new HmacSignatureError("Unknown key ID");
      }
      if (hmacKey.expiresAt && hmacKey.expiresAt <= new Date()) {
        throw new HmacSignatureError("HMAC key has expired");
      }

      let secret = hmacKey.secret;
      if (isAgentRoute) {
        if (hmacKey.merchant || !hmacKey.agent || hmacKey.agent.status !== "APPROVED") {
          throw new HmacSignatureError("An active approved-agent key is required");
        }
        secret = decryptSecret(hmacKey.secret);
      } else {
        if (hmacKey.agent || !hmacKey.merchant) {
          throw new HmacSignatureError("This key is not authorized for this route");
        }
      }

      // Compute expected signature
      const body = request.body ? JSON.stringify(request.body) : "";
      const data = `${keyId}${timestamp}${nonce}${body}`;
      const expected = computeSignature(secret, data);

      // Constant-time comparison to prevent timing attacks
      const sigBuffer = Buffer.from(signature, "hex");
      const expBuffer = Buffer.from(expected, "hex");

      if (
        sigBuffer.length !== expBuffer.length ||
        !timingSafeEqual(sigBuffer, expBuffer)
      ) {
        logger.warn({ keyId, ip: request.ip }, "HMAC signature mismatch");
        throw new HmacSignatureError("Signature does not match");
      }

      const expiresAt = new Date(ts + MAX_TIMESTAMP_DRIFT_MS);
      if (request.url.split("?")[0] !== "/t2t/transfer") {
        try {
          await prisma.hmacNonce.create({ data: { keyId, nonce, expiresAt } });
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? error.code
              : undefined;
          if (code === "P2002") {
            throw new HmacSignatureError("Nonce has already been used");
          }
          throw error;
        }
      }

      // Attach merchant context
      if (hmacKey.merchant) {
        request.merchant = {
          id: hmacKey.merchant.id,
          code: hmacKey.merchant.code,
          preferredLang: hmacKey.merchant.preferredLang,
        };
      }
      if (isAgentRoute && hmacKey.agent) {
        request.agent = {
          id: hmacKey.agent.id,
          code: hmacKey.agent.code,
          name: hmacKey.agent.name,
        };
      }
    },
  );
}

/**
 * JWT Authentication decorator for admin routes.
 * Used with @fastify/jwt ΓÇö verify the token and attach user.
 */
export async function jwtAuthHook(app: FastifyInstance): Promise<void> {
  app.decorate(
    "authenticate",
    async (request: FastifyRequest, _reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch {
        throw new UnauthorizedError();
      }
      const payload = request.user as
        { id?: string; role?: string } | undefined;
      if (!payload?.id) throw new UnauthorizedError();
      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: {
          id: true,
          email: true,
          role: true,
          preferredLang: true,
          isActive: true,
          merchantId: true,
          mustChangePassword: true,
        },
      });
      if (!user?.isActive)
        throw new UnauthorizedError("Administrator account is inactive");
      request.user = {
        ...payload,
        id: user.id,
        email: user.email,
        role: user.role,
        lang: user.preferredLang,
        merchantId: user.merchantId,
        mustChangePassword: user.mustChangePassword,
      } as never;
    },
  );
}
