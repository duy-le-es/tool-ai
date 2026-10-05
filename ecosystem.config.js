// Cấu hình pm2 chạy bot Telegram 24/7
//   pm2 start ecosystem.config.js   -> chạy bot
//   pm2 logs flow-bot               -> xem log
//   pm2 restart flow-bot            -> chạy lại sau khi sửa code / .env
//   pm2 stop flow-bot               -> tắt bot
module.exports = {
  apps: [
    {
      name: 'flow-bot',
      script: 'bot.js',
      cwd: __dirname,
      // Bot crash thì tự chạy lại, nhưng đợi 10s giữa các lần (tránh chạy lại liên tục khi lỗi cấu hình)
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 50,
      // Không theo dõi file: results/, screenshots/, user_data/ thay đổi liên tục khi chạy
      watch: false,
      // Đợi bot đóng Chrome gọn gàng khi stop/restart
      kill_timeout: 15000,
      out_file: 'logs/flow-bot.out.log',
      error_file: 'logs/flow-bot.err.log',
      time: true
    }
  ]
};
