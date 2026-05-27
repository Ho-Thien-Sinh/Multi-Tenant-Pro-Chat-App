import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import crypto from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      tenantId?: string;
    }
  }
}

export interface AuthRequest extends Request {
  userId?: string;
  tenantId?: string;
}

export const authenticateToken = (pool: Pool) => {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers['authorization'];
      const token = authHeader && authHeader.split(' ')[1]; // Bearer token

      if (!token) {
        return res.status(401).json({ error: 'Access token required' });
      }

      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; tenantId: string };
      
      req.userId = decoded.userId;
      req.tenantId = decoded.tenantId;

      // Set tenant context in database
      if (req.tenantId) {
        await pool.query('SELECT set_tenant_context($1)', [req.tenantId]);
      }

      next();
    } catch (error) {
      console.error('Auth error:', error);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
  };
};

export const generateToken = (userId: string, tenantId: string): string => {
  return jwt.sign(
    { userId, tenantId },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
};

export const generateRefreshToken = (): string => {
  return crypto.randomBytes(64).toString('hex');
};
