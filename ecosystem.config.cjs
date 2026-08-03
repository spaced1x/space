// Single PM2 application. One repository, one process, one SQLite file.
module.exports = {
  apps: [
    {
      name: "space",
      script: ".output/server/index.mjs",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      kill_timeout: 15000, // allow the shutdown sequence to close SQLite cleanly
      wait_ready: false,
      env: {
        NODE_ENV: "production",
      },
      // Structured JSON already carries timestamps and component names.
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
    },
  ],
};