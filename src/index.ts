import type { Server } from "node:http";
import { app } from "./app";
import { getConfig } from "./config/env-config";
import { formatRoutingTable } from "./routing/table";
import { logger } from "./utils/logger";

/**
 * Starts the proxy and resolves once it is listening. Importing this module
 * has no side effects — the server only starts when startServer() is called
 * (or when index.js is run directly, for `npm start` / `npm run dev`).
 */
export function startServer(): Promise<Server> {
  const config = getConfig();
  const port = config.port;

  return new Promise<Server>((resolve, reject) => {
    // No callback to app.listen: Express 5 registers a passed callback on
    // both "listening" and "error", which would resolve on a failed bind.
    const server = app.listen(port);

    // Graceful shutdown — drain in-flight requests instead of killing them
    // mid-generation. server.close() stops accepting new connections and
    // resolves once active requests finish; the timer is the escape hatch.
    function shutdown(signal: string): void {
      logger.info({ signal }, "Shutting down");
      server.close(() => {
        logger.info("All connections drained");
        process.exit(0);
      });
      setTimeout(() => {
        logger.warn("Forcing exit — connections did not drain in time");
        process.exit(1);
      }, 10_000).unref();
    }

    server.once("listening", () => {
      logger.info(
        {
          port,
          defaultProvider: config.routing.defaultProvider,
          providers: config.registry.names(),
        },
        "Server started",
      );
      for (const line of formatRoutingTable(config)) {
        logger.info(line);
      }
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      resolve(server);
    });
    server.once("error", reject);
  });
}

if (require.main === module) {
  try {
    getConfig();
  } catch (err) {
    logger.fatal({ err }, "Invalid configuration — check required env vars");
    process.exit(1);
  }
  startServer().catch((err) => {
    logger.fatal({ err }, "Failed to start server");
    process.exit(1);
  });
}
