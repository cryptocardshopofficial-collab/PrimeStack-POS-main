import { prisma } from "../../core/database.js";
import { logger } from "../../core/logger.js";
import { raiseAlarm, type AlarmSeverity } from "./alarms.js";

/**
 * Bridges the Security Shield's real-time attack detections into the
 * intelligence event log and the alarm engine, so blocked attackers are both
 * visible in the intelligence dashboard and surfaced as alarms.
 */

export interface SecurityEventInput {
  /** Stable machine code, e.g. BLOCKED_USER_AGENT, SQL_INJECTION, IP_AUTO_BANNED. */
  eventType: string;
  summary: string;
  ip?: string | null;
  severity?: AlarmSeverity;
  /** 0-100 analyst confidence stored on the intelligence event. */
  confidence?: number;
}

const DEFAULT_CONFIDENCE = 85;

export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  const summary = input.ip ? `${input.summary} [ip=${input.ip}]` : input.summary;

  try {
    await prisma.intelligenceEvent.create({
      data: {
        eventType: input.eventType,
        sourceSystem: "SECURITY_SHIELD",
        confidenceScore: input.confidence ?? DEFAULT_CONFIDENCE,
        summary: summary.slice(0, 1000),
        createdBy: "system:security-shield",
      },
    });
  } catch (err) {
    logger.debug({ err }, "Security event persist skipped");
  }

  raiseAlarm({
    code: `SECURITY_${input.eventType}`,
    severity: input.severity ?? "WARNING",
    message: summary,
    meta: { ip: input.ip ?? null, eventType: input.eventType },
  });
}
