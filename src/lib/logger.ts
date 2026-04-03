import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");

const logDirectory = process.env.LOG_DIR
  ? path.resolve(projectRoot, process.env.LOG_DIR)
  : path.join(projectRoot, "logs");
const logLevel = process.env.LOG_LEVEL || "info";

fs.mkdirSync(logDirectory, { recursive: true });

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message, component, eventName, ...meta }) => {
    const suffix = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
    const componentLabel = component ? `[${component}]` : "";
    const eventLabel = eventName ? `[${eventName}]` : "";
    return `${timestamp} ${level} ${componentLabel}${eventLabel} ${message}${suffix}`.trim();
  }),
);

const transports: winston.transport[] = [
  new DailyRotateFile({
    filename: path.join(logDirectory, "app-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxFiles: "14d",
    level: logLevel,
    zippedArchive: false,
  }),
  new DailyRotateFile({
    filename: path.join(logDirectory, "error-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    maxFiles: "30d",
    level: "error",
    zippedArchive: false,
  }),
];

if (process.env.NODE_ENV !== "production") {
  transports.push(
    new winston.transports.Console({
      level: logLevel,
      format: consoleFormat,
    }),
  );
}

export const logger = winston.createLogger({
  level: logLevel,
  defaultMeta: {
    service: "ai-fin-assistant",
  },
  format: jsonFormat,
  transports,
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDirectory, "exceptions-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      zippedArchive: false,
    }),
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDirectory, "rejections-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxFiles: "30d",
      zippedArchive: false,
    }),
  ],
});

export function getLogger(component: string) {
  return logger.child({ component });
}

export function truncateForLog(value: string, maxLength = 500) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}
