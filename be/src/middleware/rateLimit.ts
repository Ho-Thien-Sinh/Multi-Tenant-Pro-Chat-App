import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';

// General rate limiter for most endpoints
export const generalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  handler: (req, res) => {
    logger.warn({ ip: req.ip, requestId: (req as any).requestId }, 'Rate limit exceeded');
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});

// Strict rate limiter for login (prevent brute force)
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per 15 minutes
  skipSuccessfulRequests: true, // Only count failed attempts
  message: { error: 'Too many login attempts, please try again later' },
  handler: (req, res) => {
    logger.warn({ ip: req.ip, requestId: (req as any).requestId }, 'Login rate limit exceeded');
    res.status(429).json({ error: 'Too many login attempts, please try again later' });
  },
});

// Rate limiter for sending messages (prevent spam)
export const messageRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit to 30 messages per minute
  message: { error: 'Too many messages, please slow down' },
  handler: (req, res) => {
    logger.warn({ ip: req.ip, requestId: (req as any).requestId }, 'Message rate limit exceeded');
    res.status(429).json({ error: 'Too many messages, please slow down' });
  },
});

// Rate limiter for file uploads
export const uploadRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10, // Limit to 10 uploads per minute
  message: { error: 'Too many uploads, please try again later' },
  handler: (req, res) => {
    logger.warn({ ip: req.ip, requestId: (req as any).requestId }, 'Upload rate limit exceeded');
    res.status(429).json({ error: 'Too many uploads, please try again later' });
  },
});
