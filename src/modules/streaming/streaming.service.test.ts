import { describe, expect, it } from "vitest";
import { StreamingService, type StreamingOptions } from "./streaming.service.js";
import { STREAM_TOPICS } from "./streaming.types.js";

function memoryService(overrides: Partial<StreamingOptions> = {}): StreamingService {
  return new StreamingService({
    enabled: false,
    brokers: [],
    clientId: "test-client",
    groupId: "test-group",
    ssl: false,
    bufferLimit: 3,
    ...overrides,
  });
}

describe("StreamingService (in-process buffer)", () => {
  it("buffers events when Kafka is disabled", async () => {
    const service = memoryService();
    const published = await service.publish({
      topic: STREAM_TOPICS.paymentsReceived,
      eventName: "PAYMENT_RECEIVED",
      reference: "ABC123",
      payload: { amount: "500000" },
    });

    expect(published.transport).toBe("memory");
    expect(published.accepted).toBe(true);
    expect(published.topic).toBe("payments.received");
    expect(published.reference).toBe("ABC123");
    expect(published.eventId).toMatch(/^EVT-/);
    expect(service.listBuffered()).toHaveLength(1);
  });

  it("falls back to memory when enabled but no broker is configured", async () => {
    const service = memoryService({ enabled: true, brokers: [] });
    const published = await service.publish({
      topic: STREAM_TOPICS.paymentsPosted,
      eventName: "PAYMENT_POSTED",
    });

    expect(published.transport).toBe("memory");
    expect(service.status().transport).toBe("memory");
  });

  it("caps the buffer at bufferLimit, keeping the newest events", async () => {
    const service = memoryService({ bufferLimit: 3 });
    for (let i = 1; i <= 5; i++) {
      await service.publish({
        topic: STREAM_TOPICS.amlAlerts,
        eventName: "AML_ALERT",
        payload: { seq: i },
      });
    }

    const buffered = service.listBuffered(10);
    expect(buffered).toHaveLength(3);
    expect(buffered.map((event) => event.payload.seq)).toEqual([3, 4, 5]);
  });

  it("rejects an unknown topic", async () => {
    const service = memoryService();
    await expect(
      service.publish({ topic: "payments.unknown" as never, eventName: "X" }),
    ).rejects.toThrow(/Unknown stream topic/);
  });

  it("rejects a blank event name", async () => {
    const service = memoryService();
    await expect(
      service.publish({ topic: STREAM_TOPICS.paymentsFailed, eventName: "   " }),
    ).rejects.toThrow("eventName is required");
  });

  it("reports counters and topic metadata", async () => {
    const service = memoryService();
    await service.publish({ topic: STREAM_TOPICS.fraudAlerts, eventName: "FRAUD_ALERT" });

    const status = service.status();
    expect(status.counters.published).toBe(1);
    expect(status.counters.buffered).toBe(1);
    expect(status.counters.kafka).toBe(0);
    expect(status.enabled).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.topics).toContain("payments.validated");

    expect(service.describeTopics()).toHaveLength(6);
    expect(service.describePipeline().map((entry) => entry.consumer)).toContain("AML Engine");
  });

  it("closes cleanly when Kafka was never connected", async () => {
    const service = memoryService();
    await expect(service.close()).resolves.toBeUndefined();
  });
});
