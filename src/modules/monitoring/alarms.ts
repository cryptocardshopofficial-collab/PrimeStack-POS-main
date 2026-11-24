import { randomUUID } from "crypto";
import { prisma } from "../../core/database.js";
import { redis } from "../../core/redis.js";
import { logger } from "../../core/logger.js";

/**
 * PrimeStack Alarm & Watchdog engine.
 *
 * Raises structured alarms when the platform itself is unhealthy (the API stops
 * answering, the database or Redis drop, the event loop stalls, or the process
 * throws), and pushes them to the configured alert channels.
 *
 * Hard rule: an alarm engine must never be the thing that takes the platform
 * down. Every external call (webhook, email, DB write) is best-effort and
 * swallowed on failure. Delivery is fire-and-forget off the request path.
 */

export type AlarmSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface AlarmRecord {
  id: string;
  code: string;
  severity: AlarmSeverity;
  message: string;
  meta: Record<string, unknown> | null;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  lastNotifiedAt: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  clearedAt: string | null;
}

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

const HISTORY_LIMIT = 200;
const RENOTIFY_INTERVAL_MS = 10 * 60 * 1000; // repeat-notify at most every 10 min

const WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();
const EMAIL_WEBHOOK_URL = (process.env.ALERT_EMAIL_WEBHOOK_URL || "").trim();
const EMAIL_TO = (process.env.ALERT_EMAIL_TO || "").trim();
const EMAIL_FROM = (process.env.ALERT_EMAIL_FROM || "alerts@primestack.io").trim();
const MIN_NOTIFY_SEVERITY = (
  (process.env.ALERT_MIN_SEVERITY || "WARNING").trim().toUpperCase() as AlarmSeverity
);
const WATCHDOG_INTERVAL_MS = numberFromEnv("ALERT_WATCHDOG_INTERVAL_MS", 30_000);

const active = new Map<string, AlarmRecord>();
const history: AlarmRecord[] = [];

let lastPingAt: string | null = null;
let watchdogTimer: NodeJS.Timeout | null = null;
let hooksInstalled = false;

function numberFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldNotify(severity: AlarmSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[MIN_NOTIFY_SEVERITY] || severity === "CRITICAL";
}

function trimHistory(): void {
  while (history.length > HISTORY_LIMIT) history.pop();
}

/** Record the fact that an external monitor pinged us (dead-man's switch). */
export function recordPing(): string {
  lastPingAt = new Date().toISOString();
  return lastPingAt;
}

export function getPingState(): { lastPingAt: string | null; active: number } {
  return { lastPingAt, active: active.size };
}

/**
 * Raise (or refresh) an alarm. Deduplicated by `code`; repeated raises only bump
 * the counter and last-seen time so a flood of identical failures stays one alarm.
 */
export function raiseAlarm(input: {
  code: string;
  severity: AlarmSeverity;
  message: string;
  meta?: Record<string, unknown> | null;
}): AlarmRecord {
  const now = new Date().toISOString();
  const existing = active.get(input.code);

  if (existing) {
    existing.lastSeenAt = now;
    existing.count += 1;
    existing.message = input.message;
    if (input.meta) existing.meta = input.meta;
    // Escalate, never silently downgrade an active alarm.
    if (SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = input.severity;
    }
    const dueForRenotify =
      !existing.lastNotifiedAt ||
      Date.now() - new Date(existing.lastNotifiedAt).getTime() >= RENOTIFY_INTERVAL_MS;
    if (shouldNotify(existing.severity) && dueForRenotify) {
      existing.lastNotifiedAt = now;
      void dispatch(existing);
    }
    return existing;
  }

  const record: AlarmRecord = {
    id: randomUUID(),
    code: input.code,
    severity: input.severity,
    message: input.message,
    meta: input.meta ?? null,
    firstSeenAt: now,
    lastSeenAt: now,
    count: 1,
    lastNotifiedAt: null,
    acknowledgedBy: null,
    acknowledgedAt: null,
    clearedAt: null,
  };
  active.set(record.code, record);
  history.unshift(record);
  trimHistory();

  logger.error(
    { alarmCode: record.code, severity: record.severity, message: record.message, meta: record.meta },
    "ALARM RAISED",
  );

  if (shouldNotify(record.severity)) {
    record.lastNotifiedAt = now;
    void dispatch(record);
  }
  void persist(record);
  return record;
}

/** Clear an active alarm (service recovered). Keeps it in history for the audit trail. */
export function clearAlarm(code: string, meta?: Record<string, unknown> | null): void {
  const record = active.get(code);
  if (!record) return;
  record.clearedAt = new Date().toISOString();
  record.lastSeenAt = record.clearedAt;
  if (meta) record.meta = meta;
  active.delete(code);

  logger.warn({ alarmCode: code }, "ALARM CLEARED");
  if (WEBHOOK_URL) {
    void postJson(WEBHOOK_URL, {
      source: "primestack-alarm-engine",
      event: "alarm.cleared",
      severity: record.severity,
      code: record.code,
      message: `RECOVERED: ${record.message}`,
      meta: record.meta,
      timestamp: record.clearedAt,
    }).catch(() => {});
  }
}

export function acknowledgeAlarm(id: string, by: string): AlarmRecord | null {
  const target = history.find((alarm) => alarm.id === id) ?? null;
  if (!target) return null;
  target.acknowledgedBy = by;
  target.acknowledgedAt = new Date().toISOString();
  return target;
}

export function listAlarms(): {
  active: AlarmRecord[];
  history: AlarmRecord[];
  counts: Record<AlarmSeverity, number>;
} {
  const counts: Record<AlarmSeverity, number> = { INFO: 0, WARNING: 0, CRITICAL: 0 };
  for (const alarm of active.values()) counts[alarm.severity] += 1;
  return {
    active: Array.from(active.values()).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    history,
    counts,
  };
}

export function raiseTestAlarm(by: string): AlarmRecord {
  return raiseAlarm({
    code: `TEST_ALARM_${Date.now()}`,
    severity: "CRITICAL",
    message: `Test alarm raised by ${by} to verify alert delivery`,
    meta: { raisedBy: by, test: true },
  });
}

// ── Delivery ────────────────────────────────────────────────────────────────

async function dispatch(record: AlarmRecord): Promise<void> {
  const payload = {
    source: "primestack-alarm-engine",
    event: "alarm.raised",
    severity: record.severity,
    code: record.code,
    message: record.message,
    meta: record.meta,
    count: record.count,
    timestamp: record.lastSeenAt,
  };

  if (WEBHOOK_URL) {
    try {
      await postJson(WEBHOOK_URL, payload);
      logger.info({ alarmCode: record.code }, "Alarm delivered to webhook");
    } catch (err) {
      logger.warn({ err, alarmCode: record.code }, "Alarm webhook delivery failed");
    }
  }

  if (EMAIL_WEBHOOK_URL && EMAIL_TO) {
    try {
      await postJson(EMAIL_WEBHOOK_URL, {
        from: EMAIL_FROM,
        to: EMAIL_TO,
        subject: `[PrimeStack ${record.severity}] ${record.code}`,
        text: `${record.message}\n\nCode: ${record.code}\nSeverity: ${record.severity}\nTime: ${record.lastSeenAt}\nMeta: ${JSON.stringify(record.meta)}`,
      });
      logger.info({ alarmCode: record.code }, "Alarm delivered to email relay");
    } catch (err) {
      logger.warn({ err, alarmCode: record.code }, "Alarm email relay delivery failed");
    }
  }

  if (!WEBHOOK_URL && !EMAIL_WEBHOOK_URL) {
    logger.warn(
      { alarmCode: record.code },
      "No ALERT_WEBHOOK_URL or ALERT_EMAIL_WEBHOOK_URL configured — alarm logged only",
    );
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function persist(record: AlarmRecord): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: "ALARM_RAISED",
        entity: "ALARM",
        entityId: record.code,
        after: JSON.parse(
          JSON.stringify({
            severity: record.severity,
            message: record.message,
            meta: record.meta,
            firstSeenAt: record.firstSeenAt,
          }),
        ),
      },
    });
  } catch (err) {
    logger.debug({ err }, "Alarm audit-log persist skipped");
  }
}

// ── Watchdog ────────────────────────────────────────────────────────────────

const failStreak = { api: 0, db: 0, redis: 0, eventLoop: 0 };

async function probeDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

async function probeRedis(): Promise<boolean> {
  try {
    const pong = await redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function probeHttpSelf(): Promise<boolean> {
  // The API may listen on PORT or API_PORT depending on the launcher, so probe
  // every plausible self-URL and treat the process as healthy if any answers.
  const candidates = new Set<string>();
  const explicit = (process.env.WATCHDOG_HEALTH_URL || "").trim();
  if (explicit) candidates.add(explicit);

  const apiBase = (process.env.PRIMESTACK_API_URL || process.env.INTERNAL_API_URL || "").trim();
  if (apiBase) candidates.add(`${apiBase.replace(/\/$/, "")}/health`);

  for (const port of [process.env.API_PORT, process.env.PORT]) {
    if (port) candidates.add(`http://127.0.0.1:${port}/health`);
  }
  candidates.add("http://127.0.0.1:9006/health");
  candidates.add("http://127.0.0.1:9005/health");

  for (const url of candidates) {
    if (await pingOk(url)) return true;
  }
  return false;
}

async function pingOk(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Raise after N consecutive failures so a single blip does not alarm. */
function track(code: string, key: keyof typeof failStreak, healthy: boolean, detail: string): void {
  if (healthy) {
    failStreak[key] = 0;
    clearAlarm(code);
    return;
  }
  failStreak[key] += 1;
  if (failStreak[key] >= 2) {
    raiseAlarm({ code, severity: "CRITICAL", message: detail, meta: { consecutiveFailures: failStreak[key] } });
  }
}

async function runChecks(): Promise<void> {
  const startedAt = Date.now();

  const [dbHealthy, redisHealthy, httpHealthy] = await Promise.all([
    probeDatabase(),
    probeRedis(),
    probeHttpSelf(),
  ]);

  track("DATABASE_UNREACHABLE", "db", dbHealthy, "Database did not answer SELECT 1");
  track("REDIS_UNREACHABLE", "redis", redisHealthy, "Redis did not answer PING");
  track("API_HEALTH_UNREACHABLE", "api", httpHealthy, "API /health endpoint did not respond OK");

  // Event-loop stall detection: this check itself should finish well under 5s.
  const elapsed = Date.now() - startedAt;
  track(
    "EVENT_LOOP_BLOCKED",
    "eventLoop",
    elapsed < 5000,
    `Event loop stalled ~${elapsed}ms during health sweep`,
  );
}

export function startAlarmWatchdog(): void {
  if (watchdogTimer) return;
  installProcessHooks();
  watchdogTimer = setInterval(() => {
    void runChecks().catch((err) => logger.debug({ err }, "Watchdog sweep failed"));
  }, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogTimer.unref === "function") watchdogTimer.unref();
  // First sweep shortly after boot without blocking startup.
  setTimeout(() => void runChecks().catch(() => {}), 5_000).unref?.();
  logger.info({ intervalMs: WATCHDOG_INTERVAL_MS }, "Alarm watchdog started");
}

export function stopAlarmWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function installProcessHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  process.on("uncaughtException", (err) => {
    raiseAlarm({
      code: "UNCAUGHT_EXCEPTION",
      severity: "CRITICAL",
      message: `Uncaught exception: ${err?.message || String(err)}`,
      meta: { stack: String(err?.stack || "").split("\n").slice(0, 6).join("\n") },
    });
  });

  process.on("unhandledRejection", (reason) => {
    raiseAlarm({
      code: "UNHANDLED_REJECTION",
      severity: "CRITICAL",
      message: `Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
    });
  });
}
