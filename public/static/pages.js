/* 자산배분 리밸런싱 도우미 — SPA 페이지 모듈
 * app.js 가 먼저 로드되어 window.U / window.PAGES / window.ACTIONS 를 만든다.
 */
'use strict'
;(function () {
  const U = window.U
  const PAGES = window.PAGES
  const ACTIONS = window.ACTIONS
  const esc = U.esc
  const n = U.n

  /* ───────────────────────── 공용 헬퍼 ───────────────────────── */
  const stateOf = () => U.S.boot || {}
  const plan = () => U.S.plan || null

  const strategyTitle = (code) => {
    const cfg = (stateOf().strategies || []).find((c) => c.code === code)
    return cfg ? `${code} · ${cfg.account}` : code
  }
  const specOf = (code) => (stateOf().specs || {})[code] || null

  /** 이 전략이 종목별 목표% 입력을 쓰는지 (규칙이 비중을 정하면 false) */
  const weightMetaFor = (code) => (stateOf().weightMeta || {})[code] || { usage: 'asset', usesWeights: true, note: '' }

  /** 종목을 추가했을 때의 안내 — 비중을 쓰지 않는 전략은 목표% 입력을 요구하지 않는다 */
  const addedToast = (name) =>
    weightMetaFor(U.S.ruleDraft && U.S.ruleDraft.code).usesWeights
      ? `“${name}” 을(를) 추가했습니다. 목표%를 입력한 뒤 [변경 저장] 을 누르세요.`
      : `“${name}” 을(를) 추가했습니다. [변경 저장] 을 누르면 반영됩니다.`

  const warnBanner = () => {
    const w = plan()?.warnings || []
    if (!w.length) return ''
    return `<div class="card bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 p-3.5 mb-3">
      <div class="flex items-start gap-2">
        <i class="fas fa-triangle-exclamation text-amber-600 mt-0.5"></i>
        <div class="flex-1 min-w-0">
          <div class="font-bold text-amber-800 dark:text-amber-300 text-sm">데이터 경고 ${w.length}건</div>
          <ul class="mt-1.5 space-y-0.5">${w
            .slice(0, 6)
            .map((x) => `<li class="text-[12px] text-amber-800/90 dark:text-amber-300/90 break-words">· <b>${esc(x.ticker)}</b> ${esc(x.message)}</li>`)
            .join('')}</ul>
          ${w.length > 6 ? `<div class="text-[12px] text-amber-700 mt-1">… 외 ${w.length - 6}건</div>` : ''}
        </div>
      </div>
    </div>`
  }

  const loadingBox = (msg) => `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-8 text-center">
    <i class="fas fa-circle-notch spin text-blue-600 text-2xl"></i>
    <div class="mt-3 text-sm text-slate-500 dark:text-slate-400">${esc(msg)}</div>
  </div>`

  /** 계획 → 전략별 매수/매도 요약 (체크리스트용) */
  function actionGroups() {
    const rows = (plan()?.plan || []).filter((r) => Math.abs(n(r['매매액(+매수/-매도)'])) > 1000)
    const byCode = new Map()
    for (const r of rows) {
      if (!byCode.has(r.전략)) byCode.set(r.전략, [])
      byCode.get(r.전략).push(r)
    }
    return [...byCode.entries()].map(([code, list]) => ({
      code,
      title: strategyTitle(code),
      buy: list.filter((r) => n(r['매매액(+매수/-매도)']) > 0).reduce((a, r) => a + n(r['매매액(+매수/-매도)']), 0),
      sell: list.filter((r) => n(r['매매액(+매수/-매도)']) < 0).reduce((a, r) => a + n(r['매매액(+매수/-매도)']), 0),
      rows: list.sort((a, b) => n(b['매매액(+매수/-매도)']) - n(a['매매액(+매수/-매도)'])),
    }))
  }

  /** 직전 기록 대비 증감 */
  function vsPrevious() {
    const h = (stateOf().history || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))
    if (!h.length) return null
    const latest = h[0]
    return { latest, prev: h[1] || null }
  }

  /* ═══════════════════════════ 오늘 ═══════════════════════════ */
  PAGES.today = function () {
    if (U.S.planLoading) return U.sectionTitle('오늘의 리밸런싱') + loadingBox('가격을 확인하고 계획을 계산하는 중입니다…')
    const p = plan()
    const boot = stateOf()
    const groups = actionGroups()
    const vs = vsPrevious()
    const total = p ? n(p.totals?.grand) : 0
    const buy = p ? n(p.totals?.buy) : 0
    const sell = p ? n(p.totals?.sell) : 0
    const prevTotal = vs?.latest ? n(vs.latest.total) : null
    const delta = prevTotal ? total - prevTotal : null
    const deltaPct = prevTotal ? (total / prevTotal - 1) * 100 : null

    const head = `
      <div class="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 class="text-2xl font-extrabold tracking-tight">오늘의 리밸런싱</h1>
          <p class="text-[13px] text-slate-500 dark:text-slate-400 mt-1">
            기준일 <b class="tnum">${esc(p?.date || boot.today || '')}</b>
            ${p?.fxRate ? ` · USD/KRW <b class="tnum">${n(p.fxRate).toFixed(1)}</b>` : ''}
            ${p ? ` · ${p.quarterEnd ? '<span class="text-blue-600 font-semibold">분기말 복원 시점</span>' : '분기중(유지 모드)'}` : ''}
          </p>
        </div>
        <button class="btn btn-p" data-act="planRefresh" ${U.S.planLoading ? 'disabled' : ''}>
          <i class="fas fa-rotate ${U.S.planLoading ? 'spin' : ''}"></i> 최신 가격으로 계획 만들기
        </button>
      </div>`

    if (!p) return head + U.empty('아직 계획이 없습니다. 위 버튼으로 최신 가격을 불러오세요.', 'planRefresh', '계획 만들기')

    const metrics = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mb-4">
      ${U.metric('총 자산', U.won(total), vs?.latest ? `기록 ${esc(vs.latest.date)}` : '기록 없음')}
      ${U.metric(
        '직전 기록 대비',
        delta === null ? '—' : U.signed(delta),
        deltaPct === null ? '' : `${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`,
        delta === null ? '' : delta >= 0 ? 'pos' : 'neg',
      )}
      ${U.metric('오늘 사야 할 금액', U.won(buy), `매수 ${groups.reduce((a, g) => a + g.rows.filter((r) => n(r['매매액(+매수/-매도)']) > 0).length, 0)}건`, buy > 0 ? 'pos' : '')}
      ${U.metric('오늘 팔아야 할 금액', U.won(sell), `매도 ${groups.reduce((a, g) => a + g.rows.filter((r) => n(r['매매액(+매수/-매도)']) < 0).length, 0)}건`, sell < 0 ? 'neg' : '')}
    </div>`

    const actionCard = `
      <div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4 overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
          <div class="font-extrabold flex items-center gap-2"><i class="fas fa-list-check text-blue-600"></i> 오늘의 액션</div>
          <div class="flex items-center gap-2">
            ${U.btn('<i class="fas fa-bookmark"></i> 기록 저장', 'saveSnapshot', 'btn-s')}
            ${U.btn('<i class="fas fa-print"></i> 인쇄', 'printPage', 'btn-s')}
          </div>
        </div>
        ${
          groups.length
            ? groups.map((g) => actionGroup(g)).join('')
            : `<div class="p-6 text-center text-sm text-slate-500 dark:text-slate-400">
                🟢 조정이 필요한 종목이 없습니다. (모든 매매액이 1,000원 미만)
              </div>`
        }
      </div>`

    const planNote = `
      <div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4 p-4">
        <div class="flex items-center justify-between gap-3 mb-2">
          <div class="font-extrabold"><i class="fas fa-pen-to-square text-blue-600 mr-2"></i>이번 달 액션 플랜 메모</div>
          <span class="text-[12px] text-slate-500">스냅샷에 함께 저장</span>
        </div>
        <textarea class="inp min-h-24" data-oninput="actionPlanInput" placeholder="예: 장 마감 종가 확인 후 QQQ 3주 매수, 채권 비중은 유지. 체결 뒤 보유수량 갱신.">${esc(U.S.actionPlanDraft || '')}</textarea>
      </div>`

    const excluded = (p.plan || []).filter((r) => Math.abs(n(r['매매액(+매수/-매도)'])) > 0 && Math.abs(n(r['매매액(+매수/-매도)'])) <= 1000)

    return (
      head +
      warnBanner() +
      metrics +
      planNote +
      actionCard +
      (excluded.length
        ? `<div class="text-[12px] text-slate-500 dark:text-slate-400">금액이 1,000원 미만이라 목록에서 제외된 항목 ${excluded.length}건: ${excluded
            .map((r) => `${esc(r.전략)}/${esc(r.ETF || r.티커)}`)
            .join(', ')}</div>`
        : '')
    )
  }

  function actionGroup(g) {
    const ex = (stateOf().executions || []).filter((x) => x.date === (plan()?.date || '') && x.strategy === g.code)
    const doneOf = (t) => ex.some((x) => x.ticker === t && x.done)
    return `<section class="border-b border-slate-200 dark:border-slate-800 last:border-0" id="grp-${esc(g.code)}">
      <div class="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-bold text-sm">${esc(g.title)}</div>
        <div class="text-[12px] tnum">
          ${g.buy > 0 ? `<span class="text-green-600 font-semibold">매수 ${esc(U.won(g.buy))}</span>` : ''}
          ${g.buy > 0 && g.sell < 0 ? ' · ' : ''}
          ${g.sell < 0 ? `<span class="text-red-600 font-semibold">매도 ${esc(U.won(Math.abs(g.sell)))}</span>` : ''}
        </div>
      </div>
      <ul>${g.rows
        .map((r) => {
          const amt = n(r['매매액(+매수/-매도)'])
          const side = amt > 0 ? '매수' : '매도'
          const tone = amt > 0 ? 'text-green-600' : 'text-red-600'
          const checked = doneOf(r.티커)
          return `<li class="px-4 py-3 flex items-start gap-3 ${checked ? 'opacity-55' : ''}">
            <input type="checkbox" class="mt-1 w-4 h-4 shrink-0 accent-blue-600 cursor-pointer" ${checked ? 'checked' : ''}
              data-onchange="toggleExec" data-strategy="${esc(g.code)}" data-ticker="${esc(r.티커)}"
              data-etf="${esc(r.ETF || '')}" data-planned="${amt}" data-sid="exec-${esc(g.code)}-${esc(r.티커)}" />
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline justify-between gap-2 flex-wrap">
                <div class="font-semibold text-[14px]">${esc(r.ETF || r.티커)} <span class="text-slate-400 font-normal text-[12px]">${esc(r.티커)}</span></div>
                <div class="tnum font-bold ${tone}">${side} ${esc(U.won(Math.abs(amt)))}</div>
              </div>
              <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-1">
                현재 ${esc(U.won(r.현재금액))} → 목표 ${esc(U.won(r.목표금액))}
              </div>
              ${r.비고 ? `<div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">${esc(r.비고)}</div>` : ''}
            </div>
          </li>`
        })
        .join('')}</ul>
    </section>`
  }

  ACTIONS.planRefresh = async () => U.refreshPlan(true)
  ACTIONS.printPage = () => window.print()
  ACTIONS.actionPlanInput = (e, el) => {
    U.S.actionPlanDraft = el.value
  }

  ACTIONS.saveSnapshot = async (e, el) => {
    el.disabled = true
    try {
      const rec = await U.api.post('/api/history/snapshot', { date: plan()?.date, plan: U.S.actionPlanDraft.trim() })
      const boot = await U.api.get('/api/bootstrap')
      U.S.boot = boot
      U.S.actionPlanDraft = ''
      U.toast(`기록을 저장했습니다 (${rec.record.date} · ${U.won(rec.record.total)})`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
      el.disabled = false
    }
  }

  ACTIONS.toggleExec = async (e, el) => {
    const done = el.checked
    try {
      await U.api.put('/api/executions', {
        execution: {
          date: plan()?.date || U.today(),
          strategy: el.dataset.strategy,
          ticker: el.dataset.ticker,
          ETF: el.dataset.etf,
          planned: n(el.dataset.planned),
          done,
          actual: done ? n(el.dataset.planned) : 0,
        },
      })
      const boot = await U.api.get('/api/bootstrap')
      U.S.boot = boot
      U.toast(done ? '실행 완료로 표시했습니다.' : '실행 표시를 해제했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
      el.checked = !done
    }
  }

  /* ═══════════════════════════ 포트폴리오 ═══════════════════════════ */
  PAGES.portfolio = function () {
    const boot = stateOf()
    const p = plan()
    if (!boot.specs) return loadingBox('불러오는 중…')

    const cfgs = (boot.strategies || []).filter((c) => c.active !== false)
    const assets = boot.assets || []
    const fx = p?.fxRate || null

    const valOf = (a) => {
      if (a.ticker === 'CASH') return n(a.shares)
      const v = n(a.shares) * n(a.close)
      return a.market === 'US' ? (fx ? v * fx : 0) : v
    }
    const total = assets.filter((a) => cfgs.some((c) => c.code === a.strategy)).reduce((s, a) => s + valOf(a), 0)

    const catTargets = boot.categoryTargets || {}
    const catMap = new Map()
    for (const a of assets) {
      if (!cfgs.some((c) => c.code === a.strategy)) continue
      const k = a.category || '기타'
      catMap.set(k, (catMap.get(k) || 0) + valOf(a))
    }
    const cats = [...catMap.entries()].sort((x, y) => y[1] - x[1])

    const catCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-extrabold flex items-center gap-2">
        <i class="fas fa-layer-group text-blue-600"></i> 자산군 비중
      </div>
      ${
        cats.length
          ? `<div class="p-4 space-y-3.5">${cats
              .map(([cat, amt]) => {
                const cur = total > 0 ? (amt / total) * 100 : 0
                const tgt = n(catTargets[cat])
                const diff = cur - tgt
                return `<div>
                  <div class="flex items-baseline justify-between gap-2 text-[13px] mb-1">
                    <span class="font-semibold">${esc(cat)}</span>
                    <span class="tnum text-slate-500 dark:text-slate-400">
                      ${U.wonShort(amt)}원 · <b class="text-slate-800 dark:text-slate-200">${cur.toFixed(1)}%</b>
                      ${tgt > 0 ? ` / ${tgt.toFixed(1)}% <span class="${Math.abs(diff) < 2 ? 'text-green-600' : 'text-amber-600'}">${U.pctPt(diff)}</span>` : ''}
                    </span>
                  </div>
                  ${U.weightBar(cur, tgt || cur, 9)}
                </div>`
              })
              .join('')}</div>`
          : `<div class="p-6 text-center text-sm text-slate-500">보유 자산이 없습니다.</div>`
      }
    </div>`

    const stratCards = cfgs
      .map((cfg) => {
        const sub = assets.filter((a) => a.strategy === cfg.code)
        const st = sub.reduce((s, a) => s + valOf(a), 0)
        const share = total > 0 ? (st / total) * 100 : 0
        const spec = specOf(cfg.code)
        const ruleName = (boot.ruleMeta?.friendly || {})[spec?.rule] || spec?.rule || '—'
        const wmOf = weightMetaFor(cfg.code)
        const uw = wmOf.usesWeights !== false
        return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3 overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div class="font-extrabold">${esc(cfg.code)} <span class="text-[12px] font-normal text-slate-500">${esc(cfg.account)}</span></div>
              <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">${esc(ruleName)}</div>
            </div>
            <div class="text-right">
              <div class="tnum font-bold">${esc(U.won(st))}</div>
              <div class="text-[12px] text-slate-500 tnum">전체의 ${share.toFixed(1)}%</div>
            </div>
          </div>
          <div class="tbl-wrap">
            <table class="w-full text-[13px]">
              <thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500 dark:text-slate-400">
                <tr>
                  <th class="text-left px-3 py-2 font-semibold">종목</th>
                  <th class="text-right px-3 py-2 font-semibold">보유수량</th>
                  <th class="text-right px-3 py-2 font-semibold">현재가</th>
                  <th class="text-right px-3 py-2 font-semibold">평가액</th>
                  <th class="text-right px-3 py-2 font-semibold">비중</th>
                  <th class="text-right px-3 py-2 font-semibold">${uw ? '목표' : '비중 결정'}</th>
                </tr>
              </thead>
              <tbody>
                ${sub
                  .map((a) => {
                    const v = valOf(a)
                    const cur = st > 0 ? (v / st) * 100 : 0
                    const tgt = n(a.target_pct)
                    const diff = cur - tgt
                    return `<tr class="border-t border-slate-100 dark:border-slate-800">
                      <td class="px-3 py-2">
                        <div class="font-semibold">${esc(a.name || a.ticker || '-')}</div>
                        <div class="text-[11px] text-slate-400">${esc(a.ticker || '-')} · ${esc(a.role || '')}${a.market === 'US' ? ' · US' : ''}</div>
                      </td>
                      <td class="px-3 py-2 text-right tnum">
                        <button class="font-semibold underline decoration-dotted hover:text-blue-600" data-act="editShares" data-id="${esc(a.id)}">${n(a.shares).toLocaleString('ko-KR')}</button>
                      </td>
                      <td class="px-3 py-2 text-right tnum">${n(a.close) ? n(a.close).toLocaleString('ko-KR') : '—'}</td>
                      <td class="px-3 py-2 text-right tnum font-semibold">${esc(U.won(v))}</td>
                      <td class="px-3 py-2 text-right tnum">${cur.toFixed(1)}%</td>
                      <td class="px-3 py-2 text-right tnum whitespace-nowrap">
                        ${
                          uw
                            ? `${tgt.toFixed(1)}%
                        ${tgt > 0 || cur > 0 ? `<div class="${Math.abs(diff) < 2 ? 'text-green-600' : Math.abs(diff) < 5 ? 'text-amber-600' : 'text-red-600'}">${U.pctPt(diff)}</div>` : ''}`
                            : `<span class="text-slate-400 text-[11.5px]" title="${esc(wmOf.note || '')}">규칙</span>`
                        }
                      </td>
                    </tr>`
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
          <div class="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/40 text-[12px] text-slate-500 dark:text-slate-400 flex items-center justify-between gap-2 flex-wrap">
            <span>합계 <b class="tnum text-slate-700 dark:text-slate-200">${esc(U.won(st))}</b> ${
              uw
                ? `· 목표비중 합 ${sub.reduce((s, a) => s + n(a.target_pct), 0).toFixed(1)}%`
                : `· <span class="text-blue-600 dark:text-blue-400">규칙이 비중을 정합니다</span>`
            }</span>
            <button class="underline decoration-dotted hover:text-blue-600" data-act="goSettings" data-code="${esc(cfg.code)}">규칙 편집 →</button>
          </div>
        </div>`
      })
      .join('')

    const sheetExportCard = `
      <div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4 p-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div class="font-extrabold"><i class="fas fa-table text-green-600 mr-2"></i>Google Sheets 이관</div>
            <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-1">
              보유수량은 이 웹앱에서 수정·저장합니다. 필요할 때 현재 전체 보유내역을 탭 구분 텍스트로 복사하거나 파일로 내려받아 Google Sheets에 직접 붙여넣으세요.
            </div>
          </div>
          <div class="flex gap-1.5 flex-wrap">
            ${U.btn('<i class="fas fa-copy"></i> 전체 보유내역 복사', 'copyHoldingsTsv', 'btn-s')}
            ${U.btn('<i class="fas fa-file-arrow-down"></i> TSV 파일', 'downloadHoldingsTsv', 'btn-s')}
          </div>
        </div>
      </div>`

    return (
      U.sectionTitle('포트폴리오', '전략별 목표비중과 현재비중의 괴리를 확인합니다. 보유수량을 눌러 수정할 수 있습니다.') +
      sheetExportCard +
      `<div class="grid grid-cols-2 md:grid-cols-3 gap-2.5 mb-4">
        ${U.metric('총 자산', U.won(total), `활성 전략 ${cfgs.length}개`)}
        ${U.metric('자산군', `${cats.length}개`, cats.length ? `최대 ${esc(cats[0][0])} ${total > 0 ? ((cats[0][1] / total) * 100).toFixed(1) : '0'}%` : '')}
        ${U.metric('USD/KRW', fx ? n(fx).toFixed(1) : '—', assets.some((a) => a.market === 'US') ? '미국 종목 환산 적용' : '미국 종목 없음')}
      </div>` +
      catCard +
      stratCards
    )
  }

  ACTIONS.editShares = (e, el) => {
    const id = el.dataset.id
    const boot = stateOf()
    const row = (boot.assets || []).find((a) => a.id === id)
    if (!row) return
    const inp = window.prompt(`${row.name || row.ticker} 보유수량을 입력하세요. (현금이면 금액 원)`, String(n(row.shares)))
    if (inp === null) return
    const v = Number(String(inp).replace(/[,\s]/g, ''))
    if (!Number.isFinite(v)) return U.toast('숫자를 입력하세요.', 'err')
    saveAssets((boot.assets || []).map((a) => (a.id === id ? { ...a, shares: v } : a)))
  }

  function holdingsTsv() {
    const boot = stateOf()
    const accounts = new Map((boot.strategies || []).map((s) => [String(s.code || ''), String(s.account || '')]))
    const cols = ['strategy', 'account', 'ticker', 'name', 'market', 'category', 'role', 'target_pct', 'shares']
    const cell = (v) => String(v ?? '').replace(/[\\t\\r\\n]+/g, ' ')
    const lines = [cols.join('\\t')]
    for (const a of boot.assets || []) {
      lines.push([
        a.strategy,
        accounts.get(String(a.strategy || '')) || '',
        a.ticker,
        a.name,
        a.market,
        a.category,
        a.role,
        n(a.target_pct),
        n(a.shares),
      ].map(cell).join('\\t'))
    }
    return lines.join('\\n')
  }

  ACTIONS.copyHoldingsTsv = async () => {
    try {
      await navigator.clipboard.writeText(holdingsTsv())
      U.toast('현재 보유내역 전체를 복사했습니다. Google Sheets A1 셀에 붙여넣으세요.')
    } catch (err) {
      U.toast('클립보드 복사에 실패했습니다. TSV 파일을 이용하세요.', 'err')
    }
  }

  ACTIONS.downloadHoldingsTsv = () => {
    const blob = new Blob(['\\ufeff' + holdingsTsv()], { type: 'text/tab-separated-values;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `holdings-${U.today()}.tsv`
    a.click()
    URL.revokeObjectURL(a.href)
    U.toast('Google Sheets용 보유내역 파일을 만들었습니다.')
  }

  function snapshotTsv(date) {
    const h = (stateOf().history || []).find((x) => String(x.date) === String(date))
    if (!h) return ''
    const cols = ['date', 'saved_at', 'strategy', 'account', 'ticker', 'name', 'category', 'close', 'shares', 'value', 'weight_pct', 'target_pct']
    const cell = (v) => String(v ?? '').replace(/[\\t\\r\\n]+/g, ' ')
    const lines = [cols.join('\\t')]
    for (const r of h.composition || []) {
      lines.push([h.date, h.saved_at || '', r['전략'], r['계좌'], r['티커'], r['ETF'], r['분류'], n(r['종가']), n(r['보유수량']), n(r['현재금액']), n(r['현재비중']), n(r['목표비중'])].map(cell).join('\\t'))
    }
    return lines.join('\\n')
  }

  ACTIONS.copySnapshotTsv = async (e, el) => {
    const txt = snapshotTsv(el.dataset.date)
    if (!txt) return U.toast('해당 월 기록을 찾지 못했습니다.', 'err')
    try {
      await navigator.clipboard.writeText(txt)
      U.toast(`${el.dataset.date} 월별 포트폴리오 구성을 복사했습니다.`)
    } catch (err) {
      U.toast('클립보드 복사에 실패했습니다. TSV 파일을 이용하세요.', 'err')
    }
  }

  ACTIONS.downloadSnapshotTsv = (e, el) => {
    const txt = snapshotTsv(el.dataset.date)
    if (!txt) return U.toast('해당 월 기록을 찾지 못했습니다.', 'err')
    const blob = new Blob(['\\ufeff' + txt], { type: 'text/tab-separated-values;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `portfolio-snapshot-${el.dataset.date}.tsv`
    a.click()
    URL.revokeObjectURL(a.href)
    U.toast(`${el.dataset.date} 월별 기록 파일을 만들었습니다.`)
  }

  ACTIONS.goSettings = (e, el) => {
    U.S.editingCode = el.dataset.code
    U.S.page = 'settings'
    U.render()
    window.scrollTo({ top: 0 })
  }

  async function saveAssets(rows) {
    try {
      const res = await U.api.put('/api/assets', { assets: rows })
      stateOf().assets = res.assets
      U.toast('보유수량을 저장했습니다.')
      U.render()
      U.refreshPlan(false)
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  /* ═══════════════════════════ 기록 · 성과 ═══════════════════════════ */
  const RANGES = [
    { id: '1m', label: '1개월' },
    { id: '3m', label: '3개월' },
    { id: '6m', label: '6개월' },
    { id: '1y', label: '1년' },
    { id: 'ytd', label: '올해' },
    { id: 'all', label: '전체' },
  ]

  /** 경량 인라인 SVG 선그래프 — 외부 차트 라이브러리 없이 동작 */
  function lineChart(seriesList, opts = {}) {
    const h = opts.height || 190
    const pad = 6
    const all = seriesList.flatMap((s) => s.points.map((p) => p.value))
    if (!all.length) return `<div class="text-sm text-slate-500 p-6 text-center">표시할 데이터가 없습니다.</div>`
    let lo = Math.min(...all)
    let hi = Math.max(...all)
    if (hi - lo < 1e-9) {
      hi += 1
      lo -= 1
    }
    const span = hi - lo
    const W = 600
    const colors = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6', '#0891b2']
    const paths = seriesList.map((s, i) => {
      const pts = s.points
      if (!pts.length) return ''
      const d = pts
        .map((p, j) => {
          const x = pts.length === 1 ? W / 2 : (j / (pts.length - 1)) * W
          const y = h - pad - ((p.value - lo) / span) * (h - pad * 2)
          return `${j === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
      return `<path d="${d}" fill="none" stroke="${colors[i % colors.length]}" stroke-width="${i === 0 ? 2.4 : 1.6}" stroke-linejoin="round" ${i > 0 ? 'stroke-dasharray="4 3"' : ''} />`
    })
    const legend = seriesList
      .map((s, i) => `<span class="inline-flex items-center gap-1.5 mr-3 text-[12px]"><i style="display:inline-block;width:10px;height:3px;border-radius:2px;background:${colors[i % colors.length]}"></i>${esc(s.name)}</span>`)
      .join('')
    return `<div>
      <svg viewBox="0 0 ${W} ${h}" preserveAspectRatio="none" class="w-full" style="height:${h}px">
        <rect x="0" y="0" width="${W}" height="${h}" fill="none" />
        ${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${(h * f).toFixed(1)}" y2="${(h * f).toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />`).join('')}
        ${paths.join('')}
      </svg>
      <div class="mt-2 flex flex-wrap items-center">${legend}</div>
    </div>`
  }

  const pctOrDash = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : `${(Number(x) * 100).toFixed(2)}%`)
  const numOrDash = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? '—' : Number(x).toFixed(d))

  PAGES.history = function () {
    const boot = stateOf()
    const perf = U.S.perf
    const hist = (boot.history || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))

    const rangeBar = `<div class="flex gap-1.5 mb-4 overflow-x-auto pb-0.5">${RANGES.map(
      (r) =>
        `<button class="btn ${U.S.perfRange === r.id ? 'btn-p' : 'btn-s'} !py-1.5 !px-3 !text-[12px]" data-act="setRange" data-range="${r.id}">${r.label}</button>`,
    ).join('')}</div>`

    const rangeCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-chart-line text-blue-600"></i> 성과 분석</div>
        <div class="flex gap-1.5">
          ${U.btn('<i class="fas fa-arrows-rotate"></i> 새로고침', 'perfRefresh', 'btn-s')}
          ${U.btn('<i class="fas fa-ruler-combined"></i> 벤치마크 백필', 'benchBackfill', 'btn-s')}
        </div>
      </div>
      <div class="p-4">${
        !perf
          ? `<div class="text-sm text-slate-500 text-center py-4">기록이 부족합니다. [오늘] 탭에서 최소 2회 이상 스냅샷을 저장하면 지표가 계산됩니다.</div>`
          : `<div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
              ${U.metric('CAGR', pctOrDash(perf.metrics.cagr), '연환산 수익률', n(perf.metrics.cagr) >= 0 ? 'pos' : 'neg')}
              ${U.metric('MDD', pctOrDash(perf.metrics.mdd), perf.metrics.mddDetail?.ddLen != null ? `하락기간 ${perf.metrics.mddDetail.ddLen}일` : '', 'neg')}
              ${U.metric('XIRR', pctOrDash(perf.metrics.irr), '입출금 반영', n(perf.metrics.irr) >= 0 ? 'pos' : 'neg')}
              ${U.metric('TWR', pctOrDash(perf.metrics.twr), '입출금 효과 제거', n(perf.metrics.twr) >= 0 ? 'pos' : 'neg')}
              ${U.metric('변동성', pctOrDash(perf.metrics.vol))}
              ${U.metric('Sharpe', numOrDash(perf.metrics.sharpe))}
              ${U.metric('Sortino', numOrDash(perf.metrics.sortino))}
              ${U.metric('β / α', `${numOrDash(perf.metrics.beta)} / ${pctOrDash(perf.metrics.alpha)}`, perf.metrics.betaAgainst ? `vs ${esc(perf.metrics.betaAgainst)}` : '벤치마크 필요')}
            </div>
            <div class="tbl-wrap">${lineChart(
              [
                { name: '내 포트폴리오', points: perf.portfolioSeries || [] },
                ...Object.entries(perf.benchmarks || {}).map(([name, pts]) => ({ name, points: pts })),
              ],
              { height: 200 },
            )}</div>
            ${perf.metrics.mddDetail?.recLen != null ? `<div class="mt-2 text-[12px] text-slate-500">MDD 회복기간 ${perf.metrics.mddDetail.recLen}일</div>` : ''}`
      }</div>
    </div>`

    const stratPerf = perf?.strategies?.length
      ? `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
          <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-extrabold">전략별 성과</div>
          <div class="tbl-wrap"><table class="w-full text-[13px]">
            <thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500"><tr>
              <th class="text-left px-3 py-2 font-semibold">전략</th>
              <th class="text-right px-3 py-2 font-semibold">구간수익</th>
              <th class="text-right px-3 py-2 font-semibold">CAGR</th>
              <th class="text-right px-3 py-2 font-semibold">MDD</th>
              <th class="text-right px-3 py-2 font-semibold">TWR</th>
            </tr></thead><tbody>${perf.strategies
              .map(
                (s) => `<tr class="border-t border-slate-100 dark:border-slate-800">
                  <td class="px-3 py-2 font-semibold">${esc(strategyTitle(s.code))}</td>
                  <td class="px-3 py-2 text-right tnum ${n(s.periodReturn) >= 0 ? 'text-green-600' : 'text-red-600'}">${pctOrDash(s.periodReturn)}</td>
                  <td class="px-3 py-2 text-right tnum">${pctOrDash(s.cagr)}</td>
                  <td class="px-3 py-2 text-right tnum text-red-600">${pctOrDash(s.mdd)}</td>
                  <td class="px-3 py-2 text-right tnum">${pctOrDash(s.twr)}</td>
                </tr>`,
              )
              .join('')}</tbody></table></div>
        </div>`
      : ''

    const timeline = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-clock-rotate-left text-blue-600"></i> 스냅샷 타임라인 <span class="text-[12px] font-normal text-slate-500">${hist.length}건</span></div>
        <div class="flex gap-1.5">
          ${U.btn('<i class="fas fa-download"></i> 백업', 'downloadBackup', 'btn-s')}
          ${U.btn('<i class="fas fa-upload"></i> 복원', 'openRestore', 'btn-s')}
        </div>
      </div>
      ${
        hist.length
          ? `<ul class="divide-y divide-slate-100 dark:divide-slate-800">${hist
              .map(
                (h, i) => `<li class="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                <div class="min-w-0">
                  <div class="font-semibold tnum">${esc(h.date)} ${i === 0 ? '<span class="text-[11px] bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded ml-1">최신</span>' : ''}</div>
                  <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5 tnum">
                    ${esc(U.won(h.total))}
                    ${h.saved_at ? ` · ${esc(h.saved_at)} 저장` : ''}
                  </div>
                </div>
                <div class="flex gap-1.5 shrink-0">
                  ${U.btn('<i class="fas fa-copy"></i> 한 줄 복사', 'copyRow', 'btn-s !py-1.5 !px-2.5 !text-[12px]', `data-date="${esc(h.date)}"`)}
                  ${U.btn('<i class="fas fa-table"></i> 시트용 복사', 'copySnapshotTsv', 'btn-s !py-1.5 !px-2.5 !text-[12px]', `data-date="${esc(h.date)}"`)}
                  ${U.btn('<i class="fas fa-file-arrow-down"></i>', 'downloadSnapshotTsv', 'btn-s !py-1.5 !px-2.5 !text-[12px]', `data-date="${esc(h.date)}" title="월별 구성 TSV"`)}
                  ${U.btn('<i class="fas fa-trash"></i>', 'delSnapshot', 'btn-d !py-1.5 !px-2.5 !text-[12px]', `data-date="${esc(h.date)}"`)}
                </div>
              </li>`,
              )
              .join('')}</ul>`
          : `<div class="p-6 text-center text-sm text-slate-500">아직 저장된 기록이 없습니다. [오늘] 탭에서 “기록 저장”을 눌러주세요.</div>`
      }
    </div>`

    const cfs = (boot.cashflows || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const cfCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-money-bill-transfer text-blue-600"></i> 입출금 원장 <span class="text-[12px] font-normal text-slate-500">${cfs.length}건</span></div>
        ${U.btn('<i class="fas fa-plus"></i> 추가', 'addCashflow', 'btn-s')}
      </div>
      ${
        cfs.length
          ? `<div class="tbl-wrap"><table class="w-full text-[13px]"><thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500"><tr>
              <th class="text-left px-3 py-2 font-semibold">날짜</th>
              <th class="text-right px-3 py-2 font-semibold">금액</th>
              <th class="text-left px-3 py-2 font-semibold">전략</th>
              <th class="text-left px-3 py-2 font-semibold">메모</th>
              <th class="px-3 py-2"></th>
            </tr></thead><tbody>${cfs
              .map(
                (f, i) => `<tr class="border-t border-slate-100 dark:border-slate-800">
                <td class="px-3 py-2 tnum">${esc(f.date)}</td>
                <td class="px-3 py-2 text-right tnum ${n(f.amount) >= 0 ? 'text-green-600' : 'text-red-600'}">${esc(U.signed(f.amount))}</td>
                <td class="px-3 py-2">${esc(f.strategy || '—')}</td>
                <td class="px-3 py-2 text-slate-500">${esc(f.memo || '')}</td>
                <td class="px-3 py-2 text-right">${U.btn('<i class="fas fa-xmark"></i>', 'delCashflow', 'btn-s !py-1 !px-2 !text-[12px]', `data-idx="${i}"`)}</td>
              </tr>`,
              )
              .join('')}</tbody></table></div>`
          : `<div class="p-6 text-center text-sm text-slate-500">입출금 기록이 없습니다. XIRR 계산에 필요합니다.</div>`
      }
    </div>`

    const restore = U.S.showJson
      ? `<div class="card bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800 shadow-sm mb-4">
          <div class="px-4 py-3 border-b border-amber-200 dark:border-amber-900 font-extrabold text-amber-700 dark:text-amber-300">백업 JSON 복원</div>
          <div class="p-4">
            <textarea id="restore-json" class="inp h-40 font-mono text-[12px]" placeholder="여기에 백업 JSON 을 붙여넣으세요">${esc(U.S.restoreText)}</textarea>
            <div class="flex gap-2 mt-3">
              ${U.btn('복원 실행', 'doRestore', 'btn-p')}
              ${U.btn('닫기', 'closeRestore', 'btn-s')}
            </div>
            <div class="text-[12px] text-amber-700 dark:text-amber-400 mt-2">⚠️ 현재 데이터를 덮어씁니다. 먼저 백업을 내려받는 것을 권장합니다.</div>
          </div>
        </div>`
      : ''

    return (
      U.sectionTitle('기록 · 성과', '스냅샷을 쌓아 CAGR·MDD·XIRR·TWR 을 계산하고 벤치마크와 비교합니다.') +
      rangeBar +
      restore +
      timeline +
      rangeCard +
      stratPerf +
      cfCard
    )
  }

  ACTIONS.setRange = async (e, el) => {
    U.S.perfRange = el.dataset.range
    await loadPerf()
    U.render()
  }
  ACTIONS.perfRefresh = async () => {
    await loadPerf()
    U.render()
    U.toast('성과를 다시 계산했습니다.')
  }

  async function loadPerf() {
    try {
      U.S.perf = await U.api.get(`/api/performance?range=${encodeURIComponent(U.S.perfRange)}`)
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }
  U.loadPerf = loadPerf

  ACTIONS.benchBackfill = async (e, el) => {
    el.disabled = true
    el.innerHTML = '<i class="fas fa-circle-notch spin"></i> 백필 중…'
    try {
      const r = await U.api.post('/api/benchmarks/backfill', {})
      U.toast(`벤치마크 ${r.added}건 추가${r.errors?.length ? ` (오류 ${r.errors.length}건)` : ''}`)
      await loadPerf()
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
      el.disabled = false
      el.innerHTML = '<i class="fas fa-ruler-combined"></i> 벤치마크 백필'
    }
  }

  ACTIONS.copyRow = async (e, el) => {
    try {
      const r = await U.api.get(`/api/history/${encodeURIComponent(el.dataset.date)}/row`)
      await navigator.clipboard.writeText(r.row)
      U.toast('스프레드시트용 한 줄을 복사했습니다.')
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.delSnapshot = async (e, el) => {
    if (!window.confirm(`${el.dataset.date} 기록을 삭제할까요?`)) return
    try {
      await U.api.del(`/api/history/${encodeURIComponent(el.dataset.date)}`)
      U.S.boot = await U.api.get('/api/bootstrap')
      await loadPerf()
      U.toast('삭제했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.addCashflow = async () => {
    const date = window.prompt('날짜 (YYYY-MM-DD)', U.today())
    if (!date) return
    const amount = window.prompt('금액 (입금은 양수, 출금은 음수)', '1000000')
    if (amount === null) return
    const memo = window.prompt('메모', '') || ''
    const strategy = window.prompt('전략 코드 (선택, 비우면 전체)', '') || ''
    const cur = stateOf().cashflows || []
    const next = [...cur, { date, amount: Number(String(amount).replace(/[,\s]/g, '')), memo, strategy }]
    try {
      await U.api.put('/api/cashflows', { cashflows: next })
      U.S.boot = await U.api.get('/api/bootstrap')
      await loadPerf()
      U.toast('입출금을 추가했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.delCashflow = async (e, el) => {
    const idx = Number(el.dataset.idx)
    const cur = stateOf().cashflows || []
    try {
      await U.api.put('/api/cashflows', { cashflows: cur.filter((_, i) => i !== idx) })
      U.S.boot = await U.api.get('/api/bootstrap')
      await loadPerf()
      U.toast('삭제했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.downloadBackup = async () => {
    try {
      const data = await U.api.get('/api/backup')
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `asset-rebalance-backup-${U.today()}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      U.toast('백업 파일을 내려받았습니다.')
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.openRestore = () => {
    U.S.showJson = true
    U.render()
  }
  ACTIONS.closeRestore = () => {
    U.S.showJson = false
    U.render()
  }
  ACTIONS.doRestore = async () => {
    const ta = document.getElementById('restore-json')
    U.S.restoreText = ta ? ta.value : ''
    let parsed
    try {
      parsed = JSON.parse(U.S.restoreText)
    } catch {
      return U.toast('JSON 형식이 올바르지 않습니다.', 'err')
    }
    try {
      const r = await U.api.post('/api/restore', parsed)
      U.S.showJson = false
      U.S.boot = await U.api.get('/api/bootstrap')
      await U.reloadBoot()
      U.toast(`복원 완료 — 전략 ${r.counts.strategies}개 · 종목 ${r.counts.assets}개 · 기록 ${r.counts.history}건`)
      await loadPerf()
      U.render()
      U.refreshPlan(false)
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  /* ═══════════════════════════ 설정 ═══════════════════════════ */
  const PCT_INDICATORS = ['sma', 'momentum', 'drawdown']
  const OP_TXT = { '>': '상회', '>=': '이상', '<': '하회', '<=': '이하' }
  const OP_OPTIONS = [
    { v: '>', t: '상회 (초과)' },
    { v: '>=', t: '이상' },
    { v: '<', t: '하회 (미만)' },
    { v: '<=', t: '이하' },
  ]
  const INDICATOR_OPTIONS = [
    { v: 'sma', t: 'SMA 대비 — 이동평균 상회/하회' },
    { v: 'momentum', t: '모멘텀 — 기간 수익률' },
    { v: 'drawdown', t: '낙폭 — 고점 대비 하락률' },
    { v: 'price', t: '현재 가격 — 절대값 비교' },
  ]
  const ALLOC_OPTIONS = [
    { v: 'target', t: '목표비중으로 복원' },
    { v: 'hold', t: '그대로 유지 (매매 없음)' },
    { v: 'cash', t: '전량 현금화' },
    { v: 'buy_from_cash', t: '현금에서 일부 매수' },
    { v: 'winner', t: '모멘텀 1위 종목에 집중' },
  ]

  const thrDisplay = (c) => (PCT_INDICATORS.includes(c.indicator) ? +(n(c.threshold) * 100).toFixed(4) : n(c.threshold))
  const thrStore = (c, v) => (PCT_INDICATORS.includes(c.indicator) ? n(v) / 100 : n(v))
  const thrUnit = (c) => (c.indicator === 'price' ? '원' : '%')

  /** 서버의 describeCondition 과 동일한 문장 생성 */
  function describeCond(c) {
    const src = String(c.source_ticker || '').trim() || '자기 종목'
    const unit = c.period_unit === 'months' ? '개월' : '일'
    const tgt = String(c.target || '').trim() ? `[${c.target}] ` : ''
    const opTxt = OP_TXT[c.op] || c.op
    if (c.indicator === 'sma') {
      return `${tgt}${src} 현재가가 SMA ${c.period}${unit} ${opTxt}${n(c.threshold) !== 0 ? ` (기준 ${(n(c.threshold) * 100).toFixed(1)}%)` : ''}`
    }
    if (c.indicator === 'momentum') return `${tgt}${src} ${c.period}${unit} 수익률 ${opTxt} ${(n(c.threshold) * 100).toFixed(1)}%`
    if (c.indicator === 'drawdown') return `${tgt}${src} 고점대비(${c.period}${unit}) 낙폭 ${opTxt} ${(n(c.threshold) * 100).toFixed(1)}%`
    return `${tgt}${src} 현재가 ${opTxt} ${Math.round(n(c.threshold)).toLocaleString('ko-KR')}`
  }

  const DEFAULT_COND = () => ({
    id: 'c' + Math.random().toString(36).slice(2, 8),
    source_ticker: '',
    source_market: 'US',
    target: '',
    indicator: 'sma',
    period: 10,
    period_unit: 'months',
    op: '>',
    threshold: 0,
  })

  /** 서버가 내려준 기본값 (설정 페이지가 열릴 때 캐시) */
  const visDefaults = () => {
    const d = (stateOf().visualMeta || {}).defaults
    if (d && d.conditions) return d
    return { conditions: [DEFAULT_COND()], mode: 'all', on_pass: 'target', on_fail: 'cash', restore_timing: 'quarter_end' }
  }

  function ensureDraft(code) {
    const spec = specOf(code)
    if (!spec) return null
    if (U.S.ruleDraft && U.S.ruleDraft.code === code) return U.S.ruleDraft
    const rule = spec.rule || 'visual'
    const params = JSON.parse(JSON.stringify(spec.params || {}))
    if (rule === 'visual') {
      const d = visDefaults()
      if (!Array.isArray(params.conditions) || !params.conditions.length) {
        params.conditions = JSON.parse(JSON.stringify(d.conditions))
      }
      params.mode = params.mode || d.mode || 'all'
      params.on_pass = params.on_pass || d.on_pass || 'target'
      params.on_fail = params.on_fail || d.on_fail || 'cash'
      params.restore_timing = params.restore_timing || d.restore_timing || 'quarter_end'
    }
    U.S.ruleDraft = {
      code,
      rule,
      params,
      description: spec.description || '',
      assets: JSON.parse(JSON.stringify(spec.assets || [])),
    }
    U.S.preview = null
    return U.S.ruleDraft
  }
  U.ensureDraft = ensureDraft

  const sel = (opts, val, act, extra = '') =>
    `<select class="inp" data-onchange="${act}" ${extra}>${opts
      .map((o) => `<option value="${esc(o.v)}" ${String(o.v) === String(val) ? 'selected' : ''}>${esc(o.t)}</option>`)
      .join('')}</select>`

  /* ---------- 조건 1개 카드 ---------- */
  function condRow(c, idx, total) {
    return `<div class="cond-row border border-slate-200 dark:border-slate-700 rounded-xl p-3 bg-slate-50/60 dark:bg-slate-800/40">
      <div class="flex items-center justify-between gap-2 mb-2">
        <div class="text-[12px] font-bold text-slate-500 dark:text-slate-400">조건 ${idx + 1}</div>
        <div class="flex items-center gap-1">
          ${
            total > 1
              ? `<button class="btn btn-s !py-1 !px-2 !text-[12px]" data-act="condUp" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="위로"><i class="fas fa-arrow-up"></i></button>
                 <button class="btn btn-s !py-1 !px-2 !text-[12px]" data-act="condDown" data-idx="${idx}" ${idx === total - 1 ? 'disabled' : ''} title="아래로"><i class="fas fa-arrow-down"></i></button>`
              : ''
          }
          <button class="btn btn-d !py-1 !px-2 !text-[12px]" data-act="condDel" data-idx="${idx}" title="삭제"><i class="fas fa-trash"></i></button>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">기준 티커 <span class="text-slate-400 font-normal">(비우면 자기 종목)</span></span>
          <input class="inp mt-1" value="${esc(c.source_ticker || '')}" placeholder="예: QQQ" data-oninput="condField" data-idx="${idx}" data-field="source_ticker" />
        </label>
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">기준 시장</span>
          ${sel([{ v: 'US', t: '미국 (US)' }, { v: 'KR', t: '한국 (KR)' }], c.source_market || 'US', 'condField', `data-idx="${idx}" data-field="source_market"`)}
        </label>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-2.5">
        <label class="block sm:col-span-2">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">모멘텀 기준</span>
          ${sel(INDICATOR_OPTIONS, c.indicator, 'condField', `data-idx="${idx}" data-field="indicator"`)}
        </label>
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">기간 / 단위</span>
          <div class="flex gap-1.5 mt-1">
            <input type="number" class="inp" min="1" max="500" value="${n(c.period, 10)}" data-oninput="condField" data-idx="${idx}" data-field="period" />
            ${sel([{ v: 'months', t: '개월' }, { v: 'days', t: '일' }], c.period_unit || 'months', 'condField', `data-idx="${idx}" data-field="period_unit"`)}
          </div>
        </label>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 mt-2.5">
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">상회 여부</span>
          ${sel(OP_OPTIONS, c.op || '>', 'condField', `data-idx="${idx}" data-field="op"`)}
        </label>
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">임계값 (${thrUnit(c)})</span>
          <input type="number" step="0.01" class="inp mt-1" value="${thrDisplay(c)}" data-oninput="condField" data-idx="${idx}" data-field="threshold" data-pct="${PCT_INDICATORS.includes(c.indicator) ? '1' : '0'}" />
        </label>
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">적용 대상 <span class="text-slate-400 font-normal">(선택)</span></span>
          <input class="inp mt-1" value="${esc(c.target || '')}" placeholder="role 또는 티커" data-oninput="condField" data-idx="${idx}" data-field="target" />
        </label>
      </div>

      <div class="mt-2.5 text-[12px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2">
        <i class="fas fa-quote-left text-slate-400 mr-1"></i><span class="font-semibold">${esc(describeCond(c))}</span>
      </div>
    </div>`
  }

  /* ---------- 서버 판정 결과 ---------- */
  function previewCard() {
    const p = U.S.preview
    if (!p) return ''
    if (p.loading) {
      return `<div class="mt-3 text-[13px] text-slate-500"><i class="fas fa-circle-notch spin mr-1"></i> 현재 데이터로 판정 중…</div>`
    }
    if (p.error) return `<div class="mt-3 text-[13px] text-red-600">${esc(p.error)}</div>`
    const rs = p.results || []
    if (!rs.length) return ''
    const rows = rs
      .map((r) => {
        const mark = r.passed === true ? '✅ 충족' : r.passed === false ? '❌ 미충족' : '⚠️ 데이터 부족'
        const tone = r.passed === true ? 'text-green-600' : r.passed === false ? 'text-red-600' : 'text-amber-600'
        const val =
          r.value === null || r.value === undefined
            ? '—'
            : Math.abs(n(r.value)) < 10 && Math.abs(n(r.value)) > 0.0000001
              ? `${(n(r.value) * 100).toFixed(2)}%`
              : n(r.value).toLocaleString('ko-KR', { maximumFractionDigits: 2 })
        return `<li class="px-3 py-2 flex items-start justify-between gap-3 border-t border-slate-100 dark:border-slate-800 first:border-0">
          <span class="text-[12.5px]">${esc(r.label)}</span>
          <span class="shrink-0 text-right">
            <b class="${tone} text-[12.5px]">${mark}</b>
            <span class="block text-[11px] text-slate-400 tnum">현재값 ${esc(val)}</span>
          </span>
        </li>`
      })
      .join('')
    const overall = rs.every((r) => r.passed === null)
      ? null
      : U.S.ruleDraft.params.mode === 'any'
        ? rs.some((r) => r.passed === true)
        : rs.every((r) => r.passed === true)
    const overallTxt =
      overall === null
        ? '<span class="text-amber-600">⚠️ 판정 불가 (데이터 부족)</span>'
        : overall
          ? `<span class="text-green-600 font-bold">✅ 조건 충족 → “${esc(allocLabel(U.S.ruleDraft.params.on_pass))}”</span>`
          : `<span class="text-red-600 font-bold">❌ 조건 미충족 → “${esc(allocLabel(U.S.ruleDraft.params.on_fail))}”</span>`
    return `<div class="mt-3 card border border-blue-200 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/30 overflow-hidden">
      <div class="px-3 py-2 border-b border-blue-200 dark:border-blue-900 text-[12px] font-bold text-blue-800 dark:text-blue-300">
        <i class="fas fa-eye mr-1"></i> 지금 이 규칙은? (${esc(p.date || '')})
      </div>
      <ul>${rows}</ul>
      <div class="px-3 py-2 border-t border-blue-200 dark:border-blue-900 text-[12.5px] bg-white/60 dark:bg-slate-900/40">${overallTxt}</div>
    </div>`
  }

  const allocLabel = (v) => {
    const m = (stateOf().visualMeta || {}).allocModes || {}
    return m[v] || (ALLOC_OPTIONS.find((o) => o.v === v) || {}).t || v
  }
  const indLabel = (v) => {
    const m = (stateOf().visualMeta || {}).indicators || {}
    return m[v] || (INDICATOR_OPTIONS.find((o) => o.v === v) || {}).t || v
  }
  void indLabel

  /* ---------- 노코드 규칙 빌더 ---------- */
  function visualBuilder(d) {
    const p = d.params
    const conds = p.conditions || []
    const needsWinner = p.on_pass === 'winner' || p.on_fail === 'winner'
    const needsBuy = p.on_pass === 'buy_from_cash' || p.on_fail === 'buy_from_cash'
    return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div class="font-extrabold flex items-center gap-2"><i class="fas fa-wand-magic-sparkles text-blue-600"></i> 규칙 만들기 (코딩 없이)</div>
          <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">조건을 문장처럼 조립하면 됩니다. 예: “QQQ 현재가가 SMA 10개월 상회 → 목표비중 복원”</div>
        </div>
        ${U.btn('<i class="fas fa-plus"></i> 조건 추가', 'condAdd', 'btn-s')}
      </div>

      <div class="p-4 space-y-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">조건 결합</span>
          <div class="inline-flex rounded-lg border border-slate-300 dark:border-slate-700 overflow-hidden">
            <button class="px-3 py-1.5 text-[12px] font-semibold ${p.mode !== 'any' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}" data-act="setMode" data-mode="all">모두 충족 (그리고)</button>
            <button class="px-3 py-1.5 text-[12px] font-semibold ${p.mode === 'any' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300'}" data-act="setMode" data-mode="any">하나라도 충족 (또는)</button>
          </div>
        </div>

        ${conds.map((c, i) => condRow(c, i, conds.length)).join('') || `<div class="text-sm text-slate-500 text-center py-4">조건이 없습니다. “조건 추가”를 눌러주세요.</div>`}

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
          <label class="block">
            <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">조건 충족 시 (매수 유지 등)</span>
            ${sel(ALLOC_OPTIONS, p.on_pass, 'paramField', 'data-path="on_pass"')}
          </label>
          <label class="block">
            <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">조건 미충족 시</span>
            ${sel(ALLOC_OPTIONS, p.on_fail, 'paramField', 'data-path="on_fail"')}
          </label>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label class="block">
            <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">목표비중 복원 시점</span>
            ${sel(
              [
                { v: 'quarter_end', t: '분기말에만 복원' },
                { v: 'always', t: '항상 복원' },
              ],
              p.restore_timing,
              'paramField',
              'data-path="restore_timing"',
            )}
          </label>
          ${
            needsBuy
              ? `<label class="block">
                  <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">현금 투입 비율 (%)</span>
                  <input type="number" class="inp mt-1" min="0" max="100" value="${(n(p.buy_fraction, 0.5) * 100).toFixed(0)}" data-oninput="paramFieldPct" data-path="buy_fraction" />
                </label>`
              : '<div></div>'
          }
          ${
            needsWinner
              ? `<label class="block">
                  <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">1위 종목 투자비중 (%)</span>
                  <input type="number" class="inp mt-1" min="0" max="100" value="${(n(p.winner_share, 0.8) * 100).toFixed(0)}" data-oninput="paramFieldPct" data-path="winner_share" />
                </label>
                <label class="block sm:col-span-2">
                  <span class="flex items-center gap-2 text-[12px] font-semibold text-slate-600 dark:text-slate-300">
                    <input type="checkbox" class="w-4 h-4 accent-blue-600" ${p.winner_sma_filter ? 'checked' : ''} data-onchange="paramCheck" data-path="winner_sma_filter" />
                    SMA 를 상회하는 후보 중에서만 1위 선정
                  </span>
                </label>`
              : ''
          }
        </div>

        ${previewCard()}

        <div class="flex items-center gap-2 pt-1 flex-wrap">
          ${U.btn('<i class="fas fa-eye"></i> 지금 판정해보기', 'previewCond', 'btn-s')}
          ${U.btn('<i class="fas fa-floppy-disk"></i> 이 규칙 저장', 'saveSpec', 'btn-p')}
          ${U.btn('<i class="fas fa-code"></i> JSON 보기', 'toggleJson', 'btn-s')}
        </div>

        ${
          U.S.showJson
            ? `<pre class="mt-2 text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto">${esc(JSON.stringify({ rule: d.rule, params: d.params, assets: d.assets }, null, 2))}</pre>`
            : ''
        }
      </div>
    </div>`
  }

  /* ---------- 레거시 규칙용 자동 폼 ---------- */
  function legacyBuilder(d) {
    const schema = ((stateOf().ruleMeta || {}).uiSchema || {})[d.rule] || []
    const get = (path) => path.reduce((o, k) => (o == null ? undefined : o[k]), d.params)
    const setPath = (path, v) => {
      let o = d.params
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof o[path[i]] !== 'object' || o[path[i]] === null) o[path[i]] = {}
        o = o[path[i]]
      }
      o[path[path.length - 1]] = v
    }
    const fields = schema
      .map((f, i) => {
        const val = get(f.path)
        const pathStr = JSON.stringify(f.path)
        const label = `<span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">${esc(f.label)}${f.help ? `<span class="block font-normal text-slate-400 mt-0.5">${esc(f.help)}</span>` : ''}</span>`
        if (f.type === 'bool') {
          return `<label class="block">${label}<div class="mt-1.5"><input type="checkbox" class="w-4 h-4 accent-blue-600" ${val ? 'checked' : ''} data-onchange="legacyCheck" data-path='${esc(pathStr)}' /></div></label>`
        }
        if (f.type === 'select') {
          return `<label class="block">${label}${sel((f.options || []).map((o) => ({ v: o, t: o })), val ?? f.default, 'legacyField', `data-path='${esc(pathStr)}'`)}</label>`
        }
        if (f.type === 'fraction_pct') {
          const shown = val === undefined || val === null ? (f.default ?? 0) * 100 : n(val) * 100
          return `<label class="block">${label}<input type="number" step="0.1" class="inp mt-1" value="${shown}" data-oninput="legacyPct" data-path='${esc(pathStr)}' /></label>`
        }
        if (f.type === 'int' || f.type === 'float') {
          return `<label class="block">${label}<input type="number" step="${f.type === 'int' ? 1 : 0.1}" class="inp mt-1" value="${val ?? f.default ?? 0}" data-oninput="legacyNum" data-path='${esc(pathStr)}' /></label>`
        }
        if (f.type === 'csv_list') {
          const arr = Array.isArray(val) ? val : f.default || []
          return `<label class="block sm:col-span-2">${label}<input class="inp mt-1" value="${esc(arr.join(', '))}" data-oninput="legacyCsv" data-path='${esc(pathStr)}' /></label>`
        }
        return `<label class="block sm:col-span-2">${label}<input class="inp mt-1" value="${esc(val ?? f.default ?? '')}" data-oninput="legacyField" data-path='${esc(pathStr)}' /></label>`
      })
      .join('')
    return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-sliders text-blue-600"></i> 규칙 파라미터</div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">이 전략은 내장 규칙을 사용합니다. 값을 조정한 뒤 저장하세요.</div>
      </div>
      <div class="p-4">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">${fields || '<div class="text-sm text-slate-500">조정할 파라미터가 없습니다.</div>'}</div>
        <div class="flex items-center gap-2 mt-4 flex-wrap">
          ${U.btn('<i class="fas fa-floppy-disk"></i> 저장', 'saveSpec', 'btn-p')}
          ${U.btn('<i class="fas fa-wand-magic-sparkles"></i> 노코드 규칙으로 전환', 'switchVisual', 'btn-s')}
          ${U.btn('<i class="fas fa-code"></i> JSON 보기', 'toggleJson', 'btn-s')}
        </div>
        ${U.S.showJson ? `<pre class="mt-3 text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto">${esc(JSON.stringify({ rule: d.rule, params: d.params }, null, 2))}</pre>` : ''}
      </div>
    </div>`
  }

  /* ---------- 자산 목록 편집 ---------- */
  function assetEditor(d) {
    const cats = stateOf().categories || []
    const wm = weightMetaFor(d.code)
    const usesWeights = wm.usesWeights !== false
    const sum = d.assets.reduce((s, a) => s + n(a.target_pct), 0)
    const rows = d.assets
      .map(
        (a, i) => `<tr class="border-t border-slate-100 dark:border-slate-800">
        <td class="px-2 py-2"><input class="inp !py-1.5 !text-[12.5px]" value="${esc(a.ticker || '')}" placeholder="CASH 또는 코드" data-oninput="assetField" data-idx="${i}" data-field="ticker" /></td>
        <td class="px-2 py-2"><input class="inp !py-1.5 !text-[12.5px] min-w-[140px]" value="${esc(a.name || '')}" data-oninput="assetField" data-idx="${i}" data-field="name" /></td>
        <td class="px-2 py-2">${sel([{ v: 'KR', t: 'KR' }, { v: 'US', t: 'US' }], a.market || 'KR', 'assetField', `data-idx="${i}" data-field="market"`)}</td>
        <td class="px-2 py-2"><input class="inp !py-1.5 !text-[12.5px] min-w-[110px]" value="${esc(a.role || '')}" data-oninput="assetField" data-idx="${i}" data-field="role" /></td>
        <td class="px-2 py-2">${sel(cats.map((c) => ({ v: c, t: c })), a.category || '기타', 'assetField', `data-idx="${i}" data-field="category"`)}</td>
        <td class="px-2 py-2 text-right">${
          usesWeights
            ? `<input type="number" step="0.1" class="inp !py-1.5 !text-[12.5px] !w-20 text-right" value="${n(a.target_pct)}" data-oninput="assetPct" data-idx="${i}" />`
            : `<span class="text-slate-400" title="이 전략은 규칙이 비중을 정합니다">—</span>`
        }</td>
        <td class="px-2 py-2 text-right"><button class="btn btn-d !py-1 !px-2 !text-[12px]" data-act="assetDel" data-idx="${i}"><i class="fas fa-trash"></i></button></td>
      </tr>`,
      )
      .join('')
    return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div class="font-extrabold flex items-center gap-2"><i class="fas fa-basket-shopping text-blue-600"></i> 자산 목록${usesWeights ? ' · 목표비중' : ''}</div>
          <div class="text-[12px] mt-0.5 ${usesWeights ? (Math.abs(sum - 100) < 0.05 ? 'text-green-600' : 'text-amber-600') : 'text-slate-500 dark:text-slate-400'}">${
            usesWeights
              ? `목표비중 합계 ${sum.toFixed(1)}% ${Math.abs(sum - 100) < 0.05 ? '(정상)' : '(100% 로 맞추는 것을 권장)'}`
              : esc(wm.note || '이 전략은 규칙이 비중을 정합니다.')
          }</div>
        </div>
        <div class="flex gap-1.5 flex-wrap items-center">
          ${U.btn('<i class="fas fa-floppy-disk"></i> 변경 저장', 'assetSave', 'btn-p !py-1.5')}
          ${U.btn('<i class="fas fa-rotate-left"></i> 실행취소', 'assetUndo', 'btn-s')}
          ${U.btn('<i class="fas fa-plus"></i> 종목 추가', 'assetAdd', 'btn-s')}
          ${U.btn('<i class="fas fa-magnifying-glass"></i> 종목 검색', 'openSearch', 'btn-s')}
        </div>
      </div>
      <div class="tbl-wrap"><table class="w-full text-[12.5px]">
        <thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500"><tr>
          <th class="text-left px-2 py-2 font-semibold">티커</th>
          <th class="text-left px-2 py-2 font-semibold">종목명</th>
          <th class="text-left px-2 py-2 font-semibold">시장</th>
          <th class="text-left px-2 py-2 font-semibold">역할(role)</th>
          <th class="text-left px-2 py-2 font-semibold">자산군</th>
          <th class="text-right px-2 py-2 font-semibold">${usesWeights ? '목표%' : '비중'}</th>
          <th class="px-2 py-2"></th>
        </tr></thead><tbody>${rows || '<tr><td colspan="7" class="px-3 py-6 text-center text-slate-500">자산이 없습니다.</td></tr>'}</tbody>
      </table></div>
      <div class="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/40 border-t border-slate-200 dark:border-slate-800 text-[12px] ${
        usesWeights ? 'text-slate-500 dark:text-slate-400' : 'text-blue-700 dark:text-blue-300'
      }">
        <i class="fas fa-circle-info mr-1"></i>${
          usesWeights
            ? '종목·목표%를 수정한 뒤 <b>[변경 저장]</b> 을 누르면 보유수량은 그대로 둔 채 목록이 반영됩니다.'
            : `${esc(wm.note || '이 전략은 규칙이 비중을 정합니다.')} 종목 구성만 수정하고 <b>[변경 저장]</b> 을 누르세요.`
        }
      </div>
      ${quickPickPanel()}
      ${U.S.searched ? searchPanel() : ''}
    </div>`
  }

  /** 즐겨찾기 · 최근 사용 티커 빠른 추가 패널 */
  function quickPickPanel() {
    const boot = stateOf()
    const favs = boot.favoriteTickers || []
    const recents = boot.recentTickers || []
    if (!favs.length && !recents.length) return ''
    const chips = (list, mode) =>
      list
        .map(
          (t) => `<span class="inline-flex items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 pl-2 pr-1 py-1 text-[12px]">
          <button class="font-semibold hover:text-blue-600" data-act="quickPick" data-ticker="${esc(t.ticker)}" data-name="${esc(t.name)}" data-market="${esc(t.market)}">${esc(t.name || t.ticker)} <span class="text-slate-400 font-normal">${esc(t.ticker)}</span></button>
          ${mode === 'fav' ? `<button class="text-slate-400 hover:text-red-600 px-0.5" data-act="favRemove" data-ticker="${esc(t.ticker)}" data-market="${esc(t.market)}" title="즐겨찾기 해제"><i class="fas fa-xmark"></i></button>` : ''}
        </span>`,
        )
        .join(' ')
    return `<div class="border-t border-slate-200 dark:border-slate-800 p-3 space-y-2">
      ${
        favs.length
          ? `<div><div class="text-[11.5px] font-semibold text-slate-500 mb-1.5"><i class="fas fa-star text-amber-500 mr-1"></i> 즐겨찾기</div><div class="flex flex-wrap gap-1.5">${chips(favs, 'fav')}</div></div>`
          : ''
      }
      ${
        recents.length
          ? `<div><div class="text-[11.5px] font-semibold text-slate-500 mb-1.5"><i class="fas fa-clock-rotate-left mr-1"></i> 최근 사용</div><div class="flex flex-wrap gap-1.5">${chips(recents.slice(0, 10), 'recent')}</div></div>`
          : ''
      }
    </div>`
  }

  function searchPanel() {
    const s = U.S.searched
    return `<div class="border-t border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-800/40">
      <div class="flex gap-1.5 items-center flex-wrap">
        <input id="search-q" class="inp !w-auto flex-1 min-w-[160px]" placeholder="종목명 또는 코드 (예: 나스닥, QQQ)" value="${esc(s.q || '')}" data-oninput="searchQ" />
        ${sel(
          [
            { v: 'KR', t: '한국' },
            { v: 'US', t: '미국' },
          ],
          s.market || 'KR',
          'searchMarket',
        )}
        ${U.btn('<i class="fas fa-magnifying-glass"></i> 검색', 'doSearch', 'btn-p !py-1.5')}
        ${U.btn('닫기', 'closeSearch', 'btn-s !py-1.5')}
      </div>
      ${
        s.loading
          ? '<div class="text-[13px] text-slate-500 mt-2"><i class="fas fa-circle-notch spin mr-1"></i> 검색 중…</div>'
          : s.results && s.results.length
            ? `<ul class="mt-2 divide-y divide-slate-200 dark:divide-slate-700">${s.results
                .map(
                  (r) => `<li class="py-2 flex items-center justify-between gap-2">
                  <div class="min-w-0"><div class="font-semibold text-[13px]">${esc(r.name)}</div>
                  <div class="text-[11px] text-slate-400">${esc(r.ticker)}${r.exchange ? ` · ${esc(r.exchange)}` : ''}</div></div>
                  <button class="btn btn-s !py-1 !px-2.5 !text-[12px] shrink-0" data-act="searchPick" data-ticker="${esc(r.ticker)}" data-name="${esc(r.name)}"><i class="fas fa-plus"></i> 추가</button>
                </li>`,
                )
                .join('')}</ul>`
            : s.done
              ? '<div class="text-[13px] text-slate-500 mt-2">검색 결과가 없습니다.</div>'
              : ''
      }
    </div>`
  }

  /* ---------- 설정 페이지 전체 ---------- */
  PAGES.settings = function () {
    const boot = stateOf()
    if (!boot.specs) return loadingBox('불러오는 중…')
    const cfgs = boot.strategies || []
    if (!U.S.editingCode && cfgs.length) U.S.editingCode = cfgs[0].code
    const code = U.S.editingCode
    const d = code ? ensureDraft(code) : null
    const friendly = (boot.ruleMeta || {}).friendly || {}
    const ruleList = Object.keys(friendly)

    const stratBar = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-sitemap text-blue-600"></i> 전략 <span class="text-[12px] font-normal text-slate-500">${cfgs.length}개</span></div>
        ${U.btn('<i class="fas fa-plus"></i> 전략 추가', 'stratAdd', 'btn-p !py-1.5')}
      </div>
      <ul class="divide-y divide-slate-100 dark:divide-slate-800">${cfgs
        .map(
          (c, i) => `<li class="px-4 py-2.5 flex items-center gap-2 ${c.code === code ? 'bg-blue-50 dark:bg-blue-950/30' : ''}">
          <button class="flex-1 min-w-0 text-left" data-act="pickStrat" data-code="${esc(c.code)}">
            <div class="font-semibold text-[13.5px] flex items-center gap-1.5">${esc(c.code)}
              ${c.active === false ? '<span class="text-[11px] bg-slate-200 dark:bg-slate-700 text-slate-500 px-1.5 py-0.5 rounded">비활성</span>' : ''}
            </div>
            <div class="text-[11.5px] text-slate-500 dark:text-slate-400 truncate">${esc(c.account)} · ${esc(friendly[specOf(c.code)?.rule] || specOf(c.code)?.rule || '—')}</div>
          </button>
          <div class="flex gap-1 shrink-0">
            <button class="btn btn-s !py-1 !px-2 !text-[12px]" data-act="stratUp" data-code="${esc(c.code)}" ${i === 0 ? 'disabled' : ''}><i class="fas fa-arrow-up"></i></button>
            <button class="btn btn-s !py-1 !px-2 !text-[12px]" data-act="stratDown" data-code="${esc(c.code)}" ${i === cfgs.length - 1 ? 'disabled' : ''}><i class="fas fa-arrow-down"></i></button>
            <button class="btn btn-s !py-1 !px-2 !text-[12px]" data-act="stratToggle" data-code="${esc(c.code)}" title="활성/비활성"><i class="fas fa-power-off"></i></button>
            <button class="btn btn-d !py-1 !px-2 !text-[12px]" data-act="stratDel" data-code="${esc(c.code)}"><i class="fas fa-trash"></i></button>
          </div>
        </li>`,
        )
        .join('')}</ul>
    </div>`

    if (!d) return U.sectionTitle('설정') + stratBar + U.empty('전략이 없습니다. “전략 추가”로 시작하세요.')

    const infoCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-extrabold flex items-center gap-2">
        <i class="fas fa-pen text-blue-600"></i> ${esc(d.code)} 기본 정보
      </div>
      <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <label class="block"><span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">계좌 이름</span>
          <input class="inp mt-1" value="${esc((cfgs.find((c) => c.code === d.code) || {}).account || '')}" data-oninput="stratAccount" /></label>
        <label class="block"><span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">규칙 종류</span>
          ${sel(ruleList.map((r) => ({ v: r, t: friendly[r] })), d.rule, 'setRule')}</label>
        <label class="block sm:col-span-2"><span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">설명</span>
          <input class="inp mt-1" value="${esc(d.description || '')}" data-oninput="stratDesc" /></label>
      </div>
    </div>`

    return (
      U.sectionTitle('설정', '전략 규칙을 코딩 없이 UI 에서 조립합니다. 저장하면 다음 계획 계산부터 바로 적용됩니다.') +
      stratBar +
      infoCard +
      (d.rule === 'visual' ? visualBuilder(d) : legacyBuilder(d)) +
      assetEditor(d) +
      globalSettings(boot)
    )
  }

  function globalSettings(boot) {
    const s = boot.settings || {}
    const cats = boot.categories || []
    const ct = boot.categoryTargets || {}
    return `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-3">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 font-extrabold flex items-center gap-2">
        <i class="fas fa-gear text-blue-600"></i> 전체 설정
      </div>
      <div class="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">휴장일 정책</span>
          ${sel(
            [
              { v: 'strict', t: '지정일 종가 (없으면 직전 거래일)' },
              { v: 'prev', t: '항상 직전 거래일 종가' },
            ],
            s.price_policy || 'strict',
            'setSetting',
            'data-key="price_policy"',
          )}
        </label>
        <label class="block">
          <span class="text-[12px] font-semibold text-slate-600 dark:text-slate-300">가격 기준</span>
          ${sel(
            [
              { v: 'close', t: '종가 (close)' },
              { v: 'adjclose', t: '수정종가 (adjclose)' },
            ],
            s.price_mode || 'close',
            'setSetting',
            'data-key="price_mode"',
          )}
        </label>
      </div>
      <div class="px-4 pb-4">
        <div class="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-2">자산군 목표비중 (%)</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          ${cats
            .map(
              (c) => `<label class="block"><span class="text-[11.5px] text-slate-500">${esc(c)}</span>
              <input type="number" step="0.1" class="inp mt-1 !py-1.5 !text-[13px]" value="${n(ct[c])}" data-oninput="catTarget" data-cat="${esc(c)}" /></label>`,
            )
            .join('')}
        </div>
        <div class="mt-3">${U.btn('<i class="fas fa-floppy-disk"></i> 자산군 목표 저장', 'saveCatTargets', 'btn-p')}</div>
      </div>
      <div class="px-4 pb-4">
        <div class="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">벤치마크 <span class="font-normal text-slate-400">(비교용 심볼)</span></div>
        <div class="text-[11.5px] text-slate-500">기본 제공: QQQ, SPY, KOSPI200 — 추가하려면 아래에 “이름 = 야후심볼” 형식으로 입력하세요.</div>
        <textarea id="cbench" class="inp mt-2 h-20 font-mono text-[12px]" placeholder="예) 미국배당 = SCHD">${esc(
          Object.entries(boot.customBenchmarks || {})
            .map(([k, v]) => `${k} = ${v}`)
            .join('\n'),
        )}</textarea>
        <div class="mt-2">${U.btn('<i class="fas fa-floppy-disk"></i> 벤치마크 저장', 'saveCustomBench', 'btn-p')}</div>
      </div>
      <div class="px-4 pb-4 border-t border-slate-100 dark:border-slate-800 pt-3">
        <div class="text-[12px] font-semibold text-slate-600 dark:text-slate-300 mb-1">가격 캐시</div>
        <div class="text-[11.5px] text-slate-500 mb-2">캐시된 가격을 비우면 다음 계산 때 Yahoo 에서 다시 받아옵니다. 최신 시세가 반영되지 않을 때 사용하세요.</div>
        <div class="flex flex-wrap gap-1.5 items-center">
          <input id="cache-ticker" class="inp !w-auto !py-1.5 !text-[12.5px]" placeholder="티커 (예: 133690)" />
          ${sel([{ v: 'KR', t: '한국' }, { v: 'US', t: '미국' }], 'KR', 'noop', 'id="cache-market" data-act="noop"')}
          ${U.btn('<i class="fas fa-broom"></i> 이 종목 캐시 삭제', 'clearCacheOne', 'btn-s')}
          ${U.btn('<i class="fas fa-trash-can"></i> 전체 캐시 삭제', 'clearCacheAll', 'btn-d')}
        </div>
      </div>
    </div>`
  }

  /* ───────── 설정 액션 ───────── */

  ACTIONS.pickStrat = (e, el) => {
    U.S.editingCode = el.dataset.code
    ensureDraft(U.S.editingCode)
    U.S.showJson = false
    U.S.searched = null
    U.render()
  }

  ACTIONS.stratAdd = async () => {
    const code = window.prompt('새 전략 코드 (영문/숫자, 예: TECH)')
    if (!code) return
    const account = window.prompt('계좌 이름', code) || code
    try {
      const r = await U.api.post('/api/strategies', { code, account })
      U.S.boot = await U.api.get('/api/bootstrap')
      U.S.editingCode = r.code
      U.S.ruleDraft = null
      ensureDraft(r.code)
      U.toast(`전략 ${r.code} 을(를) 추가했습니다. 규칙을 설정해주세요.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.stratDel = async (e, el) => {
    const code = el.dataset.code
    if (!window.confirm(`전략 ${code} 과(와) 그 보유자산을 삭제할까요? 되돌릴 수 없습니다.`)) return
    try {
      await U.api.del(`/api/strategies/${encodeURIComponent(code)}`)
      U.S.boot = await U.api.get('/api/bootstrap')
      U.S.ruleDraft = null
      U.S.editingCode = (U.S.boot.strategies[0] || {}).code || null
      U.toast('삭제했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.stratToggle = async (e, el) => {
    const code = el.dataset.code
    const cfg = (stateOf().strategies || []).find((c) => c.code === code)
    try {
      await U.api.patch(`/api/strategies/${encodeURIComponent(code)}`, { active: cfg.active === false })
      U.S.boot = await U.api.get('/api/bootstrap')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  async function reorder(code, dir) {
    const codes = (stateOf().strategies || []).map((c) => c.code)
    const i = codes.indexOf(code)
    const j = i + dir
    if (i < 0 || j < 0 || j >= codes.length) return
    ;[codes[i], codes[j]] = [codes[j], codes[i]]
    try {
      await U.api.post('/api/strategies/reorder', { order: codes })
      U.S.boot = await U.api.get('/api/bootstrap')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }
  ACTIONS.stratUp = (e, el) => reorder(el.dataset.code, -1)
  ACTIONS.stratDown = (e, el) => reorder(el.dataset.code, 1)

  ACTIONS.setRule = (e, el) => {
    const d = U.S.ruleDraft
    if (!d) return
    d.rule = el.value
    if (d.rule === 'visual' && !Array.isArray(d.params.conditions)) {
      const dd = (stateOf().visualMeta || {}).defaults || {}
      d.params.conditions = dd.conditions ? JSON.parse(JSON.stringify(dd.conditions)) : [DEFAULT_COND()]
      d.params.mode = d.params.mode || 'all'
      d.params.on_pass = d.params.on_pass || 'target'
      d.params.on_fail = d.params.on_fail || 'cash'
      d.params.restore_timing = d.params.restore_timing || 'quarter_end'
    }
    U.S.preview = null
    U.render()
  }

  ACTIONS.switchVisual = (e, el) => {
    const d = U.S.ruleDraft
    if (!d) return
    d.rule = 'visual'
    const dd = (stateOf().visualMeta || {}).defaults || {}
    d.params = {
      conditions: dd.conditions ? JSON.parse(JSON.stringify(dd.conditions)) : [DEFAULT_COND()],
      mode: dd.mode || 'all',
      on_pass: dd.on_pass || 'target',
      on_fail: dd.on_fail || 'cash',
      restore_timing: dd.restore_timing || 'quarter_end',
      buy_fraction: 0.5,
      winner_share: 0.8,
      winner_sma_filter: true,
    }
    U.S.preview = null
    U.toast('노코드 규칙 빌더로 전환했습니다.')
    U.render()
  }

  /* 조건 편집 */
  ACTIONS.condAdd = () => {
    const d = U.S.ruleDraft
    d.params.conditions = [...(d.params.conditions || []), DEFAULT_COND()]
    U.S.preview = null
    U.render()
  }
  ACTIONS.condDel = (e, el) => {
    const i = Number(el.dataset.idx)
    const d = U.S.ruleDraft
    d.params.conditions = d.params.conditions.filter((_, k) => k !== i)
    U.S.preview = null
    U.render()
  }
  ACTIONS.condUp = (e, el) => {
    const i = Number(el.dataset.idx)
    const cs = U.S.ruleDraft.params.conditions
    if (i <= 0) return
    ;[cs[i - 1], cs[i]] = [cs[i], cs[i - 1]]
    U.S.preview = null
    U.render()
  }
  ACTIONS.condDown = (e, el) => {
    const i = Number(el.dataset.idx)
    const cs = U.S.ruleDraft.params.conditions
    if (i >= cs.length - 1) return
    ;[cs[i + 1], cs[i]] = [cs[i], cs[i + 1]]
    U.S.preview = null
    U.render()
  }

  ACTIONS.condField = (e, el) => {
    const c = U.S.ruleDraft.params.conditions[Number(el.dataset.idx)]
    if (!c) return
    const f = el.dataset.field
    let v = el.value
    if (f === 'period') v = Math.max(1, Math.round(n(v, 10)))
    else if (f === 'threshold') v = thrStore(c, v)
    c[f] = v
    if (f === 'indicator') {
      // 지표가 바뀌면 임계값 표시 단위도 바뀌므로 화면을 다시 그린다
      U.S.preview = null
      U.render()
      return
    }
    U.S.preview = null
    // 라벨/단위 즉시 반영 (부분 갱신 대신 문장만 교체)
    const box = el.closest('.cond-row')
    const q = box && box.querySelector('.fa-quote-left')
    if (q && q.parentElement) q.parentElement.innerHTML = `<i class="fas fa-quote-left text-slate-400 mr-1"></i><span class="font-semibold">${esc(describeCond(c))}</span>`
  }

  ACTIONS.setMode = (e, el) => {
    U.S.ruleDraft.params.mode = el.dataset.mode
    U.S.preview = null
    U.render()
  }

  ACTIONS.paramField = (e, el) => {
    const path = el.dataset.path
    U.S.ruleDraft.params[path] = el.value
    U.S.preview = null
    U.render()
  }
  ACTIONS.paramFieldPct = (e, el) => {
    U.S.ruleDraft.params[el.dataset.path] = n(el.value) / 100
    U.S.preview = null
  }
  ACTIONS.paramCheck = (e, el) => {
    U.S.ruleDraft.params[el.dataset.path] = el.checked
    U.S.preview = null
  }

  /* 레거시 규칙 파라미터 편집 */
  function setPath(obj, path, v) {
    let o = obj
    for (let i = 0; i < path.length - 1; i++) {
      if (typeof o[path[i]] !== 'object' || o[path[i]] === null) o[path[i]] = {}
      o = o[path[i]]
    }
    o[path[path.length - 1]] = v
  }
  ACTIONS.legacyField = (e, el) => setPath(U.S.ruleDraft.params, JSON.parse(el.dataset.path), el.value)
  ACTIONS.legacyNum = (e, el) => setPath(U.S.ruleDraft.params, JSON.parse(el.dataset.path), n(el.value))
  ACTIONS.legacyPct = (e, el) => setPath(U.S.ruleDraft.params, JSON.parse(el.dataset.path), n(el.value) / 100)
  ACTIONS.legacyCheck = (e, el) => setPath(U.S.ruleDraft.params, JSON.parse(el.dataset.path), el.checked)
  ACTIONS.legacyCsv = (e, el) =>
    setPath(
      U.S.ruleDraft.params,
      JSON.parse(el.dataset.path),
      String(el.value)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )

  ACTIONS.toggleJson = () => {
    U.S.showJson = !U.S.showJson
    U.render()
  }

  /* 미리보기 */
  ACTIONS.previewCond = async (e, el) => {
    const d = U.S.ruleDraft
    U.S.preview = { loading: true }
    U.render()
    try {
      const targets = (d.assets || [])
        .filter((a) => a.ticker && a.ticker !== 'CASH')
        .map((a) => ({ market: a.market || 'KR', ticker: a.ticker }))
      const r = await U.api.post('/api/plan/preview-conditions', { params: { ...d.params, conditions: d.params.conditions || [] }, targets })
      U.S.preview = { results: r.results, date: r.date }
    } catch (err) {
      U.S.preview = { error: err.message }
    }
    U.render()
  }

  /* 저장 — 규칙/스펙 저장과 자산 목록 저장이 같은 경로를 쓴다.
     서버는 spec.assets 를 원본으로 보고 보유수량·가격만 기존 행에서 이어받으므로,
     종목 삭제·목표% 수정이 그대로 반영되고 보유수량은 유실되지 않는다. */
  async function saveDraft(el, message) {
    const d = U.S.ruleDraft
    if (!d) return
    if (el) el.disabled = true
    try {
      const assets = d.assets.map((a) => ({
        ticker: String(a.ticker || ''),
        name: String(a.name || ''),
        market: a.market === 'US' ? 'US' : 'KR',
        role: String(a.role || ''),
        target_pct: n(a.target_pct),
        category: a.category || '기타',
      }))
      await U.api.put(`/api/specs/${encodeURIComponent(d.code)}`, {
        rule: d.rule,
        params: d.params,
        description: d.description,
        assets,
      })
      U.S.boot = await U.api.get('/api/bootstrap')
      // 저장된 내용을 서버 상태에서 다시 읽도록 초안을 버린다 (삭제한 종목이 남지 않도록)
      U.S.ruleDraft = null
      U.S.undoStack = []
      U.toast(message)
      await U.refreshPlan(true)
    } catch (err) {
      U.toast(err.message, 'err')
      if (el) el.disabled = false
    }
  }

  ACTIONS.saveSpec = (e, el) => saveDraft(el, `전략 ${U.S.ruleDraft ? U.S.ruleDraft.code : ''} 규칙을 저장했습니다.`)

  /* 자산 목록 · 목표비중 저장 */
  ACTIONS.assetSave = (e, el) => saveDraft(el, '자산 목록을 저장했습니다. 보유수량은 그대로 유지됩니다.')

  /* 전략 기본정보 */
  ACTIONS.stratAccount = (e, el) => {
    U.S.ruleDraft.account = el.value
    clearTimeout(U.S.__t)
    U.S.__t = setTimeout(() => saveCfg({ account: el.value }), 700)
  }
  ACTIONS.stratDesc = (e, el) => {
    U.S.ruleDraft.description = el.value
    clearTimeout(U.S.__t2)
    U.S.__t2 = setTimeout(() => saveCfg({ description: el.value }), 700)
  }
  async function saveCfg(patch) {
    try {
      const r = await U.api.patch(`/api/strategies/${encodeURIComponent(U.S.ruleDraft.code)}`, patch)
      U.S.boot.strategies = r.strategies
      U.S.boot.specs = r.specs
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  /* 자산 편집 */
  ACTIONS.assetField = (e, el) => {
    const a = U.S.ruleDraft.assets[Number(el.dataset.idx)]
    if (!a) return
    a[el.dataset.field] = el.value
  }
  ACTIONS.assetPct = (e, el) => {
    const a = U.S.ruleDraft.assets[Number(el.dataset.idx)]
    if (a) a.target_pct = n(el.value)
    const sum = U.S.ruleDraft.assets.reduce((s, x) => s + n(x.target_pct), 0)
    const card = el.closest('.card')
    const div = card && card.querySelector('.text-\\[12px\\].mt-0\\.5')
    if (div) {
      div.textContent = `목표비중 합계 ${sum.toFixed(1)}% ${Math.abs(sum - 100) < 0.05 ? '(정상)' : '(100% 로 맞추는 것을 권장)'}`
      div.className = `text-[12px] mt-0.5 ${Math.abs(sum - 100) < 0.05 ? 'text-green-600' : 'text-amber-600'}`
    }
  }
  ACTIONS.assetAdd = () => {
    U.S.ruleDraft.assets.push({ ticker: '', name: '', market: 'KR', role: '', target_pct: 0, category: '기타' })
    U.render()
  }
  ACTIONS.assetDel = (e, el) => {
    U.S.ruleDraft.assets.splice(Number(el.dataset.idx), 1)
    U.render()
  }

  /* 종목 검색 */
  ACTIONS.openSearch = () => {
    U.S.searched = { q: '', market: 'KR', results: [], loading: false, done: false }
    U.render()
  }
  ACTIONS.closeSearch = () => {
    U.S.searched = null
    U.render()
  }
  ACTIONS.searchQ = (e, el) => {
    U.S.searched.q = el.value
  }
  ACTIONS.searchMarket = (e, el) => {
    U.S.searched.market = el.value
  }
  ACTIONS.doSearch = async () => {
    const s = U.S.searched
    const qEl = document.getElementById('search-q')
    if (qEl) s.q = qEl.value
    if (!s.q.trim()) return U.toast('검색어를 입력하세요.', 'warn')
    s.loading = true
    s.done = false
    U.render()
    try {
      const r = await U.api.get(`/api/search?q=${encodeURIComponent(s.q.trim())}&market=${s.market}`)
      U.S.searched = { ...s, results: r.results || [], loading: false, done: true }
    } catch (err) {
      U.S.searched = { ...s, results: [], loading: false, done: true }
      U.toast(err.message, 'err')
    }
    U.render()
  }
  ACTIONS.searchPick = (e, el) => {
    pushUndo()
    const s = U.S.searched
    U.S.ruleDraft.assets.push({
      ticker: el.dataset.ticker,
      name: el.dataset.name,
      market: s.market,
      role: '',
      target_pct: 0,
      category: s.market === 'US' ? '선진국 주식' : '기타',
    })
    // 최근 사용 목록에 기록 (실패해도 추가 자체는 유지)
    U.api.post('/api/tickers/recent', { ticker: el.dataset.ticker, name: el.dataset.name, market: s.market }).then((r) => {
      U.S.boot.recentTickers = r.recent_tickers
    }).catch(() => {})
    U.toast(addedToast(el.dataset.name))
    U.render()
  }

  /** 검색 결과에서 바로 즐겨찾기 추가 */
  ACTIONS.searchFav = async (e, el) => {
    const { ticker, name } = el.dataset
    const market = U.S.searched.market
    try {
      const r = await U.api.post('/api/tickers/favorite', { ticker, name, market })
      U.S.boot.favoriteTickers = r.favorite_tickers
      U.toast(`“${name}” 을(를) 즐겨찾기에 추가했습니다.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  /* 전체 설정 */
  ACTIONS.setSetting = async (e, el) => {
    try {
      const r = await U.api.put('/api/settings', { [el.dataset.key]: el.value })
      U.S.boot.settings = r.settings
      U.toast('설정을 저장했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }
  ACTIONS.catTarget = (e, el) => {
    U.S.boot.categoryTargets = { ...(U.S.boot.categoryTargets || {}), [el.dataset.cat]: n(el.value) }
  }
  ACTIONS.saveCatTargets = async () => {
    try {
      const r = await U.api.put('/api/category-targets', U.S.boot.categoryTargets || {})
      U.S.boot.categoryTargets = r.category_targets
      U.toast('자산군 목표비중을 저장했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }
  ACTIONS.saveCustomBench = async () => {
    const el = document.getElementById('cbench')
    const obj = {}
    for (const line of String(el ? el.value : '').split('\n')) {
      const [k, v] = line.split('=')
      if (k && v && k.trim() && v.trim()) obj[k.trim()] = v.trim()
    }
    try {
      const r = await U.api.put('/api/custom-benchmarks', obj)
      U.S.boot.customBenchmarks = r.custom_benchmarks
      U.toast('벤치마크를 저장했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  /* ═══════════════════════════ 전략 비교 ═══════════════════════════ */
  PAGES.compare = function () {
    const boot = stateOf()
    const perf = U.S.perf
    const hist = (boot.history || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))

    const rangeBar = `<div class="flex gap-1.5 mb-4 overflow-x-auto pb-0.5">${RANGES.map(
      (r) =>
        `<button class="btn ${U.S.perfRange === r.id ? 'btn-p' : 'btn-s'} !py-1.5 !px-3 !text-[12px]" data-act="setRange" data-range="${r.id}">${r.label}</button>`,
    ).join('')}</div>`

    const head = U.sectionTitle(
      '전략 비교',
      '전략과 벤치마크를 같은 시작점(100)으로 정규화해 성과를 나란히 비교합니다.',
    )

    if (!hist.length) {
      return (
        head +
        rangeBar +
        U.empty('아직 총자산 히스토리가 없습니다. [오늘] 탭에서 “기록 저장”을 눌러 스냅샷을 쌓아주세요.')
      )
    }
    if (!perf) return head + rangeBar + loadingBox('성과 지표를 계산하는 중입니다…')

    const m = perf.metrics || {}
    const metricsCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 flex-wrap">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-gauge-high text-blue-600"></i> 전체 성과</div>
        <div class="flex gap-1.5">
          ${U.btn('<i class="fas fa-arrows-rotate"></i> 새로고침', 'perfRefresh', 'btn-s')}
          ${U.btn('<i class="fas fa-ruler-combined"></i> 벤치마크 백필', 'benchBackfill', 'btn-s')}
        </div>
      </div>
      <div class="p-4">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-4">
          ${U.metric('CAGR', pctOrDash(m.cagr), '연환산 수익률', n(m.cagr) >= 0 ? 'pos' : 'neg')}
          ${U.metric('MDD', pctOrDash(m.mdd), m.mddDetail?.ddLen != null ? `하락기간 ${m.mddDetail.ddLen}일` : '', 'neg')}
          ${U.metric('IRR/XIRR', pctOrDash(m.irr), '실제 돈의 성장', n(m.irr) >= 0 ? 'pos' : 'neg')}
          ${U.metric('TWR', pctOrDash(m.twr), '입출금 효과 제거', n(m.twr) >= 0 ? 'pos' : 'neg')}
        </div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mb-3">XIRR 은 실제 돈의 성장(입출금 시점 반영), TWR 은 투자 결정의 성과(입출금 효과 제거)입니다. 둘을 함께 보세요.</div>
        <div class="tbl-wrap">${lineChart(
          [
            { name: '내 포트폴리오', points: perf.portfolioSeries || [] },
            ...Object.entries(perf.benchmarks || {}).map(([name, pts]) => ({ name, points: pts })),
          ],
          { height: 200 },
        )}</div>
      </div>
    </div>`

    const series = perf.strategySeries || {}
    const codes = Object.keys(series)
    if (!U.S.strategyPick) U.S.strategyPick = codes.slice(0, 3)
    const picked = (U.S.strategyPick || []).filter((c) => codes.includes(c))

    const picker = codes.length
      ? `<div class="flex flex-wrap gap-1.5 mb-3">${codes
          .map((c) => {
            const on = picked.includes(c)
            return `<button class="px-3 py-1.5 rounded-lg text-[12px] font-semibold border ${
              on
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border-slate-300 dark:border-slate-700'
            }" data-act="pickStratCmp" data-code="${esc(c)}">${esc(c)}</button>`
          })
          .join('')}</div>`
      : ''

    const combined = {}
    for (const c of picked) combined[c] = series[c]
    for (const [name, pts] of Object.entries(perf.benchmarks || {})) combined[name] = pts

    const stratTable = picked.length
      ? `<div class="tbl-wrap"><table class="w-full text-[13px]"><thead class="bg-slate-50 dark:bg-slate-800/50 text-slate-500"><tr>
          <th class="text-left px-3 py-2 font-semibold">전략</th>
          <th class="text-right px-3 py-2 font-semibold">기간수익</th>
          <th class="text-right px-3 py-2 font-semibold">CAGR</th>
          <th class="text-right px-3 py-2 font-semibold">MDD</th>
          <th class="text-right px-3 py-2 font-semibold">IRR</th>
          <th class="text-right px-3 py-2 font-semibold">TWR</th>
        </tr></thead><tbody>${picked
          .map((c) => {
            const s = (perf.strategies || []).find((x) => x.code === c) || {}
            const rel = s.periodReturn != null && m.periodReturnBase != null ? null : null
            void rel
            return `<tr class="border-t border-slate-100 dark:border-slate-800">
              <td class="px-3 py-2 font-semibold">${esc(strategyTitle(c))}</td>
              <td class="px-3 py-2 text-right tnum ${n(s.periodReturn) >= 0 ? 'text-green-600' : 'text-red-600'}">${pctOrDash(s.periodReturn)}</td>
              <td class="px-3 py-2 text-right tnum">${pctOrDash(s.cagr)}</td>
              <td class="px-3 py-2 text-right tnum text-red-600">${pctOrDash(s.mdd)}</td>
              <td class="px-3 py-2 text-right tnum">${s.irr != null ? pctOrDash(s.irr) : '<span class="text-slate-400">(태그 없음)</span>'}</td>
              <td class="px-3 py-2 text-right tnum">${pctOrDash(s.twr)}</td>
            </tr>`
          })
          .join('')}</tbody></table></div>`
      : '<div class="p-6 text-center text-sm text-slate-500">비교할 전략을 위에서 선택하세요.</div>'

    const stratCard = `<div class="card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm mb-4">
      <div class="px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div class="font-extrabold flex items-center gap-2"><i class="fas fa-scale-balanced text-blue-600"></i> 전략별 성과 비교</div>
        <div class="text-[12px] text-slate-500 dark:text-slate-400 mt-0.5">전략을 같은 시작점(100)으로 정규화해 비교합니다(위에서 고른 구간 적용).</div>
      </div>
      <div class="p-4">
        ${picker}
        ${Object.keys(combined).length ? `<div class="tbl-wrap">${lineChart(Object.entries(combined).map(([name, points]) => ({ name, points })), { height: 200 })}</div>` : ''}
        <div class="mt-3">${stratTable}</div>
      </div>
    </div>`

    const attr = perf.attributed || {}
    const attrEntries = Object.entries(attr).filter(([, v]) => v !== null && v !== undefined)
    const attrCard = attrEntries.length
      ? `<div class="card bg-blue-50/60 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 p-4 mb-4">
          <div class="font-bold text-[13px] text-blue-800 dark:text-blue-300 mb-2"><i class="fas fa-lightbulb mr-1"></i> 같은 돈을 벤치마크에 넣었다면?</div>
          <ul class="space-y-1">${attrEntries
            .map(
              ([name, v]) =>
                `<li class="text-[12.5px] text-blue-900 dark:text-blue-200 tnum">· 동일 입출금을 <b>${esc(name)}</b>에 넣었다면 XIRR ≈ <b>${pctOrDash(v)}</b></li>`,
            )
            .join('')}</ul>
          <div class="text-[12px] text-blue-800/80 dark:text-blue-300/80 mt-2">내 XIRR ${pctOrDash(m.irr)} 와 비교해보세요.</div>
        </div>`
      : ''

    return head + rangeBar + metricsCard + attrCard + stratCard
  }

  ACTIONS.pickStratCmp = (e, el) => {
    const code = el.dataset.code
    const cur = U.S.strategyPick || []
    U.S.strategyPick = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]
    U.render()
  }

  /* ───── 즐겨찾기 / 최근 사용 티커 ───── */
  ACTIONS.favStar = async (e, el) => {
    const { ticker, name, market } = el.dataset
    try {
      const r = await U.api.post('/api/tickers/favorite', { ticker, name, market })
      U.S.boot.favoriteTickers = r.favorite_tickers
      U.toast(`“${name}” 을(를) 즐겨찾기에 추가했습니다.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.favRemove = async (e, el) => {
    const { ticker, market } = el.dataset
    try {
      const r = await U.api.del('/api/tickers/favorite', { items: [{ ticker, market }] })
      U.S.boot.favoriteTickers = r.favorite_tickers
      U.toast('즐겨찾기에서 제거했습니다.')
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.quickPick = (e, el) => {
    const { ticker, name, market } = el.dataset
    U.S.ruleDraft.assets.push({
      ticker,
      name,
      market,
      role: '',
      target_pct: 0,
      category: market === 'US' ? '선진국 주식' : '기타',
    })
    U.toast(addedToast(name))
    U.render()
  }

  /* ───── 자산 편집 실행취소 (스테이징) ───── */
  ACTIONS.assetUndo = () => {
    const stack = U.S.undoStack || []
    if (!stack.length) return U.toast('되돌릴 변경이 없습니다.', 'warn')
    U.S.ruleDraft.assets = JSON.parse(stack.pop())
    U.toast('마지막 변경을 되돌렸습니다.')
    U.render()
  }

  /* ───── 가격 캐시 초기화 ───── */
  function pushUndo() {
    U.S.undoStack = U.S.undoStack || []
    U.S.undoStack.push(JSON.stringify(U.S.ruleDraft.assets))
    if (U.S.undoStack.length > 20) U.S.undoStack.shift()
  }
  U.pushUndo = pushUndo

  ACTIONS.clearCacheTicker = async (e, el) => {
    const { ticker, market } = el.dataset
    if (!window.confirm(`${ticker} 의 캐시된 가격을 삭제할까요? 다음 계산 때 다시 받아옵니다.`)) return
    el.disabled = true
    try {
      const r = await U.api.post('/api/cache/clear', { ticker, market })
      U.toast(`${ticker} 캐시 ${r.deleted}건을 삭제했습니다.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
      el.disabled = false
    }
  }

  ACTIONS.clearCacheAll = async () => {
    if (!window.confirm('모든 가격·환율 캐시를 삭제할까요? 다음 계산 때 Yahoo 에서 다시 받아옵니다.')) return
    try {
      const r = await U.api.post('/api/cache/clear', {})
      U.toast(`가격 캐시 ${r.deleted}건을 삭제했습니다.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.clearCacheOne = async () => {
    const tEl = document.getElementById('cache-ticker')
    const mEl = document.getElementById('cache-market')
    const ticker = String(tEl ? tEl.value : '').trim()
    const market = mEl ? mEl.value : 'KR'
    if (!ticker) return U.toast('티커를 입력하세요.', 'warn')
    try {
      const r = await U.api.post('/api/cache/clear', { ticker, market })
      U.toast(`${ticker} 캐시 ${r.deleted}건을 삭제했습니다.`)
      if (tEl) tEl.value = ''
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }

  ACTIONS.noop = () => {}

  ACTIONS.stratRename = async (e, el) => {
    const oldCode = el.dataset.code
    const next = window.prompt(`${oldCode} 의 새 전략 코드를 입력하세요 (영문/숫자)`, oldCode)
    if (next === null) return
    try {
      const r = await U.api.post(`/api/strategies/${encodeURIComponent(oldCode)}/rename`, { new_code: next })
      U.S.editingCode = r.code
      U.S.ruleDraft = null
      U.S.boot = await U.api.get('/api/bootstrap')
      U.toast(`전략 코드를 ${oldCode} → ${r.code} 로 변경했습니다.`)
      U.render()
    } catch (err) {
      U.toast(err.message, 'err')
    }
  }
})()
