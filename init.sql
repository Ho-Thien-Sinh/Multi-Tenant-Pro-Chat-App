-- 1. Tạo bảng Tenants (Khách hàng doanh nghiệp)
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 2. Tạo bảng Users gắn với Tenant
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    email TEXT NOT NULL,
    username TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. BẬT ROW LEVEL SECURITY
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- 4. Tạo Chính sách (Policy): User chỉ thấy dữ liệu thuộc Tenant của mình
-- 'app.current_tenant' là biến mình sẽ set trong code Backend khi có request tới
CREATE POLICY tenant_user_isolation ON users
    USING (tenant_id = current_setting('app.current_tenant')::UUID);
