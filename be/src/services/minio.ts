import { Client } from 'minio';
import { logger } from '../utils/logger';

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT?.replace('http://', '').replace('https://', '').split(':')[0] || 'localhost',
  port: parseInt(process.env.MINIO_ENDPOINT?.split(':')[1] || '9000'),
  useSSL: process.env.MINIO_ENDPOINT?.startsWith('https') || false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin123',
});

const BUCKET_NAME = process.env.MINIO_BUCKET || 'chat-uploads';

// Initialize bucket on startup
export async function initializeBucket() {
  try {
    const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
    if (!bucketExists) {
      await minioClient.makeBucket(BUCKET_NAME);
      logger.info({ bucket: BUCKET_NAME }, 'MinIO bucket created');
      
      // Set bucket policy to allow public read access (for presigned URLs)
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`],
          },
        ],
      };
      await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
      logger.info({ bucket: BUCKET_NAME }, 'MinIO bucket policy set');
    } else {
      logger.info({ bucket: BUCKET_NAME }, 'MinIO bucket already exists');
    }
  } catch (error) {
    logger.error({ error, bucket: BUCKET_NAME }, 'Failed to initialize MinIO bucket');
  }
}

export async function generatePresignedUrl(objectName: string, expiry: number = 3600): Promise<string> {
  try {
    const url = await minioClient.presignedPutObject(BUCKET_NAME, objectName, expiry);
    logger.info({ objectName, expiry }, 'Presigned URL generated');
    return url;
  } catch (error) {
    logger.error({ error, objectName }, 'Failed to generate presigned URL');
    throw error;
  }
}

export async function generatePresignedDownloadUrl(objectName: string, expiry: number = 3600): Promise<string> {
  try {
    const url = await minioClient.presignedGetObject(BUCKET_NAME, objectName, expiry);
    logger.info({ objectName, expiry }, 'Presigned download URL generated');
    return url;
  } catch (error) {
    logger.error({ error, objectName }, 'Failed to generate presigned download URL');
    throw error;
  }
}

export async function deleteObject(objectName: string): Promise<void> {
  try {
    await minioClient.removeObject(BUCKET_NAME, objectName);
    logger.info({ objectName }, 'Object deleted from MinIO');
  } catch (error) {
    logger.error({ error, objectName }, 'Failed to delete object from MinIO');
    throw error;
  }
}

export async function getObjectMetadata(objectName: string): Promise<any> {
  try {
    const stat = await minioClient.statObject(BUCKET_NAME, objectName);
    return stat;
  } catch (error) {
    logger.error({ error, objectName }, 'Failed to get object metadata');
    throw error;
  }
}
