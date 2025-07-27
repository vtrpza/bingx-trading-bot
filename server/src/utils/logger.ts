import winston from 'winston';
import path from 'path';

const logDir = process.env.LOG_DIR || 'logs';

const logger = winston.createLogger({
  level: 'debug', // Force debug level for troubleshooting
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'bingx-trading-bot' },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error' 
    }),
    // Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log') 
    })
  ]
});

// If we're not in production, log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    level: 'debug', // Force debug level for troubleshooting
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

// Wrap logger.error to catch [object Object] issues
const originalError = logger.error.bind(logger);
logger.error = function(message: any, ...args: any[]) {
  // Check if first argument is an Error object without a proper message
  if (message instanceof Error || (typeof message === 'object' && message !== null && !Array.isArray(message) && typeof message.message === 'string')) {
    // If it's an Error object or looks like one, format it properly
    if (message instanceof Error) {
      return originalError(`Caught raw Error object: ${message.message}`, {
        stack: message.stack,
        name: message.name,
        ...args[0]
      });
    } else if (typeof message === 'object' && message.message) {
      // It's already a structured object, pass it through
      return originalError(message, ...args);
    }
  }
  
  return originalError(message, ...args);
};

export { logger };