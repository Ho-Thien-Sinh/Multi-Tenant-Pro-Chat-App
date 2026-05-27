import crypto from 'crypto';
import { Pool } from 'pg';
import { logger } from '../utils/logger';

// Momo signature verification
export function verifyMomoSignature(data: any, signature: string, secretKey: string): boolean {
  // Momo uses HMAC SHA256
  const rawData = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('&');
  
  const computedSignature = crypto
    .createHmac('sha256', secretKey)
    .update(rawData)
    .digest('hex');
  
  return computedSignature === signature;
}

// Stripe signature verification
export function verifyStripeSignature(payload: string, signature: string, secretKey: string): boolean {
  const hmac = crypto.createHmac('sha256', secretKey);
  const digest = hmac.update(payload).digest('hex');
  
  // Stripe signature format: t=timestamp,v1=signature
  const [timestamp, v1] = signature.split(',');
  const expectedSignature = `t=${timestamp},v1=${digest}`;
  
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

// Process payment event with idempotency and rollback
export async function processPaymentEvent(
  pool: Pool,
  provider: string,
  providerEventId: string,
  payload: any,
  tenantId: string
): Promise<{ success: boolean; error?: string }> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Check for idempotency
    const existingEvent = await client.query(
      'SELECT * FROM payment_events WHERE provider = $1 AND provider_event_id = $2',
      [provider, providerEventId]
    );
    
    if (existingEvent.rows.length > 0) {
      logger.info({ provider, providerEventId, tenantId }, 'Payment event already processed (idempotent)');
      await client.query('ROLLBACK');
      return { success: true };
    }
    
    // Record payment event
    const eventResult = await client.query(
      `INSERT INTO payment_events (tenant_id, provider, provider_event_id, status, raw_payload)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id`,
      [tenantId, provider, providerEventId, JSON.stringify(payload)]
    );
    
    const eventId = eventResult.rows[0].id;
    
    // Process subscription based on payment status
    const paymentStatus = payload.status || payload.resultCode === '0' ? 'success' : 'failed';
    
    if (paymentStatus === 'success') {
      // Update subscription
      const subscriptionData = extractSubscriptionData(provider, payload);
      
      await client.query(
        `UPDATE subscriptions 
         SET status = 'active', 
             start_at = COALESCE($2, start_at),
             end_at = COALESCE($3, end_at)
         WHERE tenant_id = $1`,
        [tenantId, subscriptionData.startDate, subscriptionData.endDate]
      );
      
      // Mark event as successful
      await client.query(
        'UPDATE payment_events SET status = $1, processed_at = NOW() WHERE id = $2',
        ['success', eventId]
      );
      
      logger.info({ eventId, provider, tenantId }, 'Payment processed successfully');
    } else {
      // Mark event as failed
      await client.query(
        'UPDATE payment_events SET status = $1, processed_at = NOW() WHERE id = $2',
        ['failed', eventId]
      );
      
      logger.warn({ eventId, provider, tenantId, paymentStatus }, 'Payment failed');
    }
    
    await client.query('COMMIT');
    return { success: true };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ error, provider, providerEventId, tenantId }, 'Payment processing failed, rolled back');
    return { success: false, error: 'Payment processing failed' };
  } finally {
    client.release();
  }
}

// Extract subscription data from different provider formats
function extractSubscriptionData(provider: string, payload: any): { startDate?: Date; endDate?: Date } {
  const result: { startDate?: Date; endDate?: Date } = {};
  
  if (provider === 'momo') {
    // Momo format
    if (payload.requestTime) {
      result.startDate = new Date(payload.requestTime);
    }
    if (payload.transDate) {
      result.endDate = new Date(payload.transDate);
    }
  } else if (provider === 'stripe') {
    // Stripe format
    if (payload.created) {
      result.startDate = new Date(payload.created * 1000);
    }
    if (payload.period?.end) {
      result.endDate = new Date(payload.period.end * 1000);
    }
  }
  
  return result;
}
