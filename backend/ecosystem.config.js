// used via `pm2-runtime` (see package.json "start") — the container/PaaS-
// friendly variant of PM2 that runs in the foreground instead of
// daemonizing, so the process manager itself becomes PID 1 and actually
// supervises the app instead of exiting immediately after launch
module.exports = {
  apps: [
    {
      name: "ghazalkarami-backend",
      script: "dist/server.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s", // a restart counts as "successful" only if the app stays up this long
      restart_delay: 2000,
      max_memory_restart: "400M",
    },
  ],
};
