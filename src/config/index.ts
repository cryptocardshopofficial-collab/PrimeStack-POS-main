import dotenv from "dotenv";

dotenv.config();

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) throw new Error(`Invalid integer for ${key}: ${raw}`);
  return parsed;
}

function list(key: string, fallback: string[]): string[] {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function productionRequired(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable in production: ${key}`);
  return value;
}

function productionSecret(key: string): string {
  const value = productionRequired(key);
  const weakValues = new Set([
    "dev-secret-change-in-production",
    "change-me-in-production-use-a-256-bit-key",
    "dev-secret-change-in-production-use-a-256-bit-key-please",
  ]);
  if (value.length < 32 || weakValues.has(value.toLowerCase()) || weakValues.has(value)) {
    throw new Error(`Invalid weak value for ${key} in production`);
  }
  return value;
}

export const config = {
  app: {
    name: required("APP_NAME", "primestack-global-server-network"),
    env: required("NODE_ENV", "development"),
    port: int("PORT", 9006),
    host: required("HOST", "0.0.0.0"),
    logLevel: required("LOG_LEVEL", "info"),
    trustedProxies: required("TRUSTED_PROXIES", "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  },

  database: {
    url: required("DATABASE_URL", "postgresql://primestack:primestack@localhost:5432/primestack?schema=public"),
  },

  redis: {
    host: required("REDIS_HOST", "localhost"),
    port: int("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: int("REDIS_DB", 0),
  },

  jwt: {
    secret: process.env.NODE_ENV === "production"
      ? productionSecret("JWT_SECRET")
      : required("JWT_SECRET", "dev-secret-change-in-production"),
    expiresIn: required("JWT_EXPIRES_IN", "24h"),
  },

  agentKyc: {
    pinPepper: process.env.AGENT_PIN_PEPPER?.trim() ||
      (process.env.NODE_ENV === "production" ? undefined : "dev-agent-pin-pepper-change-in-production"),
    encryptionKey: process.env.AGENT_KYC_ENCRYPTION_KEY?.trim() ||
      (process.env.NODE_ENV === "production" ? undefined : "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
  },

  hmac: {
    algorithm: required("HMAC_ALGORITHM", "sha256").trim().toLowerCase(),
    headerPrefix: required("HMAC_HEADER_PREFIX", "x-primestack").trim().toLowerCase(),
  },

  inboundWebhook: {
    /**
     * Shared secret for the inbound real-funds webhook. Left empty by default:
     * an unconfigured secret makes the webhook reject every request rather than
     * accept unsigned credits.
     */
    secret: process.env.INBOUND_WEBHOOK_SECRET?.trim() ?? "",
    maxTimestampDriftMs: int("INBOUND_WEBHOOK_MAX_TIMESTAMP_DRIFT_MS", 300000),
    /**
     * Ledger account that is debited when external funds are credited to a
     * terminal. It must be an ASSET account, because ASSET debits are the only
     * ones the ledger engine allows to go unbacked.
     */
    fundingAccountPrefix: required("INBOUND_FUNDING_ACCOUNT_PREFIX", "SYSTEM-FUNDING"),
  },

  /**
   * Outbound notice sent to a whitelisted sender's callback URL when the
   * operator pings it. Reuses the inbound webhook secret unless a dedicated
   * secret is supplied, so a single configured secret signs both directions.
   */
  t2tNotify: {
    secret:
      process.env.T2T_NOTIFY_SECRET?.trim() ||
      process.env.INBOUND_WEBHOOK_SECRET?.trim() ||
      "",
    timeoutMs: int("T2T_NOTIFY_TIMEOUT_MS", 5000),
  },

  rateLimit: {
    max: int("RATE_LIMIT_MAX", 100),
    window: int("RATE_LIMIT_WINDOW", 60),
  },

  i18n: {
    defaultLanguage: required("DEFAULT_LANGUAGE", "en"),
    supportedLanguages: list("SUPPORTED_LANGUAGES", ["en", "fr", "es", "ar", "pt"]),
  },

  s2s: {
    /**
     * 64-hex-char (32-byte) AES-256-GCM key for encrypting connection API secrets at rest.
     * Must be set via S2S_SECRET_KEY environment variable in production.
     */
    secretKey: process.env.NODE_ENV === "production"
      ? productionSecret("S2S_SECRET_KEY")
      : required("S2S_SECRET_KEY", "0000000000000000000000000000000000000000000000000000000000000000"),
  },
  cors: {
    origins: list("CORS_ORIGINS", process.env.NODE_ENV === "production" ? [] : ["http://localhost:9004", "http://localhost:9005", "http://localhost:9006"]),
  },
  wise: {
    enabled: required("WISE_VIRTUAL_ACCOUNTS_ENABLED", "false").toLowerCase() === "true",
    provisioningEnabled: required("WISE_VIRTUAL_ACCOUNT_PROVISIONING_ENABLED", "false").toLowerCase() === "true",
    apiKey: process.env.WISE_API_KEY?.trim() ?? "",
    profileId: process.env.WISE_PROFILE_ID?.trim() ?? "",
    environment: required("WISE_ENV", "sandbox").toLowerCase() === "live" ? "live" as const : "sandbox" as const,
    liveUrl: required("WISE_LIVE_URL", "https://api.transferwise.com"),
    sandboxUrl: required("WISE_SANDBOX_URL", "https://api.sandbox.transferwise.tech"),
    webhookPublicKey: process.env.WISE_WEBHOOK_PUBLIC_KEY?.trim().replace(/\\n/g, "\n") ?? "",
    defaultCreditAccount: required("WISE_DEFAULT_CREDIT_ACCOUNT", "PLATFORM:RESERVE:USD"),
  },
  banks: {
    sg: {
      accountHolder: process.env.BANK_SG_ACCOUNT_HOLDER ?? "",
      bankName:      process.env.BANK_SG_BANK_NAME      ?? "",
      accountNumber: process.env.BANK_SG_ACCOUNT_NUMBER  ?? "",
      swiftBic:      process.env.BANK_SG_SWIFT_BIC       ?? "",
      currency:      process.env.BANK_SG_CURRENCY         ?? "SGD",
      country:       process.env.BANK_SG_COUNTRY          ?? "SG",
    },
    in2: {
      accountHolder: process.env.BANK_IN2_ACCOUNT_HOLDER ?? "",
      bankName:      process.env.BANK_IN2_BANK_NAME      ?? "",
      accountNumber: process.env.BANK_IN2_ACCOUNT_NUMBER  ?? "",
      merchantId:    process.env.BANK_IN2_MERCHANT_ID     ?? "",
      vpa:           process.env.BANK_IN2_VPA             ?? "",
      mobile:        process.env.BANK_IN2_MOBILE           ?? "",
      swiftBic:      process.env.BANK_IN2_SWIFT_BIC        ?? "ICICINBBCTS",
      currency:      process.env.BANK_IN2_CURRENCY         ?? "INR",
      country:       process.env.BANK_IN2_COUNTRY          ?? "IN",
      gateway:       process.env.BANK_IN2_GATEWAY          ?? "ICICI_EAZYPAY",
    },
  },
} as const;

export type AppConfig = typeof config;
