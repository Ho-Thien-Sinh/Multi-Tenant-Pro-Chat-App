const prefix = '[FRONTEND]';

export const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`${prefix} ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    console.error(`${prefix} ${message}`, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`${prefix} ${message}`, ...args);
  },
};
