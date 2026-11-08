import { createHmac, timingSafeEqual } from "crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/index.js";
import { prisma } from "../core/database.js";
import { HmacSignatureError, UnauthorizedError } from "../core/errors.js";
import { logger } from "../core/logger.js";

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
    apiKey?: {
      keyId: string;
      merchantId: string;
    };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000; // 5 minutes

function computeSignature(secret: string, data: string): string {
  return createHmac(config.hmac.algorithm, secret).update(data).digest("hex");
}

export async function hmacAuthPlugin(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    // Skip auth for health, docs, and admin login routes
    if (
      request.url.startsWith("/health") ||
      request.url.startsWith("/docs") ||
      request.url.startsWith("/admin/login")
    ) {
      return;
    }

    // Admin routes use JWT (handled by @fastify/jwt decorators)
    if (request.url.startsWith("/admin")) {
      return;
    }

    const prefix = config.hmac.headerPrefix;
    const keyId = request.headers[`${prefix}-key-id`] as string | undefined;
    const timestamp = request.headers[`${prefix}-timestamp`] as string | undefined;
    const nonce = request.headers[`${prefix}-nonce`] as string | undefined;
    const signature = request.headers[`${prefix}-signature`] as string | undefined;

    if (!keyId || !timestamp || !nonce || !signature) {
      throw new UnauthorizedError("Missing HMAC authentication headers");
    }
    if (nonce.length < 16 || nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(nonce)) {
      throw new HmacSignatureError("Invalid nonce");
    }

    // Validate timestamp freshness
    const ts = parseInt(timestamp, 10);
    const drift = Date.now() - ts;
    if (isNaN(ts) || drift > MAX_TIMESTAMP_DRIFT_MS || drift < -MAX_TIMESTAMP_DRIFT_MS) {
      throw new HmacSignatureError("Timestamp expired or invalid");
    }

    // Look up the HMAC key — try cache first, fall back to DB
    const hmacKey = await prisma.hmacKey.findFirst({
      where: { keyId, status: "ACTIVE" },
      include: { merchant: { select: { id: true, code: true, preferredLang: true } } },
    });

    if (!hmacKey) {
      throw new HmacSignatureError("Unknown key ID");
    }
    if (!hmacKey.merchant) {
      throw new HmacSignatureError("Key is not associated with a merchant");
    }

    // Compute expected signature
    const body = request.body ? JSON.stringify(request.body) : "";
    const data = `${keyId}${timestamp}${nonce}${body}`;
    const expected = computeSignature(hmacKey.secret, data);

    // Constant-time comparison to prevent timing attacks
    const sigBuffer = Buffer.from(signature, "hex");
    const expBuffer = Buffer.from(expected, "hex");

    if (sigBuffer.length !== expBuffer.length || !timingSafeEqual(sigBuffer, expBuffer)) {
      logger.warn({ keyId, ip: request.ip }, "HMAC signature mismatch");
      throw new HmacSignatureError("Signature does not match");
    }

    const expiresAt = new Date(ts + MAX_TIMESTAMP_DRIFT_MS);
    try {
      await prisma.hmacNonce.create({ data: { keyId, nonce, expiresAt } });
    } catch {
      throw new HmacSignatureError("Nonce has already been used");
    }

    // Attach merchant context
    request.merchant = {
      id: hmacKey.merchant.id,
      code: hmacKey.merchant.code,
      preferredLang: hmacKey.merchant.preferredLang,
    };
  });
}

/**
 * JWT Authentication decorator for admin routes.
 * Used with @fastify/jwt — verify the token and attach user.
 */
export async function jwtAuthHook(app: FastifyInstance): Promise<void> {
  app.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError();
    }
    const payload = request.user as { id?: string; role?: string } | undefined;
    if (!payload?.id) throw new UnauthorizedError();
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, email: true, role: true, preferredLang: true, isActive: true },
    });
    if (!user?.isActive) throw new UnauthorizedError("Administrator account is inactive");
    request.user = {
      ...payload,
      id: user.id,
      email: user.email,
      role: user.role,
      lang: user.preferredLang,
    } as never;
  });
}
