# Tool AI - Tự động hóa Video Google Flow & TikTok Studio

Hệ thống tự động hóa tạo video sản phẩm bằng Google Flow AI (TikTok Director Pro AI) và tự động đăng / gắn link sản phẩm lên TikTok Studio thông qua Telegram Bot.

## Tính năng chính

- **Telegram Bot**: Nhận link sản phẩm / hình ảnh từ người dùng, quản lý hàng đợi và tài khoản Google Flow.
- **Google Flow Automation**: Tự động tải ảnh sản phẩm, thực hiện Magic Fill, sinh video, tải về thumbnail, caption và video hoàn chỉnh.
- **TikTok Studio Upload**: Tự động mở trình duyệt tải video lên TikTok Studio, điền tiêu đề/caption, tìm kiếm và gắn liên kết TikTok Shop Affiliate, đổi ảnh bìa.

## Cài đặt

1. Cài đặt các gói phụ thuộc:
   ```bash
   npm install
   ```

2. Cài đặt trình duyệt Playwright (nếu dùng chromium mặc định):
   ```bash
   npx playwright install chrome
   ```

3. Cấu hình biến môi trường:
   Sao chép `.env.example` thành `.env` và điền các thông tin:
   ```bash
   cp .env.example .env
   ```

## Sử dụng

- **Đăng nhập Google**:
  ```bash
  node login.js
  ```
- **Đăng nhập TikTok Studio**:
  ```bash
  node login_tiktok.js
  ```
- **Khởi chạy Telegram Bot**:
  ```bash
  node bot.js
  ```
