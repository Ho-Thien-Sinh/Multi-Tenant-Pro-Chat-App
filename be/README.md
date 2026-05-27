# Backend - Multi-Tenant Chat App

Backend API cho ứng dụng Chat đa tenant.

## Cài đặt

```bash
npm install
```

## Cấu hình

Sao chép `.env.example` thành `.env` và chỉnh sửa cấu hình:

```bash
cp .env.example .env
```

## Chạy development

```bash
npm run dev
```

Server sẽ chạy tại http://localhost:3000

## Build

```bash
npm run build
```

## Chạy production

```bash
npm start
```

## API Endpoints

- `GET /health` - Health check
- `GET /api/tenants` - Lấy danh sách tenants
- `POST /api/tenants` - Tạo tenant mới
- `GET /api/users` - Lấy danh sách users (cần header `x-tenant-id`)
- `POST /api/users` - Tạo user mới

## Socket.io Events

- `join-tenant` - Tham gia chat room của tenant
- `send-message` - Gửi tin nhắn
- `message` - Nhận tin nhắn
