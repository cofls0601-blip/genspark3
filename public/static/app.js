/* 자산배분 리밸런싱 도우미 — SPA 코어 (vanilla JS) */
'use strict'

/* ───────────── API ───────────── */
const U = {}
window.U = U

U.api = {
  async req(method, path, body) {
    const opt = { method, headers: {} }
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json'
      opt.body = JSON.stringify(body)
    }
    const res = await fetch(path, opt)
    let json = null
    try {
      json = await res.json()
    } catch {
      throw new Error(`서버 응답을 해석할 수 없습니다 (HTTP ${res.status})`)
    }
    if (!json || json.ok !== true) throw new Error((json && json.error) || `요청 실패 (HTTP ${res.status})`)
    return json.data
  },
  get: (p) => U.api.req('GET', p),
  post: (p, b) => U.api.req('POST', p, b),
  put: (p, b) => U.api.req('PUT', p, b),
  patch: (p, b) => U.api.req('PATCH', p, b),
  del: (p) => U.api.req('DELETE', p),
}

/* ───────────── 상태 ───────────── */
U.S = {
  boot: null,
  page: 'today',
  plan: null,
  planLoading: false,
  perf: null,
  perfRange: 'all',
  editingCode: null,
  ruleDraft: null,
  preview: null,
  showJson: false,
  searched: null,
  restoreText: '',
  /** 전략 비교 페이지에서 선택한 전략 코드들 */
  strategyPick: null,
  /** 자산 편집 실행취소 스택 (스테이징) */
  undoStack: [],
  /** 가격 캐시 초기화 UI 상태 */
  cacheBusy: false,
  /** 리밸런싱 계획을 만들 기준일 (기본 오늘). 매월 말 종가로 계산할 때 바꾼다 */
  planDate: null,
  /** 실행 원장 (최신순) */
  rebalances: null,
  /** 원장 상세로 펼친 기록 id */
  ledgerOpen: null,
  /** 실행 반영 진행 중 플래그 */
  execBusy: false,
  /** 실행 반영 시 주식 수량을 정수로 반올림할지 */
  execRound: false,
  /** 템플릿 화면 상태 */
  tplKind: 'static',
  tplPick: null,
  tplUseKr: false,
  tplOverrides: null,
  tplAccount: '',
}

/* ───────────── 포맷 ───────────── */
U.n = (v, d = 0) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : d
}
const n = U.n
U.won = (x) => `${Math.round(n(x)).toLocaleString('ko-KR')}원`
U.wonShort = (x) => {
  const v = n(x)
  const a = Math.abs(v)
  if (a >= 1e8) return `${(v / 1e8).toFixed(2)}억`
  if (a >= 1e4) return `${(v / 1e4).toFixed(0)}만`
  return `${Math.round(v).toLocaleString('ko-KR')}`
}
U.pct = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : `${(Number(x) * 100).toFixed(d)}%`)
U.pctPt = (x) => (x === null || !Number.isFinite(Number(x)) ? '—' : `${Number(x) >= 0 ? '+' : ''}${Number(x).toFixed(1)}%p`)
U.num0 = (x) => Math.round(n(x)).toLocaleString('ko-KR')
U.esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
U.signed = (x) => `${n(x) >= 0 ? '+' : ''}${Math.round(n(x)).toLocaleString('ko-KR')}원`
U.today = () => new Date().toISOString().slice(0, 10)

/* ───────────── 토스트 ───────────── */
U.toast = (msg, tone = 'ok') => {
  const colors = { ok: 'bg-slate-900 text-white', err: 'bg-red-600 text-white', warn: 'bg-amber-500 text-white' }
  const el = document.createElement('div')
  el.className = `toast-item px-4 py-2.5 rounded-xl shadow-lg text-sm font-medium ${colors[tone] || colors.ok}`
  el.textContent = msg
  document.getElementById('toast').appendChild(el)
  setTimeout(() => {
    el.style.transition = 'opacity .2s'
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 220)
  }, 2800)
}

/* ───────────── 컴포넌트 ───────────── */
U.card = (inner, cls = '') =>
  `<section class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm ${cls}">${inner}</section>`

U.metric = (label, value, sub = '', tone = '') => {
  const toneCls = tone === 'pos' ? 'text-green-600' : tone === 'neg' ? 'text-red-600' : ''
  return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-3.5 shadow-sm">
    <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-1">${U.esc(label)}</div>
    <div class="text-xl font-extrabold tnum ${toneCls}">${value}</div>
    ${sub ? `<div class="text-[12px] text-slate-500 dark:text-slate-400 mt-1">${sub}</div>` : ''}
  </div>`
}

U.btn = (label, act, cls = 'btn-s', attrs = '') => `<button class="btn ${cls}" data-act="${act}" ${attrs}>${label}</button>`

U.weightBar = (cur, tgt, h = 10) => {
  const c = Math.max(0, n(cur))
  const t = Math.max(0, n(tgt))
  const scale = Math.max(100, c, t, 1)
  const green = (Math.min(c, t) / scale) * 100
  const blue = (Math.max(0, t - c) / scale) * 100
  const red = (Math.max(0, c - t) / scale) * 100
  const seg = []
  if (green > 0) seg.push(`<span style="width:${green.toFixed(3)}%;background:#16a34a"></span>`)
  if (blue > 0) seg.push(`<span style="width:${blue.toFixed(3)}%;background:#3b82f6"></span>`)
  if (red > 0) seg.push(`<span style="width:${red.toFixed(3)}%;background:#ef4444"></span>`)
  return `<div class="wbar" style="height:${h}px">${seg.join('') || '<span style="width:100%;background:#e5e7eb"></span>'}</div>`
}

U.rebalanceStatus = (rows) => {
  const trades = rows.map((r) => Math.abs(n(r['매매액(+매수/-매도)'])))
  const total = rows.reduce((a, r) => a + n(r.현재금액), 0)
  const notes = rows.map((r) => String(r.비고 || '')).join(' ')
  if (/데이터\s*부족|데이터부족|데이터 없음/.test(notes)) return { label: '⚠️ 데이터 확인', cls: 'text-amber-600', help: '가격/SMA 데이터가 부족합니다.' }
  if (total <= 0) return { label: '⚪ 데이터 없음', cls: 'text-slate-500', help: '평가액이 0입니다. 보유수량을 입력하세요.' }
  const ratio = trades.length ? Math.max(...trades, 0) / total : 0
  if (ratio >= 0.1) return { label: '🔴 리밸런싱 필요', cls: 'text-red-600', help: `최대 조정액이 자산의 ${(ratio * 100).toFixed(1)}%` }
  if (ratio >= 0.03) return { label: '🟡 점검 권장', cls: 'text-amber-600', help: `최대 조정액이 자산의 ${(ratio * 100).toFixed(1)}%` }
  return { label: '🟢 정상', cls: 'text-green-600', help: '목표비중과 괴리가 작습니다.' }
}

/** 섹션 제목 */
U.sectionTitle = (title, sub = '') =>
  `<div class="mb-3"><h2 class="text-lg font-extrabold tracking-tight">${U.esc(title)}</h2>${
    sub ? `<p class="text-[13px] text-slate-500 dark:text-slate-400 mt-0.5">${U.esc(sub)}</p>` : ''
  }</div>`

U.empty = (msg, act, actLabel) =>
  `<div class="card bg-white dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
    <div class="text-slate-500 dark:text-slate-400 text-sm">${U.esc(msg)}</div>
    ${act ? `<div class="mt-3">${U.btn(actLabel, act, 'btn-p')}</div>` : ''}
  </div>`

/* ───────────── 라우팅 ───────────── */
const NAV = [
  { id: 'today', label: '오늘', icon: 'fa-bolt' },
  { id: 'portfolio', label: '포트폴리오', icon: 'fa-chart-pie' },
  { id: 'ledger', label: '실행 기록', icon: 'fa-clipboard-check' },
  { id: 'history', label: '기록·성과', icon: 'fa-clock-rotate-left' },
  { id: 'compare', label: '전략 비교', icon: 'fa-scale-balanced' },
  { id: 'settings', label: '설정', icon: 'fa-sliders' },
]

function navHtml() {
  return `
  <header class="sticky top-0 z-40 bg-white/85 dark:bg-slate-950/85 backdrop-blur border-b border-slate-200 dark:border-slate-800 no-print">
    <div class="max-w-5xl mx-auto px-2.5">
      <div class="flex items-center justify-between h-14 gap-1">
        <div class="flex items-center gap-1.5 font-extrabold tracking-tight shrink-0">
          <span class="text-lg">📊</span><span class="hidden md:inline whitespace-nowrap">자산배분 리밸런싱</span>
        </div>
        <nav class="flex items-center gap-0.5 overflow-x-auto">
          ${NAV.map(
            (x) => `<button data-nav="${x.id}" class="px-2.5 sm:px-3.5 py-2 rounded-lg text-[13px] font-semibold whitespace-nowrap transition ${
              U.S.page === x.id ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }"><i class="fas ${x.icon} mr-1"></i><span class="hidden sm:inline">${x.label}</span></button>`,
          ).join('')}
        </nav>
      </div>
    </div>
  </header>`
}

U.render = function render() {
  const app = document.getElementById('app')
  const body = !U.S.boot ? skeleton() : (window.PAGES[U.S.page] || window.PAGES.today)()
  app.innerHTML = `${navHtml()}<main class="max-w-5xl mx-auto px-2.5 sm:px-3 py-5 pb-24">${body}</main>`
  U.bind()
}

const skeleton = () => `
  <div class="space-y-3 animate-pulse">
    <div class="h-8 bg-slate-200 dark:bg-slate-800 rounded w-40"></div>
    <div class="h-32 bg-slate-200 dark:bg-slate-800 rounded-xl"></div>
    <div class="h-48 bg-slate-200 dark:bg-slate-800 rounded-xl"></div>
  </div>`

U.bind = function bind() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      U.S.page = el.dataset.nav
      U.render()
      window.scrollTo({ top: 0 })
    }
  })
  document.querySelectorAll('[data-act]').forEach((el) => {
    const fn = window.ACTIONS[el.dataset.act]
    if (fn) el.onclick = (e) => fn(e, el)
  })
  document.querySelectorAll('[data-onchange]').forEach((el) => {
    const fn = window.ACTIONS[el.dataset.onchange]
    if (fn) el.onchange = (e) => fn(e, el)
  })
  document.querySelectorAll('[data-oninput]').forEach((el) => {
    const fn = window.ACTIONS[el.dataset.oninput]
    if (fn) el.oninput = (e) => fn(e, el)
  })
  document.querySelectorAll('[data-onenter]').forEach((el) => {
    const fn = window.ACTIONS[el.dataset.onenter]
    if (fn)
      el.onkeydown = (e) => {
        if (e.key === 'Enter') fn(e, el)
      }
  })
}

window.PAGES = {}
window.ACTIONS = {}

/* ───────────── 부팅 ───────────── */
U.reloadBoot = async () => {
  U.S.boot = await U.api.get('/api/bootstrap')
  U.render()
}

async function boot() {
  try {
    U.S.boot = await U.api.get('/api/bootstrap')
    U.render()
    U.refreshPlan(false)
  } catch (e) {
    document.getElementById('app').innerHTML = `<div class="max-w-lg mx-auto mt-20 p-5">
      <div class="card bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900 p-5">
        <div class="font-bold text-red-600 mb-1">앱을 불러오지 못했습니다</div>
        <div class="text-sm text-slate-600 dark:text-slate-400 break-words">${U.esc(e.message)}</div>
        <button class="btn btn-p mt-4" onclick="location.reload()">다시 시도</button>
      </div></div>`
  }
}

/** 계획 계산 — 캐시 우선(기본) / 강제 새로고침
 *  date 를 지정하면 그 날짜(종가) 기준으로 계산한다. 매월 말 종가 기준 계산에 쓴다. */
U.refreshPlan = async (force, date) => {
  const day = date || U.S.planDate || null
  U.S.planLoading = true
  U.render()
  try {
    U.S.plan = force ? await U.api.post('/api/plan/refresh', day ? { date: day } : {}) : await U.api.get('/api/plan/quick')
    if (U.S.plan.assets) U.S.boot.assets = U.S.plan.assets
    if (U.S.plan.strategies) U.S.boot.strategies = U.S.plan.strategies
    if (U.S.plan.warnings && U.S.plan.warnings.length) U.toast(`${U.S.plan.warnings.length}개 종목에 경고가 있습니다.`, 'warn')
    else if (force) U.toast(day ? `${day} 종가로 계산했습니다.` : '최신 가격으로 다시 계산했습니다.')
  } catch (e) {
    U.toast(e.message, 'err')
  } finally {
    U.S.planLoading = false
    U.render()
  }
}

/** 그 달의 마지막 날 (YYYY-MM-DD) */
U.monthEnd = (iso) => {
  const d = new Date(`${iso || U.today()}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return U.today()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
}

/** 그 달의 첫 날 (YYYY-MM-DD) */
U.monthStart = (iso) => {
  const d = new Date(`${iso || U.today()}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return U.today()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

U.S.activeStrategies = () => (U.S.boot?.strategies || []).filter((c) => c.active !== false)
U.S.specOf = (code) => (U.S.boot?.specs || {})[code]
U.S.assetsOf = (code) => (U.S.boot?.assets || []).filter((a) => a.strategy === code)
U.S.planOf = (code) => (U.S.plan?.plan || []).filter((r) => r.전략 === code)
U.S.signalOf = (code) => (U.S.plan?.signalRows || []).filter((r) => r.전략 === code)

document.addEventListener('DOMContentLoaded', boot)
