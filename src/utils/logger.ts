import winston from 'winston';
import path from 'path';
import fs from 'fs';

// Safe JSON stringify that handles circular references
function safeStringify(obj: any, indent?: number): string {
  try {
    return JSON.stringify(obj, (key, value) => {
      if (value && typeof value === 'object') {
        // Skip circular references
        if (value.constructor?.name === 'ClientRequest' || 
            value.constructor?.name === 'IncomingMessage' ||
            key === 'req' || key === 'res' || key === 'socket') {
          return '[Circular Reference Removed]';
        }
      }
      return value;
    }, indent);
  } catch (error) {
    return '[Object could not be stringified]';
  }
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  file?: string;
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} [${level.toUpperCase()}]: ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${safeStringify(meta)}`;
    }
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    let log = `${timestamp} ${level}: ${message}`;
    
    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${safeStringify(meta, 2)}`;
    }
    
    // Add stack trace for errors
    if (stack) {
      log += `\n${stack}`;
    }
    
    return log;
  })
);

export function createLogger(label: string, config: LoggingConfig = { level: 'info' }): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      level: config.level,
      format: consoleFormat
    })
  ];

  // Add file transport if specified
  if (config.file) {
    const logDir = path.dirname(config.file);
    const baseFileName = path.basename(config.file, path.extname(config.file));
    const fileExtension = path.extname(config.file);
    
    // Create daily directory structure: logs/daily/YYYY-MM-DD/
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const dailyDir = path.join(logDir, 'daily', today);
    
    // Ensure daily directory exists
    if (!fs.existsSync(dailyDir)) {
      fs.mkdirSync(dailyDir, { recursive: true });
    }
    
    // Create log files in daily directory
    const dailyLogFile = path.join(dailyDir, `${baseFileName}${fileExtension}`);
    const dailyErrorFile = path.join(dailyDir, `error.log`);
    const dailyHeartbeatFile = path.join(dailyDir, `heartbeat.log`);
    
    transports.push(
      new winston.transports.File({
        filename: dailyLogFile,
        level: config.level,
        format: logFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5, // 5 files per day max
        tailable: true
      })
    );

    // Add error-only log file
    transports.push(
      new winston.transports.File({
        filename: dailyErrorFile,
        level: 'error',
        format: logFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5, // 5 files per day max
        tailable: true
      })
    );
  }

  return winston.createLogger({
    level: config.level,
    format: logFormat,
    defaultMeta: { service: label },
    transports,
    exceptionHandlers: [
      new winston.transports.Console({
        format: consoleFormat
      })
    ],
    rejectionHandlers: [
      new winston.transports.Console({
        format: consoleFormat
      })
    ]
  });
}

export default createLogger;