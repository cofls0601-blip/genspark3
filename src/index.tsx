/**
 * 자산배분 리밸런싱 도우미 — Hono 워커 엔트리
 *  - /api/*  : JSON API
 *  - 그 외    : SPA 셸(HTML) 반환, 정적 파일은 dist/static/* 에서 서빙
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { bootstrap } from './api/bootstrap'
import { plan } from './api/plan'
import { crud } from './api/crud'
import { history } from './api/history'
import { fail, type AppEnv } from './api/helpers'
import appJs from '../public/static/app.js?raw'
import pagesJs from '../public/static/pages.js?raw'
import styleCss from '../public/static/style.css?raw'

const app = new Hono<AppEnv>()

app.use('*', logger())
app.use('/api/*', cors())

app.route('/api', bootstrap)
app.route('/api', plan)
app.route('/api', crud)
app.route('/api', history)

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

// API 404 는 JSON 으로 (SPA 셸이 JSON 요청에 반환되지 않도록)
app.all('/api/*', (c) => fail(c, '존재하지 않는 API 경로입니다.', 404))

/** SPA 셸 — 정적 자산은 dist/static/* 에서 로드한다 */
const SHELL = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<title>자산배분 리밸런싱 도우미</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>" />
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" />
<style>${styleCss}</style>
</head>
<body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 antialiased">
<div id="app" class="min-h-screen"></div>
<div id="toast" class="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 space-y-2"></div>
 <script>${appJs.split('</script>').join('<\\/script>')}</script>
 <script>${pagesJs.split('</script>').join('<\\/script>')}</script>
</body>
</html>`

app.get('*', (c) => c.html(SHELL))
app.notFound((c) => c.html(SHELL))

export default app
