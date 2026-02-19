module.exports = {
  apps: [
    {
      name: "atlas",
      script: "C:\\Users\\derek\\.bun\\bin\\bun.exe",
      args: "run src/relay.ts",
      cwd: "C:\\Users\\derek\\Projects\\atlas",
      interpreter: "none",
      env: {
        NODE_ENV: "production",
        TTS_VOICE: "onyx",
      },
      // Restart policies
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "C:\\Users\\derek\\Projects\\atlas\\logs\\error.log",
      out_file: "C:\\Users\\derek\\Projects\\atlas\\logs\\out.log",
      merge_logs: true,
      // Watch (disabled in production — use pm2 restart atlas to pick up changes)
      watch: false,
    },
  ],
};
