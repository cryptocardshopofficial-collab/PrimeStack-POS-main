import { FastifyInstance } from "fastify";
import { prisma } from "../../core/database.js";
import { MonitoringService } from "./monitoring.service.js";
import { registerMonitoringRoutes } from "./monitoring.routes.js";
import { registerAlarmRoutes } from "./alarm.routes.js";
import { startAlarmWatchdog } from "./alarms.js";
import { logger } from "../../core/logger.js";

/**
 * Monitoring module — live transactions, host/terminal status, errors, network.
 */
export const monitoringService = new MonitoringService(prisma);

export function registerMonitoringModule(app: FastifyInstance): void {
  registerMonitoringRoutes(app, monitoringService);
  registerAlarmRoutes(app);
  startAlarmWatchdog();
  logger.info("Monitoring module registered");
}

export { MonitoringService };

