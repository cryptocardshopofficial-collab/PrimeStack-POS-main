/**
 * Event-streaming types.
 *
 * The switch publishes every payment lifecycle transition to Kafka so that
 * compliance (AML / fraud), monitoring, reporting and dashboards can consume
 * the same ordered event log instead of polling the ledger.
 */

export const STREAM_TOPICS = {
  paymentsReceived: "payments.received",
  paymentsValidated: "payments.validated",
  paymentsPosted: "payments.posted",
  paymentsFailed: "payments.failed",
  amlAlerts: "aml.alerts",
  fraudAlerts: "fraud.alerts",
} as const;

export type StreamTopic = (typeof STREAM_TOPICS)[keyof typeof STREAM_TOPICS];

export const STREAM_TOPIC_LIST: StreamTopic[] = [
  STREAM_TOPICS.paymentsReceived,
  STREAM_TOPICS.paymentsValidated,
  STREAM_TOPICS.paymentsPosted,
  STREAM_TOPICS.paymentsFailed,
  STREAM_TOPICS.amlAlerts,
  STREAM_TOPICS.fraudAlerts,
];

/** The envelope every message carries, so consumers can route without parsing payloads. */
export interface StreamEvent<T = Record<string, unknown>> {
  eventId: string;
  topic: StreamTopic;
  /** Business event name, e.g. PAYMENT_SETTLED. */
  eventName: string;
  /** Payment/transfer reference, when the event concerns one. */
  reference: string | null;
  occurredAt: string;
  payload: T;
}

export type StreamTransport = "kafka" | "memory";

export interface PublishedEvent<T = Record<string, unknown>> extends StreamEvent<T> {
  transport: StreamTransport;
  accepted: boolean;
}

export interface StreamCounters {
  published: number;
  kafka: number;
  /** Events buffered in-process because no broker is configured. */
  buffered: number;
  failed: number;
}
