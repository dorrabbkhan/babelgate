import pino from "pino";
import { isSea } from "./sea";

function canResolvePinoPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function loggerOptions(
  env: NodeJS.ProcessEnv,
  canResolve: () => boolean,
): pino.LoggerOptions {
  const isProduction = env.NODE_ENV === "production";
  return {
    level: env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    // E3: a worker transport can't exist in the SEA binary — the
    // bundle is one file and pino-pretty isn't a builtin — so the
    // binary always logs plain JSON.
    transport:
      !isProduction && !isSea() && canResolve()
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:standard",
              ignore: "pid,hostname",
            },
          }
        : undefined,
  };
}

export const logger = pino(loggerOptions(process.env, canResolvePinoPretty));

export type Logger = pino.Logger;
