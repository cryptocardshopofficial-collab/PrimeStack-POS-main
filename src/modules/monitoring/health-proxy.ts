import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, randomUUID } from "crypto";
import { config } from "../../config/index.js";

/**
 * Health & live-data proxy
 *
 * Every PrimeStack service in this deployment runs inside the single Fastify
 * API on one internal port. The per-service ports below are retained only as
 * stable identifiers for the dashboard's status tiles and route table — no
 * process listens on them. Health is therefore probed once against the API's
 * own /health rather than against retired microservice ports, which would
 * report every service OFFLINE.
 *
 * Reads that hit the closed-by-default API are signed with the console HMAC
 * key, exactly as the operator console proxy does.
 */

const API_BASE =
  process.env.PRIMESTACK_API_URL ||
  process.env.INTERNAL_API_URL ||
  `http://127.0.0.1:${process.env.API_PORT || 9006}`;

const SERVICES: Array<{ name: string; port: number; key: string; path: string }> = [
  { name: "Ledger Service",       port: 9010, key: "ledger",       path: "/ledger"             },
  { name: "IP Whitelist",         port: 9011, key: "ipWhitelist",  path: "/network/ip-whitelist" },
  { name: "Auth Service",         port: 9012, key: "auth",         path: "/network"            },
  { name: "Terminal Service",     port: 9013, key: "terminal",     path: "/terminals"          },
  { name: "Transfer Service",     port: 9014, key: "transfer",     path: "/admin/transfers"    },
  { name: "Risk Engine",          port: 9015, key: "risk",         path: "/fraud"              },
  { name: "Audit Service",        port: 9016, key: "audit",        path: "/admin/audit-logs"   },
  { name: "Settlement Engine",    port: 9017, key: "settlement",   path: "/settlement"         },
  { name: "Notification Service", port: 9018, key: "notification", path: "/notifications"      },
  { name: "Switch Core",          port: 9019, key: "switchCore",   path: "/transactions"       },
  { name: "Security Service",     port: 9020, key: "security",     path: "/network"            },
  { name: "Routing Engine",       port: 9021, key: "routing",      path: "/routes"             },
  { name: "ISO 8583 Gateway",     port: 9022, key: "iso8583",      path: "/iso8583"            },
  { name: "API Gateway",          port: 9024, key: "gateway",      path: "/api-gateway"        },
];

const HMAC_KEY_ID = process.env.CONSOLE_HMAC_KEY_ID || "";
const HMAC_SECRET = process.env.CONSOLE_HMAC_SECRET || "";
const HMAC_PREFIX = config.hmac.headerPrefix;

/** Sign an internal request the way the console proxy does. */
function signedHeaders(): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomUUID().replace(/-/g, "");
  const signature = createHmac("sha256", HMAC_SECRET)
    .update(`${HMAC_KEY_ID}${timestamp}${nonce}`)
    .digest("hex");
  return {
    [`${HMAC_PREFIX}-key-id`]: HMAC_KEY_ID,
    [`${HMAC_PREFIX}-timestamp`]: timestamp,
    [`${HMAC_PREFIX}-nonce`]: nonce,
    [`${HMAC_PREFIX}-signature`]: signature,
  };
}

async function checkApi(): Promise<{ online: boolean; responseMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${API_BASE}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return { online: res.ok, responseMs: Date.now() - start };
  } catch {
    return { online: false, responseMs: Date.now() - start };
  }
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: signedHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { success?: boolean; data?: unknown };
  return data.data ?? data;
}

export function registerHealthProxy(app: FastifyInstance): void {
  // ── GET /admin/health-all ─────────────────────────────────
  // Status of every PrimeStack service. Called by the dashboard every 5s.
  app.get("/admin/health-all", {
    config: { ipWhitelist: false },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const { online, responseMs } = await checkApi();

    const results = SERVICES.map((svc) => ({
      name: svc.name,
      port: svc.port,
      key: svc.key,
      status: online ? "ONLINE" : "OFFLINE",
      responseMs,
    }));

    const onlineCount = results.filter((r) => r.status === "ONLINE").length;

    reply.header("Cache-Control", "no-store");
    return reply.send({
      success: true,
      data: {
        services: results,
        summary: {
          total: results.length,
          online: onlineCount,
          offline: results.length - onlineCount,
          checkedAt: new Date().toISOString(),
        },
      },
    });
  });

  // ── GET /admin/live-data ──────────────────────────────────
  // Live figures for the dashboard, read from the single API.
  app.get("/admin/live-data", {
    config: { ipWhitelist: false },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const [risk, settlement, terminals, routing, iso8583] = await Promise.all([
      fetchJson("/fraud/risk-scores").catch(() => null),
      fetchJson("/settlement/batches").catch(() => null),
      fetchJson("/terminals").catch(() => null),
      fetchJson("/routes").catch(() => null),
      fetchJson("/iso8583/hosts").catch(() => null),
    ]);

    reply.header("Cache-Control", "no-store");
    return reply.send({
      success: true,
      data: {
        risk,
        settlement,
        terminals,
        routing,
        iso8583,
        fetchedAt: new Date().toISOString(),
      },
    });
  });

  // ── GET /admin/service-data/:service ─────────────────────
  // Proxy a service read through the API.
  // Example: /admin/service-data/risk/blacklist → API /fraud/blacklist
  app.get("/admin/service-data/*", {
    config: { ipWhitelist: false },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const urlParts = request.url.replace("/admin/service-data/", "");
    const [serviceKey, ...pathParts] = urlParts.split("/");
    const svc = SERVICES.find(
      (s) => s.key === serviceKey || s.port.toString() === serviceKey,
    );

    if (!svc) {
      return reply.status(404).send({ success: false, error: "Unknown service" });
    }

    const targetPath =
      pathParts.length > 0 ? `${svc.path}/${pathParts.join("/")}` : svc.path;
    const data = await fetchJson(targetPath).catch((err) => ({
      error: err instanceof Error ? err.message : "Service unavailable",
    }));

    reply.header("Cache-Control", "no-store");
    return reply.send({
      success: true,
      data,
      service: svc.name,
      port: svc.port,
    });
  });
}
