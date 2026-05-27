# Sequence Diagrams - Multi-Tenant Pro Chat App

## 1. Send Message Flow

```mermaid
sequenceDiagram
    participant Client
    participant API as API Gateway
    participant Auth as JWT Middleware
    participant DB as PostgreSQL
    participant Queue as BullMQ
    participant Worker as Notification Worker
    participant Socket as Socket.io
    participant Redis as Redis (Presence)

    Client->>API: POST /api/rooms/:roomId/messages
    Note over Client,API: Headers: Authorization: Bearer <token>
    
    API->>Auth: Verify JWT token
    Auth->>Auth: Decode tenant_id, user_id
    Auth->>DB: SELECT set_tenant_context(tenant_id)
    
    Auth->>API: Pass with req.userId, req.tenantId
    
    API->>API: Check rate limit (30 msg/min)
    
    API->>DB: SELECT * FROM messages WHERE tenant_id=? AND room_id=? AND client_message_id=?
    DB-->>API: Check for duplicate
    
    alt Duplicate exists
        DB-->>API: Return existing message
        API-->>Client: 200 OK (existing message)
    else No duplicate
        API->>DB: INSERT INTO messages (tenant_id, room_id, sender_id, content, client_message_id)
        DB-->>API: Message created
        
        API->>Queue: Add notification job
        Note over API,Queue: Async - non-blocking
        
        API-->>Client: 200 OK (new message)
        
        Queue->>Worker: Process job
        Worker->>Worker: Generate push notification
        Worker-->>Queue: Job completed
        Note over Worker: Log success/failure
        
        Socket->>Socket: Broadcast to room:roomId
        Socket->>Redis: Update presence if needed
    end
```

## 2. WebSocket Join Room Flow

```mermaid
sequenceDiagram
    participant Client
    participant Socket as Socket.io
    participant Auth as JWT Middleware
    participant DB as PostgreSQL
    participant Redis as Redis (Presence)

    Client->>Socket: connect()
    Socket-->>Client: connection established
    
    Client->>Socket: emit('join-tenant', { tenantId })
    Socket->>Socket: socket.join(`tenant:${tenantId}`)
    Socket-->>Client: Joined tenant room
    
    Client->>Socket: emit('join-room', { roomId, userId })
    Socket->>Socket: socket.join(`room:${roomId}`)
    
    Socket->>Redis: SET presence:{userId}
    Note over Socket,Redis: TTL: 5 minutes<br/>{ userId, online: true, lastSeen }
    
    Socket->>Socket: emit('user-online', { userId })
    Socket->>Socket: Broadcast to room:roomId
    
    Client->>Socket: emit('get-presence', [userIds])
    Socket->>Redis: GET presence:{userId} for each userId
    Redis-->>Socket: Presence data
    Socket-->>Client: emit('presence-data', presenceData)
    
    Client->>Socket: disconnect()
    Note over Client,Socket: Redis TTL handles cleanup<br/>or explicit logout
```

## 3. Payment Webhook Flow

```mermaid
sequenceDiagram
    participant Provider as Payment Provider<br/>(Momo/Stripe)
    participant API as Webhook Endpoint
    participant Auth as Signature Verification
    participant DB as PostgreSQL
    participant Sub as Subscription Service
    participant Queue as BullMQ

    Provider->>API: POST /api/webhook/payment
    Note over Provider,API: HMAC signature header
    
    API->>Auth: Verify signature
    Auth->>Auth: Compute HMAC from raw payload
    Auth->>Auth: Compare with signature header
    
    alt Invalid signature
        Auth-->>API: Verification failed
        API-->>Provider: 401 Unauthorized
        Note over API: Log security event
    else Valid signature
        Auth-->>API: Signature valid
        
        API->>DB: SELECT * FROM payment_events<br/>WHERE provider_event_id=?
        DB-->>API: Check for idempotency
        
        alt Event already processed
            DB-->>API: Return existing event
            API-->>Provider: 200 OK (idempotent)
        else New event
            API->>DB: INSERT INTO payment_events<br/>(provider, provider_event_id, status='pending', raw_payload)
            DB-->>API: Event recorded
            
            API->>Sub: Process payment
            Sub->>Sub: Update subscription status
            Sub->>DB: UPDATE subscriptions<br/>SET status=?, end_at=?
            DB-->>Sub: Subscription updated
            
            alt Subscription update successful
                Sub-->>API: Success
                API->>DB: UPDATE payment_events<br/>SET status='success', processed_at=NOW()
                API-->>Provider: 200 OK
            else Subscription update failed
                Sub-->>API: Failure
                API->>DB: UPDATE payment_events<br/>SET status='failed', processed_at=NOW()
                API->>DB: ROLLBACK subscription changes
                API-->>Provider: 500 Internal Server Error
            end
        end
    end
    
    Note over API: All events logged with trace_id<br/>for audit trail
```

## Flow Descriptions

### 1. Send Message Flow
- **Purpose**: Real-time message delivery with async notification
- **Key Features**:
  - JWT authentication with tenant context
  - Rate limiting (30 messages/minute)
  - Duplicate detection using client_message_id
  - Cursor-based pagination support
  - Async notification queue (BullMQ)
  - Socket.io broadcast to room members
  - Redis presence integration

### 2. WebSocket Join Room Flow
- **Purpose**: Real-time room membership and presence tracking
- **Key Features**:
  - Tenant-scoped socket rooms
  - Redis-based presence with TTL
  - Online/offline broadcasting
  - Presence query endpoint
  - Automatic cleanup via TTL

### 3. Payment Webhook Flow
- **Purpose**: Secure payment event processing with idempotency
- **Key Features**:
  - HMAC signature verification
  - Idempotency using provider_event_id
  - Transaction rollback on failure
  - Audit trail in payment_events table
  - Structured logging with trace_id
  - Tenant isolation for payment data
