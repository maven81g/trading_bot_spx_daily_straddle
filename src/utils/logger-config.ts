import winston from 'winston';

export interface LogConfig {
  level: string;
  silent: boolean;
  console: {
    enabled: boolean;
    level: string;
    format: 'simple' | 'json' | 'minimal';
  };
  file: {
    enabled: boolean;
    level: string;
    filename: string;
  };
}

// Different configurations based on environment
export const getLogConfig = (): LogConfig => {
  const env = process.env.NODE_ENV || 'development';
  const isCloud = process.env.RUNNING_IN_CLOUD === 'true';
  
  // Cloud configuration - minimal logging
  if (isCloud) {
    return {
      level: 'warn',
      silent: false,
      console: {
        enabled: true,
        level: 'warn',
        format: 'minimal'
      },
      file: {
        enabled: false, // Disable file logging in cloud
        level: 'error',
        filename: 'logs/cloud-bot.log'
      }
    };
  }
  
  // Local Docker configuration - moderate logging
  if (process.env.DOCKER_ENV === 'true') {
    return {
      level: 'info',
      silent: false,
      console: {
        enabled: true,
        level: 'info',
        format: 'simple'
      },
      file: {
        enabled: true,
        level: 'info',
        filename: 'logs/trading-bot.log'
      }
    };
  }
  
  // Development configuration - full logging
  return {
    level: 'debug',
    silent: false,
    console: {
      enabled: true,
      level: 'debug',
      format: 'simple'
    },
    file: {
      enabled: true,
      level: 'debug',
      filename: 'logs/trading-bot-dev.log'
    }
  };
};

// Create logger with environment-specific configuration
export const createLogger = (config?: Partial<LogConfig>) => {
  const defaultConfig = getLogConfig();
  const finalConfig = { ...defaultConfig, ...config };
  
  const transports: winston.transport[] = [];
  
  // Console transport
  if (finalConfig.console.enabled) {
    const consoleFormat = finalConfig.console.format === 'minimal' 
      ? winston.format.printf(({ level, message, timestamp }) => {
          // Minimal format for cloud - only critical info
          if (level === 'error' || level === 'warn') {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
          }
          return String(message); // Info and below just show message
        })
      : finalConfig.console.format === 'json'
      ? winston.format.json()
      : winston.format.simple();
    
    transports.push(
      new winston.transports.Console({
        level: finalConfig.console.level,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          consoleFormat
        )
      })
    );
  }
  
  // File transport
  if (finalConfig.file.enabled) {
    transports.push(
      new winston.transports.File({
        filename: finalConfig.file.filename,
        level: finalConfig.file.level,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    );
  }
  
  return winston.createLogger({
    level: finalConfig.level,
    silent: finalConfig.silent,
    transports
  });
};