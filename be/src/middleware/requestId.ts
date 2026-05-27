import { Request, Response, NextFunction } from 'express';
import { logger, generateRequestId } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      traceId: string;
    }
  }
}

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const requestId = generateRequestId();
  const traceId = req.headers['x-trace-id'] as string || generateRequestId();
  
  req.requestId = requestId;
  req.traceId = traceId;
  
  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Trace-ID', traceId);
  
  // Log request with structured data
  logger.info({
    requestId,
    traceId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent'),
  }, 'Incoming request');
  
  next();
};
