import { Kafka, type Producer } from "kafkajs";
import { config } from "../../config/index.js";
import { AppError, ValidationError } from "../../core/errors.js";
import { logger } from "../../core/logger.js";
import { generateReference } from "../../shared/utils/crypto.js";
import {
  STREAM_TOPICS,
  STREAM_TOPIC_LIST,
  type PublishedEvent,
  type StreamCounters,
  type StreamEvent,
  type StreamTopic,
} from "./streaming.types.js";

export interface StreamingOptions {
  enabled: boolean;
  brokers: string[];
  clientId: string;
  groupId: string;
  ssl: boolean;
  sasl?: { mechanism: string; username: string; password: string };
  /** How many undelivered events to retain in-process when Kafka is off. */
  bufferLimit: number;
}

export function streamingOptionsFromConfig(): StreamingOptions {
  const { kafka } = config;
  const sasl =
    kafka.saslMechanism && kafka.saslUsername && kafka.saslPassword
      ? { mechanism: kafka.saslMechanism, username: kafka.saslUsername, password: kafka.saslPassword }
      : undefined;

  return {
    enabled: kafka.enabled,
    brokers: [...kafka.brokers],
    clientId: kafka.clientId,
    groupId: kafka.groupId,
    ssl: kafka.ssl,
    sasl,
    bufferLimit: kafka.bufferLimit,
  };
}

/**
 * Event-streaming backbone.
 *
 * Every payment lifecycle transition is published to Kafka so AML, fraud,
 * monitoring, reporting and dashboards consume one ordered event log.
 *
 * Kafka is optional. When it is disabled (or no broker is configured) the
 * service buffers events in-process instead of failing — a dev or single-node
 * deployment keeps working, and `/streaming/events` still surfaces what would
 * have been published.
 */
export class StreamingService {
  private producer: Producer | null = null;
  private readonly buffer: StreamEvent[] = [];
  private readonly counters: StreamCounters = { published: 0, kafka: 0, buffered: 0, failed: 0 };
  private lastPublishedAt: Date | null = null;

  constructor(private readonly options: StreamingOptions) {}

  /** Topics and what each carries. */
  describeTopics() {
    return [
      { topic: STREAM_TOPICS.paymentsReceived, description: "A payment was accepted for processing" },
      { topic: STREAM_TOPICS.paymentsValidated, description: "Validation and screening passed" },
      { topic: STREAM_TOPICS.paymentsPosted, description: "The ledger entry was posted" },
      { topic: STREAM_TOPICS.paymentsFailed, description: "Processing failed or the payment was rejected" },
      { topic: STREAM_TOPICS.amlAlerts, description: "AML screening raised an alert" },
      { topic: STREAM_TOPICS.fraudAlerts, description: "The fraud engine raised an alert" },
    ];
  }

  /** Downstream consumers and the topics they read. */
  describePipeline() {
    return [
      { consumer: "AML Engine", topics: [STREAM_TOPICS.paymentsReceived, STREAM_TOPICS.paymentsValidated] },
      { consumer: "Fraud Engine", topics: [STREAM_TOPICS.paymentsReceived, STREAM_TOPICS.paymentsValidated] },
      { consumer: "Sanctions Screening", topics: [STREAM_TOPICS.paymentsValidated] },
      { consumer: "Monitoring", topics: [STREAM_TOPICS.paymentsPosted, STREAM_TOPICS.paymentsFailed, STREAM_TOPICS.amlAlerts, STREAM_TOPICS.fraudAlerts] },
      { consumer: "Reporting", topics: [STREAM_TOPICS.paymentsPosted, STREAM_TOPICS.paymentsFailed] },
      { consumer: "Dashboard", topics: STREAM_TOPIC_LIST },
    ];
  }

  /** Publish one event, returning the envelope that was sent (or buffered). */
  async publish(input: {
    topic: StreamTopic;
    eventName: string;
    payload?: Record<string, unknown>;
    reference?: string | null;
    eventId?: string;
  }): Promise<PublishedEvent> {
    if (!STREAM_TOPIC_LIST.includes(input.topic)) {
      throw new ValidationError(
        `Unknown stream topic: ${String(input.topic)} — expected one of ${STREAM_TOPIC_LIST.join(", ")}`,
      );
    }
    if (!input.eventName || input.eventName.trim() === "") {
      throw new ValidationError("eventName is required");
    }

    const event: StreamEvent = {
      eventId: input.eventId?.trim() || generateReference("EVT"),
      topic: input.topic,
      eventName: input.eventName.trim(),
      reference: input.reference ?? null,
      occurredAt: new Date().toISOString(),
      payload: input.payload ?? {},
    };
    this.counters.published++;

    if (!this.usesKafka()) {
      this.bufferEvent(event);
      this.counters.buffered++;
      logger.debug(
        { topic: event.topic, eventName: event.eventName, eventId: event.eventId },
        "Stream event buffered in-process (Kafka disabled)",
      );
      return { ...event, transport: "memory", accepted: true };
    }

    try {
      const producer = await this.getProducer();
      await producer.send({
        topic: event.topic,
        messages: [
          {
            key: event.reference ?? event.eventId,
            value: JSON.stringify(event),
            headers: { "event-name": event.eventName, "event-id": event.eventId },
          },
        ],
      });
      this.counters.kafka++;
      this.lastPublishedAt = new Date();
      return { ...event, transport: "kafka", accepted: true };
    } catch (error) {
      this.counters.failed++;
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, topic: event.topic }, "Stream publish failed");
      throw new AppError(`Failed to publish event to ${event.topic}: ${message}`, 502, "STREAM_PUBLISH_FAILED");
    }
  }

  /** Events retained in-process while Kafka is off (newest last). */
  listBuffered(limit = 50): StreamEvent[] {
    const safe = Math.max(1, Math.min(Math.trunc(limit) || 50, this.options.bufferLimit));
    return this.buffer.slice(-safe);
  }

  status() {
    return {
      transport: this.usesKafka() ? "kafka" : "memory",
      enabled: this.options.enabled,
      connected: this.producer !== null,
      brokers: [...this.options.brokers],
      topics: STREAM_TOPIC_LIST,
      counters: { ...this.counters },
      buffered: this.buffer.length,
      lastPublishedAt: this.lastPublishedAt?.toISOString() ?? null,
    };
  }

  /** Disconnect the producer. Safe to call when Kafka is off. */
  async close(): Promise<void> {
    if (!this.producer) return;
    const producer = this.producer;
    this.producer = null;
    await producer.disconnect();
  }

  private usesKafka(): boolean {
    return this.options.enabled && this.options.brokers.length > 0;
  }

  private bufferEvent(event: StreamEvent): void {
    this.buffer.push(event);
    while (this.buffer.length > this.options.bufferLimit) this.buffer.shift();
  }

  private async getProducer(): Promise<Producer> {
    if (this.producer) return this.producer;

    const sasl = this.options.sasl
      ? {
          mechanism: this.options.sasl.mechanism as never,
          username: this.options.sasl.username,
          password: this.options.sasl.password,
        }
      : undefined;

    const kafka = new Kafka({
      clientId: this.options.clientId,
      brokers: this.options.brokers,
      ssl: this.options.ssl,
      ...(sasl ? { sasl } : {}),
    });

    const producer = kafka.producer({ allowAutoTopicCreation: true });
    await producer.connect();
    this.producer = producer;
    logger.info({ brokers: this.options.brokers, clientId: this.options.clientId }, "Kafka producer connected");
    return producer;
  }
}
