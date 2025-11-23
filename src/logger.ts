/**
 * Logger interface for subscription events and internal operations.
 * Users can provide their own implementation to integrate with external logging services.
 */
export interface Logger {
    /**
     * Log debug-level messages (typically only shown in development).
     * @param msg - The message to log
     * @param context - Optional context object with additional information
     */
    debug: (msg: string, context?: object) => void;

    /**
     * Log warning-level messages.
     * @param msg - The message to log
     * @param context - Optional context object with additional information
     */
    warn: (msg: string, context?: object) => void;

    /**
     * Log error-level messages.
     * @param msg - The message to log
     * @param context - Optional context object with additional information
     */
    error: (msg: string, context?: object) => void;
}

/**
 * Default console-based logger implementation.
 * Only logs debug messages in development mode.
 */
const defaultLogger: Logger = {
    debug: (msg: string, context?: object) => {
        // Only log debug in development
        if (process.env.NODE_ENV === 'development') {
            // biome-ignore lint/suspicious/noConsoleLog: Debug logging is acceptable in development
            console.log(`[pbtsdb] ${msg}`, context || '');
        }
    },
    warn: (msg: string, context?: object) => {
        // biome-ignore lint/suspicious/noConsoleLog: Warning logging is acceptable
        console.warn(`[pbtsdb] ${msg}`, context || '');
    },
    error: (msg: string, context?: object) => {
        // biome-ignore lint/suspicious/noConsoleLog: Error logging is acceptable
        console.error(`[pbtsdb] ${msg}`, context || '');
    },
};

/**
 * Current logger instance (can be replaced by users).
 */
let currentLogger: Logger = defaultLogger;

/**
 * Internal logger instance used by the library.
 */
export const logger: Logger = {
    debug: (msg: string, context?: object) => currentLogger.debug(msg, context),
    warn: (msg: string, context?: object) => currentLogger.warn(msg, context),
    error: (msg: string, context?: object) => currentLogger.error(msg, context),
};

/**
 * Set a custom logger implementation.
 * This allows users to integrate with their own logging services (e.g., Sentry, LogRocket, etc.).
 *
 * @param customLogger - The custom logger implementation
 *
 * @example
 * ```ts
 * import { setLogger } from 'pocketbase-tanstack-db';
 *
 * // Example: Integration with a custom logging service
 * setLogger({
 *     debug: (msg, context) => {
 *         myLogger.debug(msg, context);
 *     },
 *     warn: (msg, context) => {
 *         myLogger.warn(msg, context);
 *     },
 *     error: (msg, context) => {
 *         myLogger.error(msg, context);
 *         // Also send to error tracking service
 *         Sentry.captureMessage(msg, { level: 'error', extra: context });
 *     },
 * });
 * ```
 *
 * @example
 * ```ts
 * // Example: Disable all logging
 * setLogger({
 *     debug: () => {},
 *     warn: () => {},
 *     error: () => {},
 * });
 * ```
 */
export function setLogger(customLogger: Logger): void {
    currentLogger = customLogger;
}

/**
 * Reset the logger to the default implementation.
 */
export function resetLogger(): void {
    currentLogger = defaultLogger;
}
