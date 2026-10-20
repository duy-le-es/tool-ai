# Tool AI - Tự động hóa Video Google Flow & TikTok Studio

Hệ thống tự động hóa tạo video sản phẩm bằng Google Flow AI (TikTok Director Pro AI) và tự động đăng / gắn link sản phẩm lên TikTok Studio thông qua Telegram Bot.

## Tính năng chính

- **Telegram Bot**: Nhận link sản phẩm / hình ảnh từ người dùng, quản lý hàng đợi và tài khoản Google Flow.
- **Chọn phong cách video trên Telegram**: Sau khi gửi ảnh/thông tin sản phẩm, chọn một trong bốn mood: **Điện ảnh / Sản phẩm**, **Viral / Sống động**, **Chill / Nhẹ nhàng** hoặc **Hài hước / Trẻ trung**. Lựa chọn được áp dụng trên giao diện Google Flow mới trước khi sản xuất video.
- **Google Flow Automation**: Tự động tải ảnh sản phẩm, thực hiện Magic Fill, sinh video, tải về thumbnail, caption và video hoàn chỉnh.
- **TikTok Studio Upload**: Khi hẹn giờ, bot tự mở trình duyệt tải video lên TikTok Studio, điền tiêu đề/caption, tìm kiếm và gắn liên kết TikTok Shop Affiliate, đổi ảnh bìa.
- **Đăng theo lịch khi cần**: Mặc định bot chỉ gửi video qua Telegram và không mở TikTok Studio. Chỉ khi chọn **Hẹn giờ đăng TikTok**, bot mới tải video lên và dùng lịch đăng của TikTok; bot không thay đổi quyền xem video.

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

- **Dọn cache, file tải về và du lieu phien dang nhap**:
  ```bash
  npm run clear-cache
  ```
  Lenh tren chi hien thi cac thu muc se xoa. De xoa that, chay:
  ```bash
  npm run clear-cache -- --yes
  ```
  Thao tac nay xoa `user_data*`, nen can dang nhap lai Google va TikTok sau do.
