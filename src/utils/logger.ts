import winston from "winston";
import path from "path";
import fs from "fs";

const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fmt = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.json(),
);

export const logger = winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: fmt,
    transports: [
        new winston.transports.File({ filename: path.join(logDir, "rag.log"), maxsize: 10_485_760, maxFiles: 5 }),
        ...(process.env.NODE_ENV !== "production"
            ? [new winston.transports.Console({ format: winston.format.combine(winston.format.colorize(), winston.format.simple()) })]
            : []),
    ],
});

export interface RagLogEntry {
    endpoint: "search" | "chat" | "scan" | "meal-plan";
    userId?: string;
    query?: string;
    latency_ms: number;
    result_count?: number;
    matched?: boolean;
    fallback_used?: boolean;
    // meal-plan only: how many meals came from each real source vs AI
    source_breakdown?: { usda: number; recipe: number; food: number; ai_generated: number };
    status: "ok" | "error" | "rate_limited";
    error?: string;
}

export function logRag(entry: RagLogEntry) {
    logger.info("rag_request", entry);
}
