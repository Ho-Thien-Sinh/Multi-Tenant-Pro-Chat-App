# Multi-Tenant Pro Chat App

Ứng dụng Chat đa tenant với frontend và backend chạy riêng biệt.

## Cấu trúc dự án

```
Multi-Tenant-Pro-Chat-App/
├── be/              # Backend (Node.js + Express + TypeScript)
├── fe/              # Frontend (React + Vite + TailwindCSS)
└── docker-compose.yml
```

## Bắt đầu nhanh với Docker

```bash
docker-compose up
```

Services sẽ chạy tại:
- Frontend: http://localhost:5173
- Backend: http://localhost:3000
- PostgreSQL: localhost:5432
- Redis: localhost:6379

## Chạy development cục bộ

### Backend

```bash
cd be
npm install
cp .env.example .env
npm run dev
```

### Frontend

```bash
cd fe
npm install
npm run dev
```

## Tính năng

- **Multi-tenant Architecture**: Hỗ trợ nhiều khách hàng doanh nghiệp với Row Level Security
- **Real-time Chat**: Socket.io cho tin nhắn real-time
- **User Management**: Quản lý users cho từng tenant
- **Modern UI**: React + TailwindCSS

Xem thêm chi tiết trong [be/README.md](be/README.md) và [fe/README.md](fe/README.md)