module.exports = {
  apps: [
    {
      name: "atlas",
      script: "start.cjs",
      cwd: "C:\\Users\\Derek DiCamillo\\atlas",
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
      error_file: "C:\\Users\\Derek DiCamillo\\atlas\\logs\\error.log",
      out_file: "C:\\Users\\Derek DiCamillo\\atlas\\logs\\out.log",
      merge_logs: true,
      // Watch (disabled in production — use pm2 restart atlas to pick up changes)
      watch: false,
    },
    {
      name: "teleprompter",
      script: "teleprompter/server.ts",
      interpreter: "bun",
      cwd: "C:\\Users\\Derek DiCamillo\\atlas",
      env: {
        TELEPROMPTER_PORT: "8585",
      },
      autorestart: false, // On-demand, not always running
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "C:\\Users\\Derek DiCamillo\\atlas\\logs\\teleprompter-error.log",
      out_file: "C:\\Users\\Derek DiCamillo\\atlas\\logs\\teleprompter-out.log",
      merge_logs: true,
      watch: false,
    },
  ],
};
