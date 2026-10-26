/**
 * Token Meter — Client half.
 *
 * A compact, colour-coded pill below the composer (the default seat) plus a
 * dashboard that opens above the composer in normal flow, so expanding it never
 * covers the status bar or the side columns.
 */

window.__ModuleLoader__.load({
  id: 'dsh-token-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const ENDPOINT = '/dsh-token-meter/stats'
    const POLL_MS = 8000
    const CHIP_SLOT = 'conversation.composer.dock'
    const PANEL_SLOT = 'conversation.input.dock'

    const DICT = {
      zh: {
        title: 'Token 雷达',
        detail: '详情',
        collapse: '收起',
        refresh: '刷新',
        thisSession: '本次会话',
        today: '今日',
        allTime: '累计',
        steps: '步',
        input: '新输入',
        inShort: '新',
        cache: '缓存命中',
        output: '输出',
        total: '计费总量',
        hitRate: '命中率',
        cost: '估算费用',
        perStep: '本次会话 · 每一步消耗',
        chartTotal: '总消耗（含缓存重发）',
        chartBillable: '可计费部分（新输入 + 输出）',
        perStepHint: '每根柱子是一次模型调用：蓝色=新输入，浅蓝=缓存命中，橙色=输出；悬停看明细',
        days: '最近 14 天',
        subagents: '子代理消耗',
        tools: '工具开销归因',
        models: '按模型',
        loading: '读取中…',
        failed: '读取失败',
        empty: '还没有调用记录',
        toolNote: '工具本身不调用模型、不计费；这里把「下一步上下文增量 − 上一步输出」按结果长度分摊。',
        subNote: '子代理是独立会话，已按父子树汇总。',
        scan: '日志',
        files: '个文件',
        updated: '更新于',
        calls: '次',
        tokens: 'tokens',
        share: '占比',
      },
      en: {
        title: 'Token Radar',
        detail: 'Details',
        collapse: 'Collapse',
        refresh: 'Refresh',
        thisSession: 'This session',
        today: 'Today',
        allTime: 'All time',
        steps: 'steps',
        input: 'Fresh input',
        inShort: 'in',
        cache: 'Cache hits',
        output: 'Output',
        total: 'Billed total',
        hitRate: 'Hit rate',
        cost: 'Est. cost',
        perStep: 'This session · per step',
        chartTotal: 'Total (cache re-sends included)',
        chartBillable: 'Billable (fresh input + output)',
        perStepHint: 'One bar per call: blue = fresh input, sky = cache hits, amber = output',
        days: 'Last 14 days',
        subagents: 'Sub-agents',
        tools: 'Tool attribution',
        models: 'By model',
        loading: 'Reading…',
        failed: 'Read failed',
        empty: 'No calls recorded yet',
        toolNote: 'Tools never call the model. Growth from one prompt to the next is split across results by size.',
        subNote: 'Sub-agents are separate sessions and are summed over the parent tree.',
        scan: 'Logs',
        files: 'files',
        updated: 'Updated',
        calls: 'calls',
        tokens: 'tokens',
        share: 'share',
      },
    }

    // ---------------------------------------------------------------- store
    const store = {
      state: { data: null, error: null, busy: false, open: false },
      listeners: new Set(),
      sessionId: '',
      timer: null,
      users: 0,
      inflight: false,
    }

    function emit() {
      for (const listener of [...store.listeners]) listener()
    }

    function patch(next) {
      store.state = { ...store.state, ...next }
      emit()
    }

    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    async function load() {
      if (store.inflight) return
      store.inflight = true
      patch({ busy: true })
      try {
        const query = store.sessionId ? `?session=${encodeURIComponent(store.sessionId)}` : ''
        const response = await fetch(ENDPOINT + query, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        patch({ data: await response.json(), error: null })
      } catch (cause) {
        patch({ error: String(cause?.message ?? cause) })
      } finally {
        store.inflight = false
        patch({ busy: false })
      }
    }

    function attach(sessionId) {
      store.users += 1
      if (store.sessionId !== sessionId) {
        store.sessionId = sessionId
        patch({ data: null })
      }
      if (store.timer === null) {
        store.timer = setInterval(() => {
          if (!document.hidden) load()
        }, POLL_MS)
      }
      load()
      return () => {
        store.users = Math.max(0, store.users - 1)
        if (store.users === 0 && store.timer !== null) {
          clearInterval(store.timer)
          store.timer = null
        }
      }
    }

    function useStore(sessionId) {
      const [, bump] = useState(0)
      useEffect(() => {
        const unsubscribe = subscribe(() => bump((n) => n + 1))
        const detach = attach(sessionId)
        return () => {
          unsubscribe()
          detach()
        }
      }, [sessionId])
      return store.state
    }

    // -------------------------------------------------------------- helpers
    function compact(value) {
      const n = Number(value) || 0
      if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`
      return String(Math.round(n))
    }

    function money(usd, fx) {
      const cny = (Number(usd) || 0) * (Number(fx) || 7.2)
      return `¥${cny >= 10 ? cny.toFixed(2) : cny.toFixed(3)}`
    }

    function pct(part, whole) {
      const total = Number(whole) || 0
      if (!total) return '—'
      return `${((Number(part) / total) * 100).toFixed(1)}%`
    }

    function clock(ms) {
      if (!ms) return '—'
      const date = new Date(ms)
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':')
    }

    const CSS = `
.tmx-vars{
  --tmx-in:#2563eb; --tmx-cache:#8ec5fb; --tmx-out:#f59e0b; --tmx-violet:#7c3aed;
  --tmx-ink:var(--dsw-alias-label-primary,#111827);
  --tmx-muted:var(--dsw-alias-label-secondary,#6b7280);
  --tmx-line:rgba(120,130,150,.26);
  --tmx-fill:var(--dsw-alias-bg-layer-1,rgba(120,130,150,.06));
  font-variant-numeric:tabular-nums;
}
.tmx-pill{display:inline-flex;align-items:center;gap:8px;max-width:100%;height:22px;box-sizing:border-box;
  border:1px solid var(--tmx-line);border-radius:999px;background:var(--tmx-fill);
  padding:0 10px;font:inherit;font-size:11px;line-height:1;color:var(--tmx-muted);
  cursor:pointer;overflow:hidden;white-space:nowrap;transition:border-color .15s,background .15s}
.tmx-pill:hover{border-color:rgba(120,130,150,.55);background:var(--dsw-alias-bg-layer-2,rgba(120,130,150,.12))}
.tmx-pill:focus-visible{outline:2px solid var(--tmx-in);outline-offset:1px}
.tmx-pill[aria-expanded="true"]{border-color:var(--tmx-in)}
.tmx-pill .dot{width:8px;height:8px;border-radius:2px;flex:none;
  background:linear-gradient(135deg,var(--tmx-in),var(--tmx-out))}
.tmx-pill .name{font-weight:600;color:var(--tmx-ink);flex:none}
.tmx-pill .kv{display:inline-flex;align-items:baseline;gap:3px;flex:none}
.tmx-pill .kv b{font-weight:600;color:var(--tmx-ink)}
.tmx-pill .kv.in b{color:var(--tmx-in)}
.tmx-pill .kv.out b{color:var(--tmx-out)}
.tmx-pill .kv.cost b{color:var(--tmx-violet)}
.tmx-pill .caret{font-size:9px;opacity:.7;flex:none}
@media (max-width: 1020px){.tmx-pill .kv.in{display:none}}
@media (max-width: 900px){.tmx-pill .name{display:none}}
.tmx-root{display:flex;flex-direction:column;font-size:11.5px;line-height:1.5;
  color:var(--tmx-muted);padding-bottom:6px}
.tmx-panel{display:flex;flex-direction:column;gap:12px;border:1px solid var(--tmx-line);
  border-radius:12px;padding:12px 14px;background:var(--tmx-fill);max-height:min(48vh,470px);overflow:auto;
  overscroll-behavior:contain}
.tmx-panel-head{display:flex;align-items:center;gap:8px;min-width:0}
.tmx-panel-head b{color:var(--tmx-ink);font-size:12px;flex:none}
.tmx-panel-head .tmx-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tmx-spacer{flex:1 1 auto;min-width:8px}
.tmx-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--tmx-line);background:transparent;
  color:var(--tmx-muted);border-radius:999px;padding:1px 9px;font:inherit;font-size:11px;cursor:pointer;flex:none}
.tmx-btn:hover{border-color:rgba(120,130,150,.55);color:var(--tmx-ink)}
.tmx-btn:disabled{opacity:.5;cursor:default}
.tmx-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.tmx-card{border:1px solid var(--tmx-line);border-left:3px solid var(--tmx-in);border-radius:10px;
  padding:8px 10px;background:var(--dsw-alias-bg-layer-2,rgba(120,130,150,.07));min-width:0}
.tmx-card.today{border-left-color:var(--tmx-out)}
.tmx-card.all{border-left-color:var(--tmx-violet)}
.tmx-card h4{margin:0 0 5px;font-size:10.5px;font-weight:600;letter-spacing:.05em;
  text-transform:uppercase;color:var(--tmx-muted)}
.tmx-big{font-size:18px;font-weight:600;color:var(--tmx-ink);line-height:1.15;white-space:nowrap}
.tmx-big em{font-style:normal;font-size:10.5px;font-weight:400;color:var(--tmx-muted);margin-left:3px}
.tmx-sub{font-size:10.5px;color:var(--tmx-muted)}
.tmx-rows{display:flex;flex-direction:column;gap:1px;margin-top:5px}
.tmx-row{display:flex;justify-content:space-between;gap:8px}
.tmx-row b{color:var(--tmx-ink);font-weight:500}
.tmx-row.in b{color:var(--tmx-in)}
.tmx-row.ca b{color:#2b7fc4}
.tmx-row.out b{color:var(--tmx-out)}
.tmx-sec h3{margin:0 0 6px;font-size:11px;font-weight:600;color:var(--tmx-ink);display:flex;gap:6px;align-items:center}
.tmx-sec h3::before{content:"";width:3px;height:11px;border-radius:2px;background:var(--tmx-in)}
.tmx-hint{font-size:10px;color:var(--tmx-muted);opacity:.85;margin:0}
.tmx-duo{display:grid;grid-template-columns:1.35fr 1fr;gap:12px}
@media (max-width: 780px){.tmx-duo{grid-template-columns:1fr}}
.tmx-duo figure{margin:0;min-width:0}
.tmx-duo figcaption{font-size:10px;color:var(--tmx-muted);margin-bottom:4px}
.tmx-bars{display:flex;align-items:flex-end;gap:2px;height:56px;overflow-x:auto;padding-bottom:1px}
.tmx-col{display:flex;flex-direction:column-reverse;align-self:flex-end;width:100%;min-width:5px;max-width:18px;
  border-radius:2px;overflow:hidden;cursor:default}
.tmx-in{background:var(--tmx-in)}
.tmx-ca{background:var(--tmx-cache)}
.tmx-out{background:var(--tmx-out)}
.tmx-daybar{display:flex;align-items:flex-end;gap:3px;height:46px}
.tmx-daybar .tmx-col{max-width:26px}
.tmx-grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.tmx-tbl{width:100%;border-collapse:collapse;font-size:10.5px}
.tmx-tbl th{text-align:left;font-weight:500;color:var(--tmx-muted);padding:2px 4px;
  border-bottom:1px solid var(--tmx-line)}
.tmx-tbl td{padding:2px 4px;border-bottom:1px solid rgba(120,130,150,.14)}
.tmx-tbl td.n{text-align:right;font-variant-numeric:tabular-nums}
.tmx-tbl tr:last-child td{border-bottom:none}
.tmx-legend{display:flex;gap:12px;font-size:10px;color:var(--tmx-muted);margin-top:6px}
.tmx-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
.tmx-err{color:var(--dsw-alias-state-error-primary,#c0392b)}
.tmx-foot{display:flex;gap:12px;font-size:10px;color:var(--tmx-muted);opacity:.8;flex-wrap:wrap}
`

    function stackedBars(rows) {
      const peak = rows.reduce((top, row) => Math.max(top, row.total), 0) || 1
      return rows.map((row, index) => {
        const total = row.inp + row.cacheRead + row.cacheWrite + row.out || 1
        const part = (value) => `${(value / total) * 100}%`
        return h(
          'div',
          {
            key: index,
            className: 'tmx-col',
            style: { height: `${Math.max(6, Math.sqrt(total / peak) * 100)}%` },
            title: row.title || '',
          },
          h('span', { className: 'tmx-in', style: { height: part(row.inp) } }),
          h('span', { className: 'tmx-ca', style: { height: part(row.cacheRead) } }),
          h('span', { className: 'tmx-out', style: { height: part(row.out) } }),
        )
      })
    }

    function legend(t) {
      return h(
        'div',
        { className: 'tmx-legend' },
        h('span', null, h('i', { className: 'tmx-in' }), t.input),
        h('span', null, h('i', { className: 'tmx-ca' }), t.cache),
        h('span', null, h('i', { className: 'tmx-out' }), t.output),
      )
    }

    function card(kind, title, total, fx, t) {
      return h(
        'div',
        { className: `tmx-card ${kind}` },
        h('h4', null, title),
        h('div', { className: 'tmx-big' }, compact(total.total), h('em', null, t.tokens)),
        h('div', { className: 'tmx-sub' }, `${total.steps || 0} ${t.steps} · ${money(total.cost, fx)}`),
        h(
          'div',
          { className: 'tmx-rows' },
          h('div', { className: 'tmx-row in' }, h('span', null, t.input), h('b', null, compact(total.inp))),
          h('div', { className: 'tmx-row ca' }, h('span', null, t.cache), h('b', null, compact(total.cacheRead))),
          h('div', { className: 'tmx-row out' }, h('span', null, t.output), h('b', null, compact(total.out))),
          h('div', { className: 'tmx-row' }, h('span', null, t.hitRate), h('b', null, pct(total.cacheRead, total.cacheRead + total.inp))),
        ),
      )
    }

    function tables(data, t) {
      const current = data.current || {}
      const subagents = current.subagents || []
      const tools = current.tools || []
      const models = data.models || []
      const nodes = []

      if (subagents.length) {
        nodes.push(
          h(
            'div',
            { key: 'sub', className: 'tmx-sec' },
            h('h3', null, t.subagents),
            h(
              'table',
              { className: 'tmx-tbl' },
              h('thead', null, h('tr', null, h('th', null, ''), h('th', { className: 'n' }, t.steps), h('th', { className: 'n' }, t.total), h('th', { className: 'n' }, t.cost))),
              h(
                'tbody',
                null,
                subagents.slice(0, 12).map((row) =>
                  h(
                    'tr',
                    { key: row.id },
                    h('td', { style: { paddingLeft: `${(row.depth - 1) * 10}px` } }, row.label),
                    h('td', { className: 'n' }, compact(row.steps)),
                    h('td', { className: 'n' }, compact(row.total)),
                    h('td', { className: 'n' }, money(row.cost, data.fx)),
                  ),
                ),
              ),
            ),
            h('p', { className: 'tmx-hint' }, t.subNote),
          ),
        )
      }

      if (tools.length) {
        nodes.push(
          h(
            'div',
            { key: 'tools', className: 'tmx-sec' },
            h('h3', null, t.tools),
            h(
              'table',
              { className: 'tmx-tbl' },
              h('thead', null, h('tr', null, h('th', null, ''), h('th', { className: 'n' }, t.calls), h('th', { className: 'n' }, `≈ ${t.tokens}`))),
              h(
                'tbody',
                null,
                tools.slice(0, 8).map((row) =>
                  h('tr', { key: row.name }, h('td', null, row.name), h('td', { className: 'n' }, compact(row.calls)), h('td', { className: 'n' }, compact(row.alloc))),
                ),
              ),
            ),
            h('p', { className: 'tmx-hint' }, t.toolNote),
          ),
        )
      }

      if (models.length) {
        const modelTotal = models.reduce((sum, row) => sum + row.total, 0) || 1
        nodes.push(
          h(
            'div',
            { key: 'models', className: 'tmx-sec' },
            h('h3', null, t.models),
            h(
              'table',
              { className: 'tmx-tbl' },
              h('thead', null, h('tr', null, h('th', null, ''), h('th', { className: 'n' }, t.total), h('th', { className: 'n' }, t.cost), h('th', { className: 'n' }, t.share))),
              h(
                'tbody',
                null,
                models.slice(0, 6).map((row) =>
                  h(
                    'tr',
                    { key: row.key },
                    h('td', null, String(row.key).replace(/^.*:/, '')),
                    h('td', { className: 'n' }, compact(row.total)),
                    h('td', { className: 'n' }, money(row.cost, data.fx)),
                    h('td', { className: 'n' }, pct(row.total, modelTotal)),
                  ),
                ),
              ),
            ),
          ),
        )
      }

      if (!nodes.length) return null
      return h('div', { className: 'tmx-grid2' }, nodes)
    }

    // ----------------------------------------------------------- components
    /** Compact pill rendered below the composer. */
    function Chip(props) {
      const { sessionId, t } = props
      const state = useStore(sessionId)
      const totals = state.data?.current?.totals
      const fx = state.data?.fx
      const detail = totals
        ? `${t.title} · ${t.thisSession} ${compact(totals.total)} tokens · ${t.input} ${compact(totals.inp)} · ${t.cache} ${compact(totals.cacheRead)} · ${t.output} ${compact(totals.out)} · ${t.hitRate} ${pct(totals.cacheRead, totals.cacheRead + totals.inp)} · ${t.cost} ${money(totals.cost, fx)}`
        : t.title

      const values = totals
        ? [
            h('span', { key: 'total', className: 'kv' }, h('b', null, compact(totals.total))),
            h('span', { key: 'in', className: 'kv in' }, t.inShort, h('b', null, compact(totals.inp))),
            h('span', { key: 'cost', className: 'kv cost' }, h('b', null, money(totals.cost, fx))),
          ]
        : [h('span', { key: 'msg', className: 'kv' }, state.error ? t.failed : t.loading)]

      return h(
        'button',
        {
          type: 'button',
          className: 'tmx-vars tmx-pill',
          title: detail,
          'aria-expanded': String(state.open),
          onClick: () => patch({ open: !store.state.open }),
        },
        h('style', null, CSS),
        h('span', { className: 'dot' }),
        h('span', { className: 'name' }, t.title),
        ...values,
        h('span', { className: 'caret' }, state.open ? '▾' : '▸'),
      )
    }

    /** Dashboard rendered above the composer; renders nothing while closed. */
    function Panel(props) {
      const { sessionId, t } = props
      const state = useStore(sessionId)
      if (!state.open) return null
      const data = state.data
      const current = data?.current
      const totals = current?.totals
      const steps = current?.steps ?? []

      const stepRows = steps.map((step) => ({
        inp: step.inp,
        cacheRead: step.cacheRead,
        cacheWrite: step.cacheWrite,
        out: step.out,
        total: step.total,
        title: `T${step.turn}S${step.step} ${clock(step.time)}\n${t.input} ${step.inp}\n${t.cache} ${step.cacheRead}\n${t.output} ${step.out}\n${t.total} ${step.total}\n${(step.tools || []).join(', ')}`,
      }))
      const billableRows = steps.map((step) => ({
        inp: step.inp,
        cacheRead: 0,
        cacheWrite: 0,
        out: step.out,
        total: step.inp + step.out,
        title: `T${step.turn}S${step.step} ${clock(step.time)}\n${t.input} ${step.inp}\n${t.output} ${step.out}`,
      }))
      const dayRows = (data?.days ?? []).map((row) => ({
        inp: row.inp,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        out: row.out,
        total: row.total,
        title: `${row.date}\n${row.steps} ${t.steps}\n${t.input} ${row.inp}\n${t.cache} ${row.cacheRead}\n${t.output} ${row.out}\n${t.total} ${row.total}`,
      }))

      return h(
        'div',
        { className: 'tmx-vars tmx-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'tmx-panel' },
          h(
            'div',
            { className: 'tmx-panel-head' },
            h('b', null, t.title),
            h('span', { className: 'tmx-sub' }, current?.title || current?.sessionId || ''),
            h('span', { className: 'tmx-spacer' }),
            h('button', { type: 'button', className: 'tmx-btn', onClick: load, disabled: state.busy }, t.refresh),
            h('button', { type: 'button', className: 'tmx-btn', onClick: () => patch({ open: false }) }, t.collapse),
          ),
          data
            ? h(
                'div',
                { className: 'tmx-cards' },
                card('', t.thisSession, totals ?? { steps: 0 }, data.fx, t),
                card('today', t.today, data.today ?? { steps: 0 }, data.fx, t),
                card('all', t.allTime, data.totals ?? { steps: 0 }, data.fx, t),
              )
            : h('p', { className: 'tmx-hint' }, state.error ? `${t.failed}: ${state.error}` : t.loading),
          data
            ? h(
                'div',
                { className: 'tmx-sec' },
                h('h3', null, t.perStep),
                steps.length
                  ? h(
                      'div',
                      null,
                      h(
                        'div',
                        { className: 'tmx-duo' },
                        h('figure', null, h('figcaption', null, t.chartTotal), h('div', { className: 'tmx-bars' }, stackedBars(stepRows))),
                        h('figure', null, h('figcaption', null, t.chartBillable), h('div', { className: 'tmx-bars' }, stackedBars(billableRows))),
                      ),
                      legend(t),
                      h('p', { className: 'tmx-hint' }, t.perStepHint),
                    )
                  : h('p', { className: 'tmx-hint' }, t.empty),
              )
            : null,
          data ? h('div', { className: 'tmx-sec' }, h('h3', null, t.days), h('div', { className: 'tmx-daybar' }, stackedBars(dayRows))) : null,
          data ? tables(data, t) : null,
          data
            ? h(
                'div',
                { className: 'tmx-foot' },
                h('span', null, `${t.scan} ${data.scan?.files ?? 0} ${t.files} · ${data.scan?.sessions ?? 0} sessions · ${data.scan?.ms ?? 0}ms`),
                h('span', null, `${t.updated} ${clock(data.generatedAt)}`),
              )
            : null,
        ),
      )
    }

    function pickLocale(ctx) {
      try {
        const snapshot = ctx.get('locale')?.getLocale?.()
        const id = String(snapshot?.id ?? snapshot?.locale ?? '')
        return id.toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = DICT[pickLocale(ctx)]
        const chip = (props) => h(Chip, { ...props, t })
        const panel = (props) => h(Panel, { ...props, t })
        ctx.slots.inject(CHIP_SLOT, () => ctx.slots.register({ name: CHIP_SLOT, id: 'token-meter', order: 12 }, chip))
        ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, id: 'token-meter', order: 15 }, panel))
      },
    }
  },
})
