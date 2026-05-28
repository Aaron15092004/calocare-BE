# CaloCare Backend

Node.js + Express + MongoDB REST API cho ứng dụng theo dõi dinh dưỡng và quản lý nhà hàng.

## Tech Stack

| Layer      | Công nghệ                                                         |
| ---------- | ----------------------------------------------------------------- |
| Runtime    | Node.js + TypeScript, Express 4.x                                 |
| Database   | MongoDB + Mongoose 8.x                                            |
| Auth       | JWT (Access + Refresh) + Google OAuth 2.0                         |
| AI         | Google Gemini (nhận diện món ăn) + Claude Haiku (dinh dưỡng menu) |
| Thanh toán | PayOS + MoMo                                                      |
| File       | Multer + Cloudinary                                               |
| Email      | Nodemailer (SMTP Gmail)                                           |
| Security   | Helmet + CORS + express-rate-limit + bcryptjs                     |

## Cài đặt

```bash
npm install
cp .env.example .env
npm run build
```

## Biến môi trường (`.env`)

```env
PORT=1509
NODE_ENV=development
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/calocare

JWT_SECRET=...
JWT_EXPIRES_IN=1d
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRES_IN=7d

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_CALLBACK_URL=http://localhost:1509/api/auth/google/callback
FRONTEND_URL=http://localhost:2004

GEMINI_API_KEY=...
ANTHROPIC_API_KEY=...          # Claude Haiku — tuỳ chọn

CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...

PAYOS_CLIENT_ID=...
PAYOS_API_KEY=...
PAYOS_CHECKSUM_KEY=...
CLIENT_URL=http://localhost:2004

PAYMENT_MOMO_PHONE=...
PAYMENT_BANK_NAME=...
PAYMENT_BANK_ACCOUNT=...
PAYMENT_BANK_OWNER=...

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="CaloCare <...>"
```

## Chạy server

```bash
npm run dev                    # development (hot-reload)
npm run build && npm start     # production
```

Server tại `http://localhost:1509` — health check: `GET /health`.

## Hệ thống Role

| Role          | Quyền                                              |
| ------------- | -------------------------------------------------- |
| `user`        | Nhật ký ăn, kế hoạch bữa ăn, đăng ký quán          |
| `store_owner` | Quản lý quán, thực đơn, analytics (panel `/owner`) |
| `moderator`   | Duyệt công thức, thực phẩm, xem admin              |
| `admin`       | Toàn quyền — user, thanh toán, cửa hàng, nội dung  |

Admin đổi role user → `store_owner` qua `PUT /api/admin/users/:id`.

## API Endpoints (prefix `/api`)

- **Auth**: đăng ký, đăng nhập, refresh, logout, Google OAuth
- **Profile**: xem/cập nhật thông tin cá nhân + mục tiêu dinh dưỡng
- **Foods / Food Groups**: CRUD thực phẩm, import CSV (Admin), duyệt cộng đồng
- **Food Diary**: nhật ký ăn uống theo ngày/bữa
- **Analyze Food**: scan ảnh → Gemini AI trả dinh dưỡng (Free: 2/ngày, Premium: 5/ngày, Pro: ∞)
- **Recipes / Recipe Categories**: CRUD công thức, duyệt cộng đồng
- **Meal Plans / User Meal Plans / Meal Progress**: tạo, clone, theo dõi kế hoạch bữa ăn
- **Stores**: đăng ký quán, duyệt, thực đơn, analytics, nâng cấp Store Pro
- **Reviews**: đánh giá 1–5 sao, vote hữu ích, chủ quán phản hồi (Pro)
- **Favorites**: lưu thực phẩm và công thức
- **Subscription**: gói Free/Premium/Pro, thanh toán PayOS/MoMo, webhook
- **Discount Codes**: tạo/validate mã giảm giá (Admin)
- **Admin**: dashboard thống kê, quản lý user, đổi role

## Gói dịch vụ

| Gói       | Giá            | Đối tượng                                 |
| --------- | -------------- | ----------------------------------------- |
| Free      | 0đ             | User thông thường                         |
| Premium   | 49.000đ/tháng  | Tăng giới hạn AI scan, tính năng nâng cao |
| Pro       | 119.000đ/tháng | Không giới hạn + tính năng Pro            |
| Store Pro | 49.000đ/tháng  | Chủ quán — analytics, AI menu, QR code    |

## Cron Jobs

File: `src/jobs/subscriptionCron.ts`

- **00:05 ICT hàng ngày**: hạ cấp subscription hết hạn, gửi email thông báo
- **09:00 ICT hàng ngày**: email nhắc gia hạn (7 ngày và 3 ngày trước khi hết)
