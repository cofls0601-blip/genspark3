// PM2 로 Cloudflare Pages 개발 서버(로컬 D1 포함)를 상시 구동한다.
module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=asset-rebalance-app-production --local --ip 0.0.0.0 --port 3000',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
    },
  ],
}
