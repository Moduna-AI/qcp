import winston from 'winston';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { QCP_HOME, LOGS_DIR } from '../config/index.js';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

let _logger: winston.Logger | null = null;

function ensureLogsDir(): void {
  if (!existsSync(QCP_HOME)) mkdirSync(QCP_HOME, { recursive: true });
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
}

function createLogger(): winston.Logger {
  ensureLogsDir();

  return winston.createLogger({
    level: process.env.QCP_LOG_LEVEL ?? 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    transports: [
      new winston.transports.File({
        filename: join(LOGS_DIR, 'error.log'),
        level: 'error',
        maxsize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES,
        tailable: true,
      }),
      new winston.transports.File({
        filename: join(LOGS_DIR, 'app.log'),
        maxsize: MAX_FILE_SIZE,
        maxFiles: MAX_FILES,
        tailable: true,
      }),
    ],
    // Only add console transport when DEBUG env is set
    ...(process.env.QCP_DEBUG === '1'
      ? {
          transports: [
            new winston.transports.Console({
              format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
              ),
            }),
          ],
        }
      : {}),
    exceptionHandlers: [
      new winston.transports.File({
        filename: join(LOGS_DIR, 'error.log'),
      }),
    ],
    rejectionHandlers: [
      new winston.transports.File({
        filename: join(LOGS_DIR, 'error.log'),
      }),
    ],
  });
}

export function getLogger(): winston.Logger {
  if (!_logger) {
    try {
      _logger = createLogger();
    } catch {
      // If logger creation fails (e.g. no home dir), use a silent logger
      _logger = winston.createLogger({ silent: true });
    }
  }
  return _logger;
}

export function log(level: 'info' | 'warn' | 'error' | 'debug', message: string, meta?: object): void {
  try {
    getLogger().log(level, message, meta);
  } catch {
    // never let logging crash the CLI
  }
}
