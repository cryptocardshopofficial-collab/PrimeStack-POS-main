import { createPublicKey, verify } from "crypto";
import { config } from "../../config/index.js";
import { logger } from "../../core/logger.js";

/**
 * Normalized Wise receiving-account details stored on a VirtualAccount row.
 * Only the fields an operator needs to receive funds are kept.
 */
export interface WiseAccountDetails {
  externalId: string | null;
  details: {
    type?: string;
    iban?: string;
    accountNumber?: string;
    routingNumber?: string;
    sortCode?: string;
    bankName?: string;
    swiftCode?: string;
    accountHolder?: string;
    accountType?: string;
    country?: string;
  };
}

/** True when Wise provisioning is enabled and the required credentials are present. */
export function isWiseProvisioningEnabled(): boolean {
  return Boolean(
    config.wise.provisioningEnabled && config.wise.apiKey && config.wise.profileId,
  );
}

function wiseBaseUrl(): string {
  return config.wise.environment === "live"
    ? config.wise.liveUrl
    : config.wise.sandboxUrl;
}

export async function wiseRequest<T = unknown>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${wiseBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.wise.apiKey}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Wise ${method} ${path} failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
    );
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Wise ${method} ${path} returned a non-JSON response`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

/** Depth-first search for the first value stored under any of the given keys. */
function deepFind(node: unknown, keys: string[]): string | undefined {
  const record = asRecord(node);
  for (const [key, value] of Object.entries(record)) {
    if (keys.includes(key)) {
      const found = text(value);
      if (found) return found;
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") {
      const found = deepFind(value, keys);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Wise returns receiving details as `receiveOptions[]` (LOCAL / INTERNATIONAL),
 * each holding a `details[]` array of `{ type, body }` entries such as
 * ACCOUNT_NUMBER, ROUTING_NUMBER, IBAN, SWIFT_CODE and ACCOUNT_HOLDER. Older
 * responses use flat `localDetails` / `internationalDetails` objects — both
 * shapes are supported, preferring the local option.
 */
function normalizeDetails(
  source: Record<string, unknown>,
): WiseAccountDetails["details"] {
  const options = (
    Array.isArray(source.receiveOptions) ? source.receiveOptions : []
  ).map(asRecord);
  const optionFor = (name: string) =>
    options.find((option) => text(option.type)?.toUpperCase() === name);
  const selected =
    optionFor("LOCAL") ?? optionFor("INTERNATIONAL") ?? asRecord(options[0]);

  const fields: Record<string, string> = {};
  for (const entry of (
    Array.isArray(selected.details) ? selected.details : []
  ).map(asRecord)) {
    const key = text(entry.type)?.toUpperCase();
    const value = text(entry.body);
    if (key && value && fields[key] === undefined) fields[key] = value;
  }

  const local = asRecord(source.localDetails);
  const international = asRecord(source.internationalDetails);
  return {
    type:
      text(selected.type, local.type, international.type) ??
      deepFind(source, ["type"]),
    iban: fields.IBAN ?? text(international.iban) ?? deepFind(source, ["iban"]),
    accountNumber:
      fields.ACCOUNT_NUMBER ??
      text(local.accountNumber) ??
      deepFind(source, ["accountNumber"]),
    routingNumber:
      fields.ROUTING_NUMBER ??
      text(local.routingNumber) ??
      deepFind(source, ["routingNumber"]),
    sortCode:
      fields.SORT_CODE ??
      text(local.sortCode) ??
      deepFind(source, ["sortCode"]),
    bankName:
      fields.BANK_NAME_AND_ADDRESS ??
      text(local.bankName, international.bankName) ??
      deepFind(source, ["bankName", "institutionName"]),
    swiftCode:
      fields.SWIFT_CODE ??
      text(international.swiftCode) ??
      deepFind(source, ["swiftCode", "swift", "bic"]),
    accountHolder:
      fields.ACCOUNT_HOLDER ??
      deepFind(source, ["accountHolder", "accountHolderName"]),
    accountType:
      fields.ACCOUNT_TYPE ??
      text(local.accountType) ??
      deepFind(source, ["accountType"]),
    country: deepFind(source, ["countryCode"]) ?? text(source.country),
  };
}

/** Reuses the profile's STANDARD balance for the currency, creating one if absent. */
async function findOrCreateBalance(
  profileId: string,
  currency: string,
): Promise<string> {
  const balances = await wiseRequest<unknown>(
    "GET",
    `/v4/profiles/${profileId}/balances?types=STANDARD`,
  );
  const existing = Array.isArray(balances)
    ? balances
        .map(asRecord)
        .find((balance) => text(balance.currency)?.toUpperCase() === currency)
    : undefined;
  const existingId = existing ? text(existing.id) : undefined;
  if (existingId) return existingId;

  const created = await wiseRequest<Record<string, unknown>>(
    "POST",
    `/v3/profiles/${profileId}/balances`,
    { currency, type: "STANDARD" },
  );
  const createdId = text(created.id, created.balanceId);
  if (!createdId) {
    throw new Error(`Wise did not return a balance id for ${currency}`);
  }
  return createdId;
}

/**
 * Reads a currency's STANDARD balance (id + amount) so callers can preflight
 * outbound payouts against the funds actually held at Wise. Read-only — it does
 * not create a balance.
 */
export async function getWiseBalance(
  currency: string,
): Promise<{ balanceId: string; amount: string } | null> {
  if (!isWiseProvisioningEnabled()) return null;
  const balances = await wiseRequest<unknown>(
    "GET",
    `/v4/profiles/${config.wise.profileId}/balances?types=STANDARD`,
  );
  const match = (Array.isArray(balances) ? balances : [])
    .map(asRecord)
    .find(
      (balance) =>
        text(balance.currency)?.toUpperCase() === currency.toUpperCase(),
    );
  if (!match) return null;
  const balanceId = text(match.id);
  if (!balanceId) return null;
  const amount = text(asRecord(match.amount).value, match.amount) ?? "0";
  return { balanceId, amount };
}

/**
 * Provisions Wise receiving-account details (IBAN / local account number) for a
 * currency. Returns `null` when Wise provisioning is not configured so callers
 * can keep the local-only virtual-account behaviour.
 */
export async function provisionWiseAccountDetails(
  currency: string,
): Promise<WiseAccountDetails | null> {
  if (!isWiseProvisioningEnabled()) return null;
  const profileId = config.wise.profileId;
  const targetAccountId = await findOrCreateBalance(profileId, currency);

  let accountDetails: Record<string, unknown>;
  try {
    accountDetails = await wiseRequest(
      "POST",
      `/v3/profiles/${profileId}/bank-details`,
      { targetAccountId },
    );
  } catch (error) {
    logger.warn(
      { error, currency },
      "Wise bank-details creation failed; falling back to the account-details listing",
    );
    const listed = await wiseRequest<unknown>(
      "GET",
      `/v1/profiles/${profileId}/account-details`,
    );
    const match = (Array.isArray(listed) ? listed : [])
      .map(asRecord)
      .find((entry) => {
        const code = text(
          asRecord(entry.currency).code,
          entry.currency,
        )?.toUpperCase();
        return code === currency && entry.deprecated !== true;
      });
    if (!match) throw error;
    accountDetails = match;
  }

  return {
    // Wise webhooks identify the destination by balance id, so that is what we
    // store to match incoming funds back to this virtual account.
    externalId:
      text(accountDetails.balanceId) ?? text(accountDetails.id) ?? null,
    details: normalizeDetails(accountDetails),
  };
}

/**
 * Wise's published webhook signing keys, so signature verification works
 * without extra configuration. See
 * https://docs.wise.com/guides/developer/webhooks/event-handling
 */
const WISE_PUBLISHED_WEBHOOK_KEYS = {
  live: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`,
  sandbox: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`,
} as const;

/** RSA public key used to verify Wise webhook signatures (env override wins). */
export function wiseWebhookPublicKey(): string {
  return (
    config.wise.webhookPublicKey || WISE_PUBLISHED_WEBHOOK_KEYS[config.wise.environment]
  );
}

/** Verifies Wise's `X-Signature-SHA256` header: base64 RSA-SHA256 of the raw body. */
export function verifyWiseWebhookSignature(
  rawBody: Buffer,
  signature: string,
): boolean {
  try {
    return verify(
      "RSA-SHA256",
      rawBody,
      createPublicKey(wiseWebhookPublicKey()),
      Buffer.from(signature, "base64"),
    );
  } catch (error) {
    logger.warn({ error }, "Wise webhook signature verification failed");
    return false;
  }
}

/** Wise event that carries multi-currency account credits and debits. */
const BALANCE_UPDATE_TRIGGER = "balances#update";

export interface WiseWebhookSubscription {
  id: string | null;
  name: string | null;
  triggerOn: string | null;
  url: string | null;
  version: string | null;
}

function normalizeSubscription(node: unknown): WiseWebhookSubscription {
  const record = asRecord(node);
  const delivery = asRecord(record.delivery);
  return {
    id: text(record.id) ?? null,
    name: text(record.name) ?? null,
    triggerOn: text(record.trigger_on) ?? null,
    url: text(delivery.url) ?? null,
    version: text(delivery.version) ?? null,
  };
}

function assertWiseSubscriptionsAvailable(): void {
  if (!isWiseProvisioningEnabled()) {
    throw new Error("Wise provisioning is not enabled or fully configured");
  }
}

/**
 * Lists the profile's webhook subscriptions. Wise only delivers
 * `balances#update` events once a matching subscription exists, so operators use
 * this to confirm the platform is actually wired up.
 */
export async function listWiseWebhookSubscriptions(): Promise<WiseWebhookSubscription[]> {
  assertWiseSubscriptionsAvailable();
  const listed = await wiseRequest<unknown>(
    "GET",
    `/v3/profiles/${config.wise.profileId}/subscriptions`,
  );
  return (Array.isArray(listed) ? listed : []).map(normalizeSubscription);
}

/**
 * Creates the `balances#update` subscription pointing at
 * `WISE_WEBHOOK_URL` unless one already targets that URL. Without this
 * subscription Wise has no callback URL and inbound balance credits are never
 * delivered, so no funds reach the ledger. Safe to call repeatedly.
 */
export async function ensureWiseWebhookSubscription(): Promise<{
  created: boolean;
  subscription: WiseWebhookSubscription;
}> {
  assertWiseSubscriptionsAvailable();
  if (!config.wise.webhookUrl) {
    throw new Error("WISE_WEBHOOK_URL is not configured");
  }
  const existing = (await listWiseWebhookSubscriptions()).find(
    (subscription) =>
      subscription.triggerOn === BALANCE_UPDATE_TRIGGER &&
      subscription.url === config.wise.webhookUrl,
  );
  if (existing) return { created: false, subscription: existing };

  const created = await wiseRequest<unknown>(
    "POST",
    `/v3/profiles/${config.wise.profileId}/subscriptions`,
    {
      name: "PrimeStack inbound balance credits",
      trigger_on: BALANCE_UPDATE_TRIGGER,
      delivery: {
        version: config.wise.webhookDeliveryVersion,
        url: config.wise.webhookUrl,
      },
    },
  );
  return { created: true, subscription: normalizeSubscription(created) };
}
