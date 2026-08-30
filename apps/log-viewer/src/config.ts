import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  LOG_LEVEL: z.string().default("info"),
  LOGS_DIR: z.string().default(path.resolve("logs")),
  LOG_VIEWER_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "LOG_VIEWER_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    logsDir: path.resolve(env.LOGS_DIR),
    authToken: env.LOG_VIEWER_AUTH_TOKEN?.trim() ?? "",
    nodeEnv: env.NODE_ENV,
  };
}
