import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { Queue, Worker, Job } from 'bullmq';
import jwt from 'jsonwebtoken';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import dotenv from 'dotenv';
import { authenticateToken, AuthRequest, generateToken, generateRefreshToken } from './middleware/auth';
import { requestIdMiddleware } from './middleware/requestId';
import { generalRateLimiter, loginRateLimiter, messageRateLimiter, uploadRateLimiter } from './middleware/rateLimit';
import { logger } from './utils/logger';
import { initializeBucket, generatePresignedUrl, generatePresignedDownloadUrl } from './services/minio';
import { verifyMomoSignature, verifyStripeSignature, processPaymentEvent } from './services/payment';
import { successResponse, badRequest, unauthorized, forbidden, notFound, internalServerError, errorResponse } from './utils/response';

dotenv.config();

const app = express();
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'Chat-App',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'sinhho123',
});

// Redis connection for presence and BullMQ
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

let redisConnected = false;
let notificationQueue: Queue | null = null;
let notificationWorker: Worker | null = null;

async function connectRedis() {
  try {
    await redisClient.connect();
    redisConnected = true;
    logger.info('Redis connected successfully');

    // BullMQ setup for push notifications (only if Redis is connected)
    notificationQueue = new Queue('notifications', {
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    });

    // Notification worker with retry policy (max 3 retries)
    notificationWorker = new Worker(
      'notifications',
      async (job: Job) => {
        const { userId, message, roomId } = job.data;
        logger.info({ userId, roomId, jobId: job.id }, 'Sending notification');
        
        // Simulate push notification sending
        // In production, integrate with FCM/APNS
        await new Promise(resolve => setTimeout(resolve, 100));
        
        logger.info({ jobId: job.id }, 'Notification sent successfully');
      },
      {
        connection: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379'),
        },
        limiter: {
          max: 10,
          duration: 1000,
        },
      }
    );

    // Logging for job events
    notificationWorker.on('completed', (job: Job) => {
      logger.info({ jobId: job.id }, 'Job completed');
    });

    notificationWorker.on('failed', (job: Job | undefined, error: Error) => {
      logger.error({ jobId: job?.id, error: error.message }, 'Job failed');
    });
  } catch (error) {
    logger.warn({ error }, 'Redis connection failed, running without Redis');
    redisConnected = false;
  }
}
connectRedis();

// Initialize MinIO bucket
initializeBucket();

app.use(express.json());
app.use(requestIdMiddleware);
app.use(generalRateLimiter);

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Multi-Tenant Pro Chat App API',
      version: '1.0.0',
      description: 'Backend API for multi-tenant chat application with real-time messaging, presence, and subscriptions',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Tenant: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            code: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string', enum: ['active', 'inactive', 'suspended'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid' },
            email: { type: 'string' },
            username: { type: 'string' },
            role: { type: 'string', enum: ['admin', 'user'] },
            status: { type: 'string', enum: ['active', 'inactive'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Room: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            type: { type: 'string', enum: ['direct', 'group'] },
            created_by: { type: 'string', format: 'uuid' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            tenant_id: { type: 'string', format: 'uuid' },
            room_id: { type: 'string', format: 'uuid' },
            sender_id: { type: 'string', format: 'uuid' },
            content: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        LoginRequest: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string' },
            password: { type: 'string' },
          },
        },
        LoginResponse: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ['./src/index.ts'],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Endpoint kiểm tra sức khỏe
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Server hoạt động bình thường
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/health', (req: Request, res: Response) => {
  successResponse(res, 200, 'Server hoạt động bình thường', { status: 'ok', timestamp: new Date().toISOString() }, 'Server is healthy');
});

// Detailed health check with DB and Redis status
/**
 * @swagger
 * /health/detailed:
 *   get:
 *     summary: Kiểm tra sức khỏe chi tiết với trạng thái DB và Redis
 *     tags: [Health]
 *     responses:
 *       200:
 *         description: Trạng thái sức khỏe chi tiết
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 services:
 *                   type: object
 *                   properties:
 *                     database:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                         latency_ms:
 *                           type: number
 *                     redis:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                         connected:
 *                           type: boolean
 */
app.get('/health/detailed', async (req: Request, res: Response) => {
  const healthStatus: any = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    services: {}
  };

  // Check PostgreSQL
  try {
    const dbResult = await pool.query('SELECT NOW()');
    healthStatus.services.database = { status: 'ok', latency_ms: 0 };
  } catch (error) {
    healthStatus.status = 'degraded';
    healthStatus.services.database = { status: 'error' };
  }

  // Check Redis
  if (redisConnected) {
    try {
      const redisStart = Date.now();
      await redisClient.ping();
      const redisLatency = Date.now() - redisStart;
      healthStatus.services.redis = {
        status: 'healthy',
        connected: true,
      };
      logger.info({ latency: redisLatency, requestId: req.requestId }, 'Redis health check passed');
    } catch (error) {
      healthStatus.services.redis = {
        status: 'unhealthy',
        connected: false,
      };
      healthStatus.status = 'degraded';
      logger.error({ error, requestId: req.requestId }, 'Redis health check failed');
    }
  } else {
    healthStatus.services.redis = {
      status: 'not configured',
      connected: false,
    };
  }

  const statusCode = healthStatus.status === 'ok' ? 200 : 503;
  const message = healthStatus.status === 'ok' ? 'Server hoạt động bình thường' : 'Server hoạt động không ổn định';
  const message_en = healthStatus.status === 'ok' ? 'Server is healthy' : 'Server is degraded';
  successResponse(res, statusCode, message, healthStatus, message_en);
});

// Login endpoint - returns JWT token and refresh token
/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Đăng nhập
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Đăng nhập thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Sai thông tin đăng nhập
 */
app.post('/api/auth/login', loginRateLimiter, async (req: Request, res: Response) => {
  const { email, password } = req.body;
  try {
    // In production, verify password hash
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    
    if (result.rows.length === 0) {
      logger.warn({ email, requestId: req.requestId }, 'Login failed: user not found');
      return unauthorized(res, 'Tên đăng nhập hoặc mật khẩu không chính xác', 'Invalid credentials');
    }
    
    const user = result.rows[0];
    const token = generateToken(user.id, user.tenant_id);
    const refreshToken = generateRefreshToken();
    
    // Store refresh token in database
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, tenant_id, token, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'7 days\')',
      [user.id, user.tenant_id, refreshToken]
    );
    
    logger.info({ userId: user.id, tenantId: user.tenant_id, requestId: req.requestId }, 'Login successful');
    successResponse(res, 200, 'Đăng nhập thành công', { token, refreshToken, user: { id: user.id, email: user.email, username: user.username, tenant_id: user.tenant_id } }, 'Login successful');
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Login error');
    internalServerError(res, error);
  }
});

// Register endpoint
/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Đăng ký tài khoản mới
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - username
 *               - password
 *               - tenantId
 *             properties:
 *               email:
 *                 type: string
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               tenantId:
 *                 type: string
 *                 format: uuid
 *                 description: ID của tenant (sẽ tạo mới nếu không có)
 *     responses:
 *       200:
 *         description: Đăng ký thành công
 *       400:
 *         description: Email hoặc username đã tồn tại
 */
app.post('/api/auth/register', async (req: Request, res: Response) => {
  const { email, username, password, tenantId } = req.body;
  
  if (!email || !username || !password) {
    return badRequest(res, 'Email, username và password là bắt buộc', 'Email, username and password are required');
  }
  
  try {
    // Check if email already exists
    const existingEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return badRequest(res, 'Email đã được sử dụng', 'Email already in use');
    }
    
    // Check if username already exists
    const existingUsername = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (existingUsername.rows.length > 0) {
      return badRequest(res, 'Username đã được sử dụng', 'Username already in use');
    }
    
    // Get or create tenant
    let finalTenantId = tenantId;
    if (!finalTenantId) {
      // Create default tenant
      const tenantResult = await pool.query(
        'INSERT INTO tenants (name, code) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING *',
        ['Public Tenant', 'public-tenant']
      );
      finalTenantId = tenantResult.rows[0].id;
    }
    
    // In production, hash password
    const passwordHash = password; // Should use bcrypt in production
    
    // Create user
    const result = await pool.query(
      'INSERT INTO users (tenant_id, email, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [finalTenantId, email, username, passwordHash]
    );
    
    logger.info({ userId: result.rows[0].id, tenantId: finalTenantId, requestId: req.requestId }, 'User registered successfully');
    successResponse(res, 200, 'Đăng ký thành công', { user: result.rows[0] }, 'Registration successful');
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Registration error');
    internalServerError(res, error);
  }
});

// Forgot password endpoint
/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Quên mật khẩu - gửi email reset
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: Đã gửi email reset mật khẩu
 *       404:
 *         description: Email không tồn tại
 */
app.post('/api/auth/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body;
  
  if (!email) {
    return badRequest(res, 'Email là bắt buộc', 'Email is required');
  }
  
  try {
    // Check if user exists
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      // For security, don't reveal if email exists or not
      return successResponse(res, 200, 'Nếu email tồn tại, bạn sẽ nhận được hướng dẫn reset mật khẩu', undefined, 'If email exists, you will receive password reset instructions');
    }
    
    const user = result.rows[0];
    
    // In production, generate reset token and send email
    // For now, just log it
    logger.info({ email, userId: user.id, requestId: req.requestId }, 'Password reset requested');
    
    // TODO: Implement email sending with reset token
    // const resetToken = crypto.randomBytes(32).toString('hex');
    // Store reset token in database with expiry
    // Send email with reset link
    
    return successResponse(res, 200, 'Nếu email tồn tại, bạn sẽ nhận được hướng dẫn reset mật khẩu', undefined, 'If email exists, you will receive password reset instructions');
  } catch (error) {
    logger.error({ error, email, requestId: req.requestId }, 'Forgot password error');
    internalServerError(res, error);
  }
});

// Refresh token endpoint
/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Làm mới access token bằng refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Làm mới token thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *       401:
 *         description: Refresh token không hợp lệ hoặc đã hết hạn
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/api/auth/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return unauthorized(res, 'Refresh token required', 'Refresh token required');
  }
  
  try {
    // Verify refresh token in database
    const result = await pool.query(
      'SELECT rt.*, u.id as user_id, u.tenant_id FROM refresh_tokens rt JOIN users u ON rt.user_id = u.id WHERE rt.token = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()',
      [refreshToken]
    );
    
    if (result.rows.length === 0) {
      logger.warn({ requestId: req.requestId }, 'Refresh token not found or expired');
      return unauthorized(res, 'Refresh token không hợp lệ hoặc đã hết hạn', 'Invalid or expired refresh token');
    }
    
    const tokenData = result.rows[0];
    
    // Generate new access token
    const newToken = generateToken(tokenData.user_id, tokenData.tenant_id);
    
    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1',
      [refreshToken]
    );
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, tenant_id, token, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL \'7 days\')',
      [tokenData.user_id, tokenData.tenant_id, newRefreshToken]
    );
    
    logger.info({ userId: tokenData.user_id, requestId: req.requestId }, 'Token refreshed successfully');
    successResponse(res, 200, 'Làm mới token thành công', { token: newToken, refreshToken: newRefreshToken }, 'Token refreshed successfully');
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Refresh token error');
    internalServerError(res, error);
  }
});

// Logout endpoint
/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: Đăng xuất và thu hồi refresh token
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Đăng xuất thành công
 *       401:
 *         description: Refresh token không hợp lệ
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/api/auth/logout', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  
  if (!refreshToken) {
    return unauthorized(res, 'Refresh token required', 'Refresh token required');
  }
  
  try {
    // Revoke the refresh token
    const result = await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1 AND revoked_at IS NULL',
      [refreshToken]
    );
    
    if (result.rowCount === 0) {
      logger.warn({ requestId: req.requestId }, 'Refresh token not found or already revoked');
      return unauthorized(res, 'Refresh token không hợp lệ', 'Invalid refresh token');
    }
    
    logger.info({ requestId: req.requestId }, 'Logout successful');
    successResponse(res, 200, 'Đăng xuất thành công', null, 'Logout successful');
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Logout error');
    internalServerError(res, error);
  }
});

// Generate presigned upload URL
/**
 * @swagger
 * /api/upload/presigned-url:
 *   post:
 *     summary: Tạo presigned URL để upload file
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileName
 *               - fileType
 *             properties:
 *               fileName:
 *                 type: string
 *               fileType:
 *                 type: string
 *                 description: Loại MIME của file
 *     responses:
 *       200:
 *         description: Đã tạo presigned URL thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 uploadUrl:
 *                   type: string
 *                 objectName:
 *                   type: string
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/upload/presigned-url', uploadRateLimiter, authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { fileName, fileType } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;
  
  if (!fileName || !fileType) {
    return badRequest(res, 'fileName và fileType là bắt buộc', 'fileName and fileType are required');
  }
  
  try {
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const objectName = `${tenantId}/${userId}/${timestamp}-${randomString}-${fileName}`;
    const uploadUrl = await generatePresignedUrl(objectName, 3600);
    
    logger.info({ objectName, tenantId, userId, requestId: req.requestId }, 'Presigned URL generated');
    successResponse(res, 200, 'Đã tạo presigned URL thành công', { uploadUrl, objectName }, 'Presigned URL generated successfully');
  } catch (error) {
    logger.error({ error, tenantId, userId, requestId: req.requestId }, 'Failed to generate presigned URL');
    internalServerError(res, error);
  }
});

// Generate presigned download URL
/**
 * @swagger
 * /api/upload/download-url:
 *   post:
 *     summary: Tạo presigned URL để download file
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - objectName
 *             properties:
 *               objectName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Đã tạo presigned download URL thành công
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 downloadUrl:
 *                   type: string
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/upload/download-url', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { objectName } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;
  
  if (!objectName) {
    return badRequest(res, 'objectName là bắt buộc', 'objectName is required');
  }
  
  try {
    // Verify object belongs to the user's tenant (security check)
    if (!objectName.startsWith(`${tenantId}/`)) {
      logger.warn({ objectName, tenantId, userId, requestId: req.requestId }, 'Unauthorized access attempt');
      return unauthorized(res, 'Access denied', 'Access denied');
    }
    
    const downloadUrl = await generatePresignedDownloadUrl(objectName, 3600);
    
    logger.info({ objectName, tenantId, userId, requestId: req.requestId }, 'Presigned download URL generated');
    successResponse(res, 200, 'Đã tạo presigned download URL thành công', { downloadUrl }, 'Presigned download URL generated successfully');
  } catch (error) {
    logger.error({ error, objectName, tenantId, userId, requestId: req.requestId }, 'Failed to generate download URL');
    internalServerError(res, error);
  }
});

// Payment webhook endpoint
/**
 * @swagger
 * /api/webhook/payment:
 *   post:
 *     summary: Webhook thanh toán cho Momo/Stripe
 *     tags: [Payment]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Xử lý webhook thành công
 *       401:
 *         description: Chữ ký không hợp lệ
 *       500:
 *         description: Lỗi server nội bộ
 */
app.post('/api/webhook/payment', async (req: Request, res: Response) => {
  const signature = req.headers['x-signature'] as string || req.headers['stripe-signature'] as string;
  const provider = req.headers['x-provider'] as string || 'momo'; // Default to momo
  
  if (!signature) {
    logger.warn({ requestId: req.requestId }, 'Payment webhook missing signature');
    return res.status(401).json({ error: 'Signature required' });
  }
  
  try {
    const secretKey = process.env.MOMO_SECRET_KEY || process.env.STRIPE_WEBHOOK_SECRET || '';
    
    // Verify signature
    let signatureValid = false;
    if (provider === 'stripe') {
      signatureValid = verifyStripeSignature(JSON.stringify(req.body), signature, secretKey);
    } else {
      signatureValid = verifyMomoSignature(req.body, signature, secretKey);
    }
    
    if (!signatureValid) {
      logger.warn({ provider, requestId: req.requestId }, 'Payment webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    // Extract tenant ID from webhook payload
    const tenantId = req.body.tenantId || req.body.metadata?.tenantId;
    const providerEventId = req.body.orderId || req.body.id || req.body.data?.object?.id;
    
    if (!tenantId || !providerEventId) {
      logger.warn({ provider, tenantId, providerEventId, requestId: req.requestId }, 'Payment webhook missing required fields');
      return badRequest(res, 'Missing tenantId or providerEventId', 'Missing tenantId or providerEventId');
    }
    
    // Process payment event with idempotency and rollback
    const result = await processPaymentEvent(pool, provider, providerEventId, req.body, tenantId);
    
    if (result.success) {
      logger.info({ provider, providerEventId, tenantId, requestId: req.requestId }, 'Payment webhook processed successfully');
      successResponse(res, 200, 'Xử lý webhook thành công', null, 'Webhook processed successfully');
    } else {
      logger.error({ provider, providerEventId, tenantId, requestId: req.requestId, error: result.error }, 'Payment webhook processing failed');
      internalServerError(res, result.error);
    }
  } catch (error) {
    logger.error({ error, provider, requestId: req.requestId }, 'Payment webhook error');
    internalServerError(res, error);
  }
});

// Get tenants
/**
 * @swagger
 * /api/tenants:
 *   get:
 *     summary: Lấy danh sách tất cả tenants
 *     tags: [Tenants]
 *     responses:
 *       200:
 *         description: Danh sách tenants
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Tenant'
 */
app.get('/api/tenants', async (req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    successResponse(res, 200, 'Lấy danh sách tenants thành công', result.rows, 'Tenants fetched successfully');
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Error fetching tenants');
    internalServerError(res, error);
  }
});

// Create tenant
/**
 * @swagger
 * /api/tenants:
 *   post:
 *     summary: Tạo tenant mới
 *     tags: [Tenants]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tạo tenant thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Tenant'
 */
app.post('/api/tenants', async (req: Request, res: Response) => {
  const { name } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING *',
      [name]
    );
    logger.info({ tenantId: result.rows[0].id, requestId: req.requestId }, 'Tenant created');
    successResponse(res, 200, 'Tạo tenant thành công', 'Tenant created successfully', result.rows[0]);
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Error creating tenant');
    internalServerError(res, error);
  }
});

// Get users for current tenant (requires auth)
/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Lấy danh sách users của tenant hiện tại
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/users', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE tenant_id = $1 ORDER BY created_at DESC', [req.tenantId]);
    successResponse(res, 200, 'Lấy danh sách users thành công', result.rows, 'Users fetched successfully');
  } catch (error) {
    logger.error({ error, tenantId: req.tenantId, requestId: req.requestId }, 'Error fetching users');
    internalServerError(res, error);
  }
});

// Create user
/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Tạo user mới
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tenant_id
 *               - email
 *               - username
 *               - password
 *             properties:
 *               tenant_id:
 *                 type: string
 *                 format: uuid
 *               email:
 *                 type: string
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Tạo user thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
app.post('/api/users', async (req: Request, res: Response) => {
  const { tenant_id, email, username, password } = req.body;
  try {
    // In production, hash password
    const result = await pool.query(
      'INSERT INTO users (tenant_id, email, username, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenant_id, email, username, password]
    );
    logger.info({ userId: result.rows[0].id, tenantId: tenant_id, requestId: req.requestId }, 'User created');
    successResponse(res, 200, 'Tạo user thành công', 'User created successfully', result.rows[0]);
  } catch (error) {
    logger.error({ error, requestId: req.requestId }, 'Error creating user');
    internalServerError(res, error);
  }
});

// Get or create direct conversation
/**
 * @swagger
 * /api/conversations/direct:
 *   post:
 *     summary: Tạo hoặc lấy conversation trực tiếp giữa 2 users
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *                 description: ID của user muốn chat
 *     responses:
 *       200:
 *         description: Conversation được tạo hoặc lấy thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Room'
 *       401:
 *         description: Chưa được xác thực
 *       404:
 *         description: User không tồn tại
 */
app.post('/api/conversations/direct', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { userId: targetUserId } = req.body;
  const currentUserId = req.userId;
  const tenantId = req.tenantId;

  if (!targetUserId) {
    return badRequest(res, 'userId là bắt buộc', 'userId is required');
  }

  if (targetUserId === currentUserId) {
    return badRequest(res, 'Không thể chat với chính mình', 'Cannot chat with yourself');
  }

  try {
    // Check if target user exists and belongs to same tenant
    const userResult = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND tenant_id = $2',
      [targetUserId, tenantId]
    );

    if (userResult.rows.length === 0) {
      return notFound(res, 'User không tồn tại', 'User not found');
    }

    // Check if direct conversation already exists
    const existingRoomResult = await pool.query(`
      SELECT r.* FROM rooms r
      WHERE r.tenant_id = $1
      AND r.type = 'direct'
      AND r.id IN (
        SELECT rm1.room_id FROM room_members rm1
        WHERE rm1.user_id = $2
        AND rm1.tenant_id = $1
        AND rm1.room_id IN (
          SELECT rm2.room_id FROM room_members rm2
          WHERE rm2.user_id = $3
          AND rm2.tenant_id = $1
        )
      )
    `, [tenantId, currentUserId, targetUserId]);

    if (existingRoomResult.rows.length > 0) {
      logger.info({ roomId: existingRoomResult.rows[0].id, currentUserId, targetUserId, requestId: req.requestId }, 'Existing direct conversation found');
      return successResponse(res, 200, 'Lấy conversation thành công', existingRoomResult.rows[0], 'Conversation retrieved successfully');
    }

    // Create new direct conversation
    const roomName = `direct_${currentUserId}_${targetUserId}`;
    const roomResult = await pool.query(
      'INSERT INTO rooms (tenant_id, name, type) VALUES ($1, $2, $3) RETURNING *',
      [tenantId, roomName, 'direct']
    );

    const roomId = roomResult.rows[0].id;

    // Add both users as members
    await pool.query(
      'INSERT INTO room_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)',
      [tenantId, roomId, currentUserId, targetUserId]
    );

    logger.info({ roomId, currentUserId, targetUserId, requestId: req.requestId }, 'Direct conversation created');
    successResponse(res, 200, 'Tạo conversation thành công', roomResult.rows[0], 'Conversation created successfully');
  } catch (error) {
    logger.error({ error, currentUserId, targetUserId, tenantId, requestId: req.requestId }, 'Error creating direct conversation');
    internalServerError(res, error);
  }
});

// Get user online status
/**
 * @swagger
 * /api/users/status:
 *   get:
 *     summary: Lấy trạng thái online của users
 *     tags: [Users]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userIds
 *         schema:
 *           type: array
 *           items:
 *             type: string
 *         description: Danh sách user IDs cần check status
 *     responses:
 *       200:
 *         description: Trạng thái online của users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 statuses:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       online:
 *                         type: boolean
 *                       lastSeen:
 *                         type: string
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/users/status', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { userIds } = req.query;
  const tenantId = req.tenantId;

  if (!userIds) {
    return badRequest(res, 'userIds là bắt buộc', 'userIds is required');
  }

  const userIdArray = Array.isArray(userIds) ? userIds : [userIds];

  try {
    const statuses: any = {};

    if (redisConnected) {
      // Get status from Redis
      for (const userId of userIdArray) {
        const presenceData = await redisClient.get(`presence:${userId}`);
        if (presenceData) {
          const parsed = JSON.parse(presenceData);
          statuses[userId as string] = {
            online: parsed.online,
            lastSeen: parsed.lastSeen
          };
        } else {
          statuses[userId as string] = {
            online: false,
            lastSeen: null
          };
        }
      }
    } else {
      // Fallback: check if user has recent messages (last 5 minutes)
      for (const userId of userIdArray) {
        const result = await pool.query(
          `SELECT created_at FROM messages 
           WHERE user_id = $1 AND tenant_id = $2 
           ORDER BY created_at DESC LIMIT 1`,
          [userId, tenantId]
        );

        if (result.rows.length > 0) {
          const lastActivity = new Date(result.rows[0].created_at);
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
          statuses[userId as string] = {
            online: lastActivity > fiveMinutesAgo,
            lastSeen: result.rows[0].created_at
          };
        } else {
          statuses[userId as string] = {
            online: false,
            lastSeen: null
          };
        }
      }
    }

    successResponse(res, 200, 'Lấy trạng thái thành công', { statuses }, 'User status fetched successfully');
  } catch (error) {
    logger.error({ error, tenantId, requestId: req.requestId }, 'Error fetching user status');
    internalServerError(res, error);
  }
});

// Create group chat
/**
 * @swagger
 * /api/groups:
 *   post:
 *     summary: Tạo nhóm chat mới
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - memberIds
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               memberIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: Danh sách user IDs để thêm vào nhóm
 *     responses:
 *       200:
 *         description: Tạo nhóm thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Room'
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/groups', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { name, description, memberIds } = req.body;
  const tenantId = req.tenantId;
  const creatorId = req.userId;

  if (!name || !memberIds || !Array.isArray(memberIds)) {
    return badRequest(res, 'name và memberIds là bắt buộc', 'name and memberIds are required');
  }

  try {
    // Create group room
    const roomResult = await pool.query(
      'INSERT INTO rooms (tenant_id, name, type, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenantId, name, 'group', description || null]
    );

    const roomId = roomResult.rows[0].id;

    // Add creator as admin member
    await pool.query(
      'INSERT INTO room_members (tenant_id, room_id, user_id, role) VALUES ($1, $2, $3, $4)',
      [tenantId, roomId, creatorId, 'admin']
    );

    // Add other members
    for (const memberId of memberIds) {
      if (memberId !== creatorId) {
        await pool.query(
          'INSERT INTO room_members (tenant_id, room_id, user_id, role) VALUES ($1, $2, $3, $4)',
          [tenantId, roomId, memberId, 'member']
        );
      }
    }

    logger.info({ roomId, creatorId, memberIds, tenantId, requestId: req.requestId }, 'Group chat created');
    successResponse(res, 200, 'Tạo nhóm thành công', roomResult.rows[0], 'Group created successfully');
  } catch (error) {
    logger.error({ error, tenantId, requestId: req.requestId }, 'Error creating group');
    internalServerError(res, error);
  }
});

// Add member to group
/**
 * @swagger
 * /api/groups/{groupId}/members:
 *   post:
 *     summary: Thêm thành viên vào nhóm
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userIds
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       200:
 *         description: Thêm thành viên thành công
 *       401:
 *         description: Chưa được xác thực
 *       403:
 *         description: Không có quyền
 */
app.post('/api/groups/:groupId/members', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const { userIds } = req.body;
  const tenantId = req.tenantId;
  const currentUserId = req.userId;

  if (!userIds || !Array.isArray(userIds)) {
    return badRequest(res, 'userIds là bắt buộc', 'userIds is required');
  }

  try {
    // Check if current user is admin of the group
    const adminResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3 AND role = $4',
      [groupId, currentUserId, tenantId, 'admin']
    );

    if (adminResult.rows.length === 0) {
      return forbidden(res, 'Chỉ admin mới có thể thêm thành viên', 'Only admins can add members');
    }

    // Add new members
    for (const userId of userIds) {
      await pool.query(
        'INSERT INTO room_members (tenant_id, room_id, user_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [tenantId, groupId, userId, 'member']
      );
    }

    logger.info({ groupId, userIds, currentUserId, tenantId, requestId: req.requestId }, 'Members added to group');
    successResponse(res, 200, 'Thêm thành viên thành công', null, 'Members added successfully');
  } catch (error) {
    logger.error({ error, groupId, tenantId, requestId: req.requestId }, 'Error adding members to group');
    internalServerError(res, error);
  }
});

// Remove member from group
/**
 * @swagger
 * /api/groups/{groupId}/members/{userId}:
 *   delete:
 *     summary: Xóa thành viên khỏi nhóm
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Xóa thành viên thành công
 *       401:
 *         description: Chưa được xác thực
 *       403:
 *         description: Không có quyền
 */
app.delete('/api/groups/:groupId/members/:userId', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { groupId, userId } = req.params;
  const tenantId = req.tenantId;
  const currentUserId = req.userId;

  try {
    // Check if current user is admin
    const adminResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3 AND role = $4',
      [groupId, currentUserId, tenantId, 'admin']
    );

    if (adminResult.rows.length === 0) {
      return forbidden(res, 'Chỉ admin mới có thể xóa thành viên', 'Only admins can remove members');
    }

    // Remove member
    await pool.query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [groupId, userId, tenantId]
    );

    logger.info({ groupId, userId, currentUserId, tenantId, requestId: req.requestId }, 'Member removed from group');
    successResponse(res, 200, 'Xóa thành viên thành công', null, 'Member removed successfully');
  } catch (error) {
    logger.error({ error, groupId, userId, tenantId, requestId: req.requestId }, 'Error removing member from group');
    internalServerError(res, error);
  }
});

// Update group info
/**
 * @swagger
 * /api/groups/{groupId}:
 *   patch:
 *     summary: Cập nhật thông tin nhóm
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       401:
 *         description: Chưa được xác thực
 *       403:
 *         description: Không có quyền
 */
app.patch('/api/groups/:groupId', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const { name, description } = req.body;
  const tenantId = req.tenantId;
  const currentUserId = req.userId;

  try {
    // Check if current user is admin
    const adminResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3 AND role = $4',
      [groupId, currentUserId, tenantId, 'admin']
    );

    if (adminResult.rows.length === 0) {
      return forbidden(res, 'Chỉ admin mới có thể cập nhật nhóm', 'Only admins can update group');
    }

    // Update room info
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    let paramCount = 1;

    if (name) {
      updateFields.push(`name = $${paramCount++}`);
      updateValues.push(name);
    }

    if (description !== undefined) {
      updateFields.push(`description = $${paramCount++}`);
      updateValues.push(description);
    }

    if (updateFields.length === 0) {
      return badRequest(res, 'Không có trường nào để cập nhật', 'No fields to update');
    }

    updateValues.push(groupId, tenantId);

    const result = await pool.query(
      `UPDATE rooms SET ${updateFields.join(', ')} WHERE id = $${paramCount++} AND tenant_id = $${paramCount} RETURNING *`,
      updateValues
    );

    logger.info({ groupId, currentUserId, tenantId, requestId: req.requestId }, 'Group info updated');
    successResponse(res, 200, 'Cập nhật nhóm thành công', result.rows[0], 'Group updated successfully');
  } catch (error) {
    logger.error({ error, groupId, tenantId, requestId: req.requestId }, 'Error updating group info');
    internalServerError(res, error);
  }
});

// Add message reaction
/**
 * @swagger
 * /api/messages/{messageId}/reactions:
 *   post:
 *     summary: Thêm reaction vào tin nhắn
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - emoji
 *             properties:
 *               emoji:
 *                 type: string
 *                 description: Emoji reaction (😀, ❤️, 👍, etc.)
 *     responses:
 *       200:
 *         description: Thêm reaction thành công
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/messages/:messageId/reactions', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { messageId } = req.params;
  const { emoji } = req.body;
  const userId = req.userId;
  const tenantId = req.tenantId;

  if (!emoji) {
    return badRequest(res, 'emoji là bắt buộc', 'emoji is required');
  }

  try {
    // Check if message exists and belongs to tenant
    const messageResult = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2',
      [messageId, tenantId]
    );

    if (messageResult.rows.length === 0) {
      return notFound(res, 'Tin nhắn không tồn tại', 'Message not found');
    }

    // Check if reaction already exists
    const existingReaction = await pool.query(
      'SELECT * FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, userId, emoji]
    );

    if (existingReaction.rows.length > 0) {
      // Remove reaction if it exists (toggle)
      await pool.query(
        'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, userId, emoji]
      );
      logger.info({ messageId, userId, emoji, requestId: req.requestId }, 'Reaction removed');
      return successResponse(res, 200, 'Xóa reaction thành công', null, 'Reaction removed successfully');
    }

    // Add new reaction
    await pool.query(
      'INSERT INTO message_reactions (tenant_id, message_id, user_id, emoji) VALUES ($1, $2, $3, $4)',
      [tenantId, messageId, userId, emoji]
    );

    logger.info({ messageId, userId, emoji, requestId: req.requestId }, 'Reaction added');
    successResponse(res, 200, 'Thêm reaction thành công', null, 'Reaction added successfully');
  } catch (error) {
    logger.error({ error, messageId, tenantId, requestId: req.requestId }, 'Error adding reaction');
    internalServerError(res, error);
  }
});

// Reply to message
/**
 * @swagger
 * /api/messages/{messageId}/reply:
 *   post:
 *     summary: Trả lời tin nhắn
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - roomId
 *               - content
 *             properties:
 *               roomId:
 *                 type: string
 *                 format: uuid
 *               content:
 *                 type: string
 *               clientMessageId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Trả lời thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/messages/:messageId/reply', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { messageId } = req.params;
  const { roomId, content, clientMessageId } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!roomId || !content) {
    return badRequest(res, 'roomId và content là bắt buộc', 'roomId and content are required');
  }

  try {
    // Check if original message exists
    const originalMessageResult = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2',
      [messageId, tenantId]
    );

    if (originalMessageResult.rows.length === 0) {
      return notFound(res, 'Tin nhắn gốc không tồn tại', 'Original message not found');
    }

    // Check for duplicate
    if (clientMessageId) {
      const existingMessage = await pool.query(
        'SELECT id FROM messages WHERE client_message_id = $1',
        [clientMessageId]
      );
      if (existingMessage.rows.length > 0) {
        return badRequest(res, 'Tin nhắn trùng lặp', 'Duplicate message');
      }
    }

    // Create reply message
    const result = await pool.query(
      `INSERT INTO messages (tenant_id, room_id, user_id, content, client_message_id, reply_to_message_id) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tenantId, roomId, userId, content, clientMessageId, messageId]
    );

    const message = result.rows[0];

    // Emit to room via Socket.IO
    io.to(`room:${roomId as string}`).emit('newMessage', {
      id: message.id,
      room_id: message.room_id,
      user_id: message.user_id,
      content: message.content,
      created_at: message.created_at,
      reply_to_message_id: message.reply_to_message_id
    });

    logger.info({ messageId: message.id, replyTo: messageId, roomId, userId, tenantId, requestId: req.requestId }, 'Reply sent');
    successResponse(res, 200, 'Trả lời thành công', message, 'Reply sent successfully');
  } catch (error) {
    logger.error({ error, messageId, tenantId, requestId: req.requestId }, 'Error sending reply');
    internalServerError(res, error);
  }
});

// Get message reactions
/**
 * @swagger
 * /api/messages/{messageId}/reactions:
 *   get:
 *     summary: Lấy danh sách reactions của tin nhắn
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Danh sách reactions
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/messages/:messageId/reactions', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { messageId } = req.params;
  const tenantId = req.tenantId;

  try {
    const result = await pool.query(
      `SELECT mr.*, u.username, u.email 
       FROM message_reactions mr 
       JOIN users u ON mr.user_id = u.id 
       WHERE mr.message_id = $1 AND mr.tenant_id = $2`,
      [messageId, tenantId]
    );

    successResponse(res, 200, 'Lấy reactions thành công', result.rows, 'Reactions fetched successfully');
  } catch (error) {
    logger.error({ error, messageId, tenantId, requestId: req.requestId }, 'Error fetching reactions');
    internalServerError(res, error);
  }
});

// Mark messages as read
/**
 * @swagger
 * /api/rooms/{roomId}/read:
 *   post:
 *     summary: Đánh dấu tin nhắn đã đọc
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - messageId
 *             properties:
 *               messageId:
 *                 type: string
 *                 format: uuid
 *                 description: ID của tin nhắn cuối cùng đã đọc
 *     responses:
 *       200:
 *         description: Đánh dấu đã đọc thành công
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/rooms/:roomId/read', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const { messageId } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!messageId) {
    return badRequest(res, 'messageId là bắt buộc', 'messageId is required');
  }

  try {
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );

    if (memberResult.rows.length === 0) {
      return forbidden(res, 'Bạn không phải thành viên của phòng này', 'You are not a member of this room');
    }

    // Update or insert read receipt
    await pool.query(
      `INSERT INTO message_reads (tenant_id, room_id, user_id, last_read_message_id, read_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (room_id, user_id) 
       DO UPDATE SET 
         last_read_message_id = EXCLUDED.last_read_message_id,
         read_at = NOW()`,
      [tenantId, roomId, userId, messageId]
    );

    // Broadcast read status to room
    io.to(`room:${roomId as string}`).emit('message-read', { userId, roomId, messageId });

    logger.info({ roomId, userId, messageId, tenantId, requestId: req.requestId }, 'Messages marked as read');
    successResponse(res, 200, 'Đánh dấu đã đọc thành công', null, 'Messages marked as read successfully');
  } catch (error) {
    logger.error({ error, roomId, userId, tenantId, requestId: req.requestId }, 'Error marking messages as read');
    internalServerError(res, error);
  }
});

// Get read receipts for a room
/**
 * @swagger
 * /api/rooms/{roomId}/read-receipts:
 *   get:
 *     summary: Lấy trạng thái đã đọc của thành viên trong phòng
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Trạng thái đã đọc
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/rooms/:roomId/read-receipts', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const tenantId = req.tenantId;
  const userId = req.userId;

  try {
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );

    if (memberResult.rows.length === 0) {
      return forbidden(res, 'Bạn không phải thành viên của phòng này', 'You are not a member of this room');
    }

    // Get read receipts
    const result = await pool.query(
      `SELECT mr.*, u.username, u.email 
       FROM message_reads mr 
       JOIN users u ON mr.user_id = u.id 
       WHERE mr.room_id = $1 AND mr.tenant_id = $2`,
      [roomId, tenantId]
    );

    successResponse(res, 200, 'Lấy read receipts thành công', result.rows, 'Read receipts fetched successfully');
  } catch (error) {
    logger.error({ error, roomId, tenantId, requestId: req.requestId }, 'Error fetching read receipts');
    internalServerError(res, error);
  }
});

// Search messages
/**
 * @swagger
 * /api/messages/search:
 *   get:
 *     summary: Tìm kiếm tin nhắn
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Từ khóa tìm kiếm
 *       - in: query
 *         name: roomId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: ID phòng (optional - nếu không có sẽ tìm trong tất cả phòng)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Số lượng kết quả
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset
 *     responses:
 *       200:
 *         description: Kết quả tìm kiếm
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/messages/search', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { query, roomId, limit = 50, offset = 0 } = req.query;
  const tenantId = req.tenantId;
  const userId = req.userId;

  if (!query) {
    return badRequest(res, 'query là bắt buộc', 'query is required');
  }

  try {
    let sql = `
      SELECT m.*, r.name as room_name, u.username as sender_username
      FROM messages m
      JOIN rooms r ON m.room_id = r.id
      JOIN users u ON m.user_id = u.id
      WHERE m.tenant_id = $1
      AND m.content ILIKE $2
    `;
    const params: any[] = [tenantId, `%${query}%`];
    let paramCount = 3;

    // Filter by room if specified
    if (roomId) {
      // Verify user is member of the room
      const memberResult = await pool.query(
        'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
        [roomId, userId, tenantId]
      );

      if (memberResult.rows.length === 0) {
        return forbidden(res, 'Bạn không phải thành viên của phòng này', 'You are not a member of this room');
      }

      sql += ` AND m.room_id = $${paramCount++}`;
      params.push(roomId);
    } else {
      // Search only in rooms where user is a member
      sql += ` AND m.room_id IN (
        SELECT rm.room_id FROM room_members rm WHERE rm.user_id = $${paramCount++} AND rm.tenant_id = $1
      )`;
      params.push(userId);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit as string), parseInt(offset as string));

    const result = await pool.query(sql, params);

    successResponse(res, 200, 'Tìm kiếm thành công', { messages: result.rows, total: result.rows.length }, 'Search completed successfully');
  } catch (error) {
    logger.error({ error, query, tenantId, requestId: req.requestId }, 'Error searching messages');
    internalServerError(res, error);
  }
});

// Get message reactions
/**
 * @swagger
 * /api/rooms/{roomId}/read-receipts:
 *   get:
 *     summary: Lấy trạng thái đã đọc của thành viên trong phòng
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Trạng thái đã đọc
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/rooms/:roomId/read-receipts', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const tenantId = req.tenantId;
  const userId = req.userId;

  try {
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );

    if (memberResult.rows.length === 0) {
      return forbidden(res, 'Bạn không phải thành viên của phòng này', 'You are not a member of this room');
    }

    // Get read receipts
    const result = await pool.query(
      `SELECT mr.*, u.username, u.email 
       FROM message_reads mr 
       JOIN users u ON mr.user_id = u.id 
       WHERE mr.room_id = $1 AND mr.tenant_id = $2`,
      [roomId, tenantId]
    );

    successResponse(res, 200, 'Lấy read receipts thành công', result.rows, 'Read receipts fetched successfully');
  } catch (error) {
    logger.error({ error, roomId, tenantId, requestId: req.requestId }, 'Error fetching read receipts');
    internalServerError(res, error);
  }
});

// Get message reactions
/**
 * @swagger
 * /api/messages/{messageId}/reactions:
 *   get:
 *     summary: Lấy danh sách reactions của tin nhắn
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Danh sách reactions
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/messages/:messageId/reactions', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { messageId } = req.params;
  const tenantId = req.tenantId;

  try {
    const result = await pool.query(
      `SELECT mr.*, u.username, u.email 
       FROM message_reactions mr 
       JOIN users u ON mr.user_id = u.id 
       WHERE mr.message_id = $1 AND mr.tenant_id = $2`,
      [messageId, tenantId]
    );

    successResponse(res, 200, 'Lấy reactions thành công', result.rows, 'Reactions fetched successfully');
  } catch (error) {
    logger.error({ error, messageId, tenantId, requestId: req.requestId }, 'Error fetching reactions');
    internalServerError(res, error);
  }
});

// Update group info
/**
 * @swagger
 * /api/groups/{groupId}:
 *   patch:
 *     summary: Cập nhật thông tin nhóm
 *     tags: [Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Cập nhật thành công
 *       401:
 *         description: Chưa được xác thực
 *       403:
 *         description: Không có quyền
 */
app.patch('/api/groups/:groupId', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { groupId } = req.params;
  const { name, description } = req.body;
  const tenantId = req.tenantId;
  const currentUserId = req.userId;

  try {
    // Check if current user is admin
    const adminResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3 AND role = $4',
      [groupId, currentUserId, tenantId, 'admin']
    );

    if (adminResult.rows.length === 0) {
      return forbidden(res, 'Chỉ admin mới có thể cập nhật nhóm', 'Only admins can update group');
    }

    // Update room info
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    let paramCount = 1;

    if (name) {
      updateFields.push(`name = $${paramCount++}`);
      updateValues.push(name);
    }

    if (description !== undefined) {
      updateFields.push(`description = $${paramCount++}`);
      updateValues.push(description);
    }

    if (updateFields.length === 0) {
      return badRequest(res, 'Không có trường nào để cập nhật', 'No fields to update');
    }

    updateValues.push(groupId, tenantId);

    const result = await pool.query(
      `UPDATE rooms SET ${updateFields.join(', ')} WHERE id = $${paramCount++} AND tenant_id = $${paramCount} RETURNING *`,
      updateValues
    );

    logger.info({ groupId, currentUserId, tenantId, requestId: req.requestId }, 'Group info updated');
    successResponse(res, 200, 'Cập nhật nhóm thành công', result.rows[0], 'Group updated successfully');
  } catch (error) {
    logger.error({ error, groupId, tenantId, requestId: req.requestId }, 'Error updating group info');
    internalServerError(res, error);
  }
});

// Create room
/**
 * @swagger
 * /api/rooms:
 *   post:
 *     summary: Tạo phòng mới
 *     tags: [Rooms]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [direct, group]
 *     responses:
 *       200:
 *         description: Tạo phòng thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Room'
 *       401:
 *         description: Chưa được xác thực
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/api/rooms', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { name, type } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;
  
  try {
    const result = await pool.query(
      'INSERT INTO rooms (tenant_id, name, type, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenantId, name, type, userId]
    );
    
    // Add creator as member
    await pool.query(
      'INSERT INTO room_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3)',
      [tenantId, result.rows[0].id, userId]
    );
    
    logger.info({ roomId: result.rows[0].id, tenantId, userId, requestId: req.requestId }, 'Room created');
    successResponse(res, 200, 'Tạo phòng thành công', result.rows[0], 'Room created successfully');
  } catch (error) {
    logger.error({ error, tenantId, requestId: req.requestId }, 'Error creating room');
    internalServerError(res, error);
  }
});

// Get rooms
/**
 * @swagger
 * /api/rooms:
 *   get:
 *     summary: Lấy danh sách phòng của tenant hiện tại
 *     tags: [Rooms]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách phòng
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Room'
 *       401:
 *         description: Chưa được xác thực
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/api/rooms', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const tenantId = req.tenantId;
  
  try {
    const result = await pool.query(
      'SELECT r.* FROM rooms r JOIN room_members rm ON r.id = rm.room_id WHERE r.tenant_id = $1 AND rm.user_id = $2 ORDER BY r.created_at DESC',
      [tenantId, req.userId]
    );
    successResponse(res, 200, 'Lấy danh sách phòng thành công', result.rows, 'Rooms fetched successfully');
  } catch (error) {
    logger.error({ error, tenantId, requestId: req.requestId }, 'Error fetching rooms');
    internalServerError(res, error);
  }
});

// Add member to room
/**
 * @swagger
 * /api/rooms/{roomId}/members:
 *   post:
 *     summary: Thêm thành viên vào phòng
 *     tags: [Rooms]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *             properties:
 *               userId:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Thêm thành viên thành công
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/rooms/:roomId/members', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const { userId } = req.body;
  const tenantId = req.tenantId;
  
  try {
    const result = await pool.query(
      'INSERT INTO room_members (tenant_id, room_id, user_id) VALUES ($1, $2, $3) RETURNING *',
      [tenantId, roomId, userId]
    );
    logger.info({ roomId, userId, tenantId, requestId: req.requestId }, 'Member added to room');
    successResponse(res, 200, 'Thêm thành viên thành công', result.rows[0], 'Member added successfully');
  } catch (error) {
    logger.error({ error, roomId, userId, tenantId, requestId: req.requestId }, 'Error adding member to room');
    internalServerError(res, error);
  }
});

// Get messages
/**
 * @swagger
 * /api/rooms/{roomId}/messages:
 *   get:
 *     summary: Lấy tin nhắn trong phòng với phân trang cursor-based
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Con trỏ cho phân trang (ID tin nhắn)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Danh sách tin nhắn
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 messages:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Message'
 *                 nextCursor:
 *                   type: string
 *                 hasMore:
 *                   type: boolean
 *       401:
 *         description: Chưa được xác thực
 */
app.get('/api/rooms/:roomId/messages', authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const { cursor, limit = 50 } = req.query;
  
  try {
    let query = `
      SELECT * FROM messages 
      WHERE room_id = $1
    `;
    const params: any[] = [roomId];
    
    if (cursor) {
      query += ' AND id < $2';
      params.push(cursor);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limit as string));
    
    const result = await pool.query(query, params);
    
    const messages = result.rows.reverse();
    const nextCursor = messages.length > 0 ? messages[messages.length - 1].id : null;
    const hasMore = messages.length === parseInt(limit as string);
    
    successResponse(res, 200, 'Lấy tin nhắn thành công', { messages, nextCursor, hasMore }, 'Messages fetched successfully');
  } catch (error) {
    logger.error({ error, roomId, requestId: req.requestId }, 'Error fetching messages');
    internalServerError(res, error);
  }
});

// Send message
/**
 * @swagger
 * /api/rooms/{roomId}/messages:
 *   post:
 *     summary: Gửi tin nhắn đến phòng
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: roomId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *               clientMessageId:
 *                 type: string
 *                 description: ID tin nhắn được tạo bởi client để chống trùng lặp
 *     responses:
 *       200:
 *         description: Gửi tin nhắn thành công
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       401:
 *         description: Chưa được xác thực
 */
app.post('/api/rooms/:roomId/messages', messageRateLimiter, authenticateToken(pool), async (req: AuthRequest, res: Response) => {
  const { roomId } = req.params;
  const { content, clientMessageId } = req.body;
  const tenantId = req.tenantId;
  const userId = req.userId;
  
  try {
    // Check for duplicate message
    if (clientMessageId) {
      const existingMessage = await pool.query(
        'SELECT id FROM messages WHERE client_message_id = $1',
        [clientMessageId]
      );
      if (existingMessage.rows.length > 0) {
        logger.warn({ clientMessageId, requestId: req.requestId }, 'Duplicate message detected');
        return badRequest(res, 'Tin nhắn trùng lặp', 'Duplicate message');
      }
    }
    
    const result = await pool.query(
      'INSERT INTO messages (tenant_id, room_id, user_id, content, client_message_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [tenantId, roomId, userId, content, clientMessageId]
    );
    
    const message = result.rows[0];
    
    // Emit to room via Socket.IO
    io.to(`room:${roomId as string}`).emit('newMessage', {
      id: message.id,
      room_id: message.room_id,
      user_id: message.user_id,
      content: message.content,
      created_at: message.created_at,
      client_message_id: message.client_message_id
    });
    
    logger.info({ messageId: message.id, roomId, userId, tenantId, requestId: req.requestId }, 'Message sent');
    successResponse(res, 200, 'Gửi tin nhắn thành công', message, 'Message sent successfully');
  } catch (error) {
    logger.error({ error, roomId, userId, tenantId, requestId: req.requestId }, 'Error sending message');
    internalServerError(res, error);
  }
});

// Socket.io connection with presence system
io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Client connected');

  socket.on('join-tenant', async (tenantId: string) => {
    socket.join(`tenant:${tenantId}`);
    logger.info({ socketId: socket.id, tenantId }, 'Socket joined tenant');
  });

  socket.on('join-room', async (data: { roomId: string; userId: string; tenantId: string }) => {
    const { roomId, userId, tenantId } = data;
    
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );
    
    if (memberResult.rows.length === 0) {
      logger.warn({ socketId: socket.id, roomId, userId }, 'Unauthorized room join attempt');
      return;
    }
    
    socket.join(`room:${roomId}`);
    
    // Set user as online in Redis (if connected)
    if (redisConnected) {
      await redisClient.setEx(
        `presence:${userId}`,
        300, // 5 minutes TTL
        JSON.stringify({ userId, online: true, lastSeen: new Date().toISOString() })
      );
      
      // Broadcast to room that user is online
      io.to(`room:${roomId as string}`).emit('user-online', { userId });
    }
    
    logger.info({ socketId: socket.id, roomId, userId }, 'Socket joined room');
  });

  // Typing indicators
  socket.on('typing-start', async (data: { roomId: string; userId: string; tenantId: string }) => {
    const { roomId, userId, tenantId } = data;
    
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );
    
    if (memberResult.rows.length === 0) {
      return;
    }
    
    // Broadcast typing status to room (excluding sender)
    socket.to(`room:${roomId as string}`).emit('user-typing', { userId, roomId });
    
    logger.debug({ socketId: socket.id, roomId, userId }, 'User started typing');
  });

  socket.on('typing-stop', async (data: { roomId: string; userId: string; tenantId: string }) => {
    const { roomId, userId, tenantId } = data;
    
    // Verify user is member of the room
    const memberResult = await pool.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2 AND tenant_id = $3',
      [roomId, userId, tenantId]
    );
    
    if (memberResult.rows.length === 0) {
      return;
    }
    
    // Broadcast stop typing status to room (excluding sender)
    socket.to(`room:${roomId as string}`).emit('user-stop-typing', { userId, roomId });
    
    logger.debug({ socketId: socket.id, roomId, userId }, 'User stopped typing');
  });

  socket.on('send-message', async (data: { roomId: string; message: string; userId: string; tenantId: string; clientMessageId: string }) => {
    try {
      // Save message to database
      const result = await pool.query(
        `INSERT INTO messages (tenant_id, room_id, user_id, content, client_message_id) 
         VALUES ($1, $2, $3, $4, $5) 
         ON CONFLICT (tenant_id, room_id, client_message_id) DO NOTHING 
         RETURNING *`,
        [data.tenantId, data.roomId, data.userId, data.message, data.clientMessageId]
      );
      
      if (result.rows.length > 0) {
        const message = result.rows[0];
        
        // Broadcast to room
        io.to(`room:${data.roomId as string}`).emit('message', {
          id: message.id,
          user_id: message.user_id,
          content: message.content,
          created_at: message.created_at
        });
        
        // Queue notification (if Redis is connected)
        if (notificationQueue) {
          await notificationQueue.add('push-notification', {
            userId: data.userId,
            message: data.message,
            roomId: data.roomId,
            messageId: message.id
          }, {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 1000,
            },
          });
        }
        
        logger.info({ messageId: message.id, socketId: socket.id, roomId: data.roomId }, 'Message sent via socket');
      }
    } catch (error) {
      logger.error({ error, socketId: socket.id, roomId: data.roomId }, 'Error sending message via socket');
    }
  });

  socket.on('get-presence', async (userIds: string[]) => {
    if (!redisConnected) {
      socket.emit('presence-data', {});
      return;
    }
    
    const presenceData: Record<string, any> = {};
    
    for (const userId of userIds) {
      const presence = await redisClient.get(`presence:${userId}`);
      presenceData[userId] = presence ? JSON.parse(presence) : { online: false };
    }
    
    socket.emit('presence-data', presenceData);
  });

  socket.on('disconnect', async () => {
    logger.info({ socketId: socket.id }, 'Client disconnected');
    
    // Note: In production, you might want to track which rooms the user was in
    // and update presence accordingly. For simplicity, we'll let Redis TTL handle cleanup.
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server started');
  console.log('\n🚀 Backend running:');
  console.log(`   API: http://localhost:${PORT}`);
  console.log(`   Swagger Docs: http://localhost:${PORT}/api-docs`);
  console.log(`   Health Check: http://localhost:${PORT}/health`);
  console.log('');
});
