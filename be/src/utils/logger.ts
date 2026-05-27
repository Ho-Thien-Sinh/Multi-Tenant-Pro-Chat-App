import pino from 'pino';

const baseOptions: pino.LoggerOptions = {
  level: process.env.LOG_LEVEL || 'info',
  serializers: {
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
};

const options: pino.LoggerOptions = process.env.NODE_ENV === 'development'
  ? {
      ...baseOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname,time,level',
          prefix: '[BACKEND] ',
          singleLine: true,
        },
      },
    }
  : {
      ...baseOptions,
      name: 'backend',
    };

export const logger = pino(options);

export const generateRequestId = (): string => {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
};
