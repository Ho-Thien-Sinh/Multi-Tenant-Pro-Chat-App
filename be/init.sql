-- 1. Tạo bảng Tenants (Khách hàng doanh nghiệp)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL, -- slug/identifier cho tenant
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Tạo bảng Users gắn với Tenant
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL, -- password hash
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Tạo bảng Rooms (phòng chat) gắn với Tenant
CREATE TABLE rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    description TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- 4. Tạo bảng Room Members (người dùng trong phòng)
CREATE TABLE room_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(room_id, user_id)
);

-- 5. Tạo bảng Messages với unique constraint
CREATE TABLE messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    client_message_id TEXT, -- ID từ client để detect duplicate
    content TEXT NOT NULL,
    reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    -- Unique constraint để chống trùng lặp khi client retry
    CONSTRAINT unique_client_message UNIQUE (tenant_id, room_id, client_message_id)
);

-- 6. Tạo bảng Message Reactions (emoji reactions)
CREATE TABLE message_reactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(message_id, user_id, emoji)
);

-- 7. Tạo bảng Message Reads (trạng thái đã đọc)
CREATE TABLE message_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messages(id),
    read_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(room_id, user_id)
);

-- 7. Tạo bảng Subscriptions (gói thuê bao)
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    plan_code TEXT NOT NULL, -- code của gói (basic, pro, enterprise)
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired')),
    start_at TIMESTAMP NOT NULL,
    end_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 8. Tạo bảng Payment Events (lịch sử webhook/payment)
CREATE TABLE payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    provider TEXT NOT NULL, -- momo, stripe, etc.
    provider_event_id TEXT NOT NULL, -- event ID từ provider để idempotent
    transaction_id TEXT, -- transaction ID từ provider
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    raw_payload JSONB, -- raw payload từ webhook
    processed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT unique_provider_event UNIQUE (provider, provider_event_id)
);

-- 9. Tạo bảng Refresh Tokens (để quản lý JWT refresh tokens)
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 9. Tạo index cho ordering và cursor-based pagination
CREATE INDEX idx_messages_room_created ON messages(room_id, created_at DESC);
CREATE INDEX idx_messages_tenant_room ON messages(tenant_id, room_id);
CREATE INDEX idx_room_members_user ON room_members(user_id);
CREATE INDEX idx_room_members_tenant ON room_members(tenant_id);
CREATE INDEX idx_message_reactions_message ON message_reactions(message_id);
CREATE INDEX idx_message_reactions_user ON message_reactions(user_id);
CREATE INDEX idx_message_reactions_tenant ON message_reactions(tenant_id);
CREATE INDEX idx_message_reads_user_room ON message_reads(user_id, room_id);
CREATE INDEX idx_message_reads_tenant ON message_reads(tenant_id);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);
CREATE INDEX idx_payment_events_provider ON payment_events(provider, provider_event_id);
CREATE INDEX idx_payment_events_tenant ON payment_events(tenant_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_tenant ON refresh_tokens(tenant_id);
CREATE INDEX idx_refresh_tokens_token ON refresh_tokens(token);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens(expires_at);

-- 10. BẬT ROW LEVEL SECURITY cho tất cả các bảng
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;

-- 11. RLS Policies cho Users
CREATE POLICY tenant_user_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY user_select_own ON users
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 12. RLS Policies cho Rooms
CREATE POLICY tenant_room_isolation ON rooms
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY room_select_own ON rooms
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 13. RLS Policies cho Room Members
CREATE POLICY tenant_room_member_isolation ON room_members
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 14. RLS Policies cho Messages
CREATE POLICY tenant_message_isolation ON messages
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_select_own ON messages
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_insert_own ON messages
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 15. RLS Policies cho Message Reactions
CREATE POLICY tenant_message_reaction_isolation ON message_reactions
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_reaction_select_own ON message_reactions
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_reaction_insert_own ON message_reactions
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_reaction_delete_own ON message_reactions
    FOR DELETE
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 16. RLS Policies cho Message Reads
CREATE POLICY tenant_message_read_isolation ON message_reads
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY message_read_select_own ON message_reads
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 16. RLS Policies cho Subscriptions
CREATE POLICY tenant_subscription_isolation ON subscriptions
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY subscription_select_own ON subscriptions
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 17. RLS Policies cho Payment Events
CREATE POLICY tenant_payment_event_isolation ON payment_events
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY payment_event_select_own ON payment_events
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 18. RLS Policies cho Refresh Tokens
CREATE POLICY tenant_refresh_token_isolation ON refresh_tokens
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY refresh_token_select_own ON refresh_tokens
    FOR SELECT
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY refresh_token_insert_own ON refresh_tokens
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::UUID);

CREATE POLICY refresh_token_update_own ON refresh_tokens
    FOR UPDATE
    USING (tenant_id = current_setting('app.current_tenant', true)::UUID);

-- 19. Function để set tenant context
CREATE OR REPLACE FUNCTION set_tenant_context(tenant_id UUID)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_tenant', tenant_id::text, false);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
