window.__ModuleLoader__.load({
  id: '@local/dsh-usage-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-usage-panel';
    const USAGE_ID = '@local/dsh-usage-panel';
    const USAGE_KIND = 'usage';
    // The payload shape this client renders. A mismatch shows an error, not zeros.
    const CLIENT_SCHEMA = 2;

    const en = {
      'type.label': 'Usage',
      'guide.title': 'Usage and limits',
      'guide.description': 'Token use, credit cost, and the credit limit of every ns-bridge vendor',
      'panel.loading': 'Loading usage',
      'panel.error': 'Failed to load usage',
      'panel.empty': 'No usage in this window',
      'panel.unexpected': 'The panel and the host disagree on the data shape',
      'panel.retry': 'Load the summary again',
      'action.retry': 'Retry',
      'action.refresh': 'Refresh',
      'window.label': 'Window',
      'window.days': '{days} days',
      'window.range': '{from} to {to}',
      'totals.tokens': 'Tokens',
      'totals.output': '{tokens} output',
      'totals.credits': 'Credits',
      'totals.sessions': 'Sessions',
      'totals.cacheHit': 'Cache hit',
      'totals.cacheRead': '{read} read',
      'totals.ofBilled': '{billed} billed, {estimated} estimated',
      'section.limits': 'Credit limits',
      'section.days': 'Credits per day',
      'section.models': 'Models',
      'limits.note': 'Limits come from your own files. The panel never invents a quota.',
      'column.vendor': 'Vendor',
      'column.model': 'Model',
      'column.tokens': 'Tokens',
      'column.credits': 'Credits',
      'column.steps': 'Steps',
      'column.cacheHit': 'Hit',
      'column.sessions': 'Sess.',
      'cost.billed': 'billed',
      'cost.estimated': 'est.',
      'limit.none': 'no limit',
      'limit.left': '{credits} left',
      'limit.over': 'over by {credits}',
      'limit.file': 'limit from credit-budgets.json',
      'limit.env': 'limit from NS_BRIDGE_CREDIT_LIMIT',
      'limit.spent': 'spent {credits} credits'
    };

    const vi = {
      'type.label': 'Mức dùng',
      'guide.title': 'Mức dùng và hạn mức',
      'guide.description': 'Token, chi phí tín dụng và hạn mức tín dụng của từng nhà cung cấp ns-bridge',
      'panel.loading': 'Đang tải mức dùng',
      'panel.error': 'Không tải được mức dùng',
      'panel.empty': 'Chưa có dữ liệu trong khoảng này',
      'panel.unexpected': 'Panel và host không cùng phiên bản dữ liệu',
      'panel.retry': 'Tải lại bảng tổng hợp',
      'action.retry': 'Thử lại',
      'action.refresh': 'Làm mới',
      'window.label': 'Khoảng',
      'window.days': '{days} ngày',
      'window.range': '{from} đến {to}',
      'totals.tokens': 'Token',
      'totals.output': 'ra {tokens}',
      'totals.credits': 'Tín dụng',
      'totals.sessions': 'Phiên',
      'totals.cacheHit': 'Cache hit',
      'totals.cacheRead': 'đọc {read}',
      'totals.ofBilled': '{billed} tính tiền, {estimated} ước tính',
      'section.limits': 'Hạn mức tín dụng',
      'section.days': 'Tín dụng theo ngày',
      'section.models': 'Model',
      'limits.note': 'Hạn mức lấy từ tệp của bạn. Panel không tự tạo định mức.',
      'column.vendor': 'Nhà cung cấp',
      'column.model': 'Model',
      'column.tokens': 'Token',
      'column.credits': 'Tín dụng',
      'column.steps': 'Bước',
      'column.cacheHit': 'Hit',
      'column.sessions': 'Phiên',
      'cost.billed': 'tính tiền',
      'cost.estimated': 'ước tính',
      'limit.none': 'không hạn mức',
      'limit.left': 'còn {credits}',
      'limit.over': 'vượt {credits}',
      'limit.file': 'hạn mức từ credit-budgets.json',
      'limit.env': 'hạn mức từ NS_BRIDGE_CREDIT_LIMIT',
      'limit.spent': 'đã dùng {credits} tín dụng'
    };

    const zh = {
      'type.label': '用量',
      'guide.title': '用量与限额',
      'guide.description': '每个 ns-bridge 供应商的 token 用量、额度成本与额度上限',
      'panel.loading': '正在加载用量',
      'panel.error': '用量加载失败',
      'panel.empty': '此时间段没有用量数据',
      'panel.unexpected': '面板与宿主的数据版本不一致',
      'panel.retry': '重新加载汇总',
      'action.retry': '重试',
      'action.refresh': '刷新',
      'window.label': '时间段',
      'window.days': '{days} 天',
      'window.range': '{from} 至 {to}',
      'totals.tokens': 'Token',
      'totals.output': '输出 {tokens}',
      'totals.credits': '额度',
      'totals.sessions': '会话',
      'totals.cacheHit': '缓存命中',
      'totals.cacheRead': '读 {read}',
      'totals.ofBilled': '已计费 {billed}，估算 {estimated}',
      'section.limits': '额度限额',
      'section.days': '每日额度',
      'section.models': '模型',
      'limits.note': '限额来自你自己的文件，面板不会臆造配额。',
      'column.vendor': '供应商',
      'column.model': '模型',
      'column.tokens': 'Token',
      'column.credits': '额度',
      'column.steps': '步骤',
      'column.cacheHit': '命中',
      'column.sessions': '会话',
      'cost.billed': '已计费',
      'cost.estimated': '估算',
      'limit.none': '未设限额',
      'limit.left': '剩 {credits}',
      'limit.over': '超 {credits}',
      'limit.file': '限额来自 credit-budgets.json',
      'limit.env': '限额来自 NS_BRIDGE_CREDIT_LIMIT',
      'limit.spent': '已用 {credits} 额度'
    };

    function UsageArtwork({ size }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true
      },
        h('path', { key: 'axis', d: 'M3 3v18h18' }),
        h('path', { key: 'line', d: 'M7 14l4-4 4 4 4-6' })
      );
    }

    function usageTabDefinition(t) {
      return {
        id: USAGE_ID,
        kind: USAGE_KIND,
        priority: 'extension',
        title: () => t('type.label'),
        guide: [{
          id: 'summary',
          order: 100,
          title: () => t('guide.title'),
          description: () => t('guide.description'),
          icon: UsageArtwork
        }]
      };
    }

    // Vendor marks are data colours. Every other colour here is a theme token.
    const VENDOR_COLORS = {
      grok: '#4A90E2',
      kiro: '#D97706',
      qoder: '#10A37F',
      devin: '#8B5CF6',
      deepseek: '#4A90E2',
      openai: '#10A37F',
      anthropic: '#D97706',
      google: '#4285F4'
    };
    const VENDOR_FALLBACK_COLOR = '#6B7280';

    function vendorColor(vendor) {
      return VENDOR_COLORS[String(vendor ?? '').toLowerCase()] ?? VENDOR_FALLBACK_COLOR;
    }

    const NUMERIC = { fontVariantNumeric: 'tabular-nums' };

    function formatTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
      return String(Math.round(n));
    }

    function formatCredits(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      return n.toFixed(2);
    }

    function formatRatio(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
      return `${Math.round(ratio * 100)}%`;
    }

    function fill(template, values) {
      let text = template;
      for (const key of Object.keys(values)) {
        text = text.split(`{${key}}`).join(values[key]);
      }
      return text;
    }

    function Spinner() {
      return h('div', {
        style: {
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          border: '2px solid var(--dsw-alias-border-l1)',
          borderTopColor: 'var(--dsw-alias-brand-primary)',
          animation: 'dsh-spin 0.8s linear infinite'
        }
      });
    }

    /** A button that always carries a tooltip. */
    function ToolButton(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        onClick: props.onClick,
        disabled: props.disabled,
        'aria-pressed': props.active === undefined ? undefined : props.active,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '3px 8px',
          fontSize: '12px',
          lineHeight: '16px',
          color: props.active
            ? 'var(--dsw-alias-label-primary)'
            : 'var(--dsw-alias-label-secondary)',
          backgroundColor: props.active
            ? 'var(--dsw-alias-bg-layer-2)'
            : 'transparent',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '5px',
          cursor: props.disabled ? 'default' : 'pointer',
          opacity: props.disabled ? 0.5 : 1,
          fontVariantNumeric: 'tabular-nums'
        }
      }, props.label);
    }

    function SectionTitle(props) {
      return h('div', {
        style: {
          fontSize: '11px',
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--dsw-alias-label-secondary)',
          marginBottom: '6px'
        }
      }, props.children);
    }

    function SummaryCard(props) {
      const cardStyle = {
        flex: '1 1 0',
        minWidth: '104px',
        padding: '8px 10px',
        backgroundColor: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderLeft: `3px solid ${props.color}`,
        borderRadius: '6px'
      };
      return h('div', { style: cardStyle },
        h('div', {
          style: {
            fontSize: '10px',
            letterSpacing: '0.5px',
            textTransform: 'uppercase',
            color: 'var(--dsw-alias-label-secondary)'
          }
        }, props.label),
        h('div', {
          style: { fontSize: '17px', lineHeight: '22px', ...NUMERIC, color: 'var(--dsw-alias-label-primary)' }
        }, props.value),
        props.hint
          ? h('div', {
            style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' }
          }, props.hint)
          : null);
    }

    /** One usage bar. The fill clamps to the track; the label keeps the real ratio. */
    function MeterBar(props) {
      const clamped = Math.max(0, Math.min(1, props.ratio));
      return h('div', {
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(clamped * 100),
        'aria-label': props.label,
        style: {
          flex: '1 1 auto',
          minWidth: '48px',
          height: `${props.height ?? 6}px`,
          backgroundColor: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '999px',
          overflow: 'hidden'
        }
      },
        h('div', {
          style: {
            width: `${clamped * 100}%`,
            height: '100%',
            backgroundColor: props.color,
            transition: 'width 0.2s ease'
          }
        }));
    }

    /**
     * One vendor against one limit. `limit: null` means the user declared no
     * limit, so the row shows no bar and no budget figure. Over budget keeps a
     * negative remainder, because that is the number the user needs to see.
     */
    function LimitRow(props) {
      const vendor = props.vendor;
      const t = props.t;
      const limit = Number.isFinite(vendor.limit) && vendor.limit > 0 ? Number(vendor.limit) : null;
      const spent = Number(vendor.totalCredits) || 0;
      const over = vendor.overLimit === true;
      const left = Number(vendor.remainingCredits);
      const ratio = limit === null ? 0 : spent / limit;
      const color = limit === null
        ? 'var(--dsw-alias-brand-primary)'
        : over
          ? 'var(--dsw-alias-state-error-primary)'
          : ratio > 0.8
            ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-state-success-primary)';
      const source = vendor.limitSource === 'file'
        ? t('limit.file')
        : vendor.limitSource === 'env'
          ? t('limit.env')
          : t('limit.none');
      const figure = limit === null
        ? formatCredits(spent)
        : `${formatCredits(spent)} / ${formatCredits(limit)}`;
      const status = limit === null
        ? t('limit.none')
        : over
          ? t('limit.over').replace('{credits}', formatCredits(Math.abs(Number.isFinite(left) ? left : 0)))
          : t('limit.left').replace('{credits}', formatCredits(Number.isFinite(left) ? left : 0));
      // grok, qoder and devin bill almost nothing, so their cost is estimated.
      const estimatedOnly = spent > 0 && !(Number(vendor.billedCredits) > 0);
      return h('div', {
        title: `${vendor.vendor} · ${source} · ${t('limit.spent').replace('{credits}', formatCredits(spent))}`,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 0',
          borderTop: '1px solid var(--dsw-alias-border-l1)'
        }
      },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: vendorColor(vendor.vendor),
            flex: '0 0 auto'
          }
        }),
        h('span', {
          style: {
            width: '56px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }
        }, vendor.vendor),
        limit === null
          ? h('span', { style: { flex: '1 1 auto' } })
          : h(MeterBar, { ratio, color, label: `${vendor.vendor} ${t('section.limits')}` }),
        h('span', {
          style: {
            minWidth: '100px',
            textAlign: 'right',
            fontSize: '12px',
            ...NUMERIC,
            color: 'var(--dsw-alias-label-primary)'
          }
        },
          figure,
          estimatedOnly
            ? h('span', {
              style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' }
            }, ` ${t('cost.estimated')}`)
            : null),
        h('span', {
          style: {
            minWidth: '82px',
            textAlign: 'right',
            fontSize: '12px',
            ...NUMERIC,
            color: over ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'
          }
        }, status));
    }

    /**
     * Stacked day bars. Each segment is one vendor on one day, so the chart
     * shows both the daily total and who produced it.
     */
    function DayChart(props) {
      const days = props.days;
      const t = props.t;
      // These columns are built here from the host day rows. They are not host
      // rows, so they use their own names: column, segment.
      const peak = days.reduce((max, column) => Math.max(max, column.total), 0);
      if (!(peak > 0)) {
        return h('div', {
          style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
        }, t('panel.empty'));
      }
      const columns = days.map((column) => {
        const segments = column.parts.map((segment) => h('div', {
          key: `${column.day}:${segment.vendor}`,
          title: `${column.day} · ${segment.vendor} · ${formatCredits(segment.credits)} ${t('column.credits')} · ${segment.steps} ${t('column.steps')}`,
          style: {
            width: '100%',
            height: `${(segment.credits / peak) * 100}%`,
            minHeight: '2px',
            backgroundColor: vendorColor(segment.vendor),
            borderRadius: '2px'
          }
        }));
        return h('div', {
          key: column.day,
          style: {
            // Bars share the full width, so a 1-day window is not a thin strip
            // beside empty space.
            flex: '1 1 0',
            minWidth: '4px',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: '1px'
          }
        }, ...segments);
      });
      return h('div', {},
        h('div', {
          role: 'img',
          'aria-label': t('section.days'),
          style: {
            display: 'flex',
            alignItems: 'stretch',
            gap: '2px',
            height: '58px',
            borderBottom: '1px solid var(--dsw-alias-border-l2)'
          }
        }, ...columns),
        h('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '4px',
            fontSize: '10px',
            ...NUMERIC,
            color: 'var(--dsw-alias-label-secondary)'
          }
        },
          h('span', {}, days[0].day),
          h('span', {}, days[days.length - 1].day)));
    }

    function cellProps(align, color) {
      return {
        style: {
          padding: '5px 8px',
          fontSize: '12px',
          textAlign: align,
          color: color ?? 'var(--dsw-alias-label-primary)',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          whiteSpace: 'nowrap',
          fontVariantNumeric: 'tabular-nums'
        }
      };
    }

    const TABLE_COLUMNS = [
      ['column.vendor', 'left'],
      ['column.model', 'left'],
      ['column.tokens', 'right'],
      ['column.credits', 'right'],
      ['column.steps', 'right'],
      ['column.cacheHit', 'right'],
      ['column.sessions', 'right']
    ];

    function ModelsTable(props) {
      const models = props.models;
      const t = props.t;
      const head = h('thead', {}, h('tr', {}, ...TABLE_COLUMNS.map(([key, align]) => h('th', {
        key,
        scope: 'col',
        style: {
          position: 'sticky',
          top: 0,
          padding: '5px 8px',
          fontSize: '10px',
          fontWeight: 600,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          color: 'var(--dsw-alias-label-secondary)',
          textAlign: align,
          whiteSpace: 'nowrap',
          backgroundColor: 'var(--dsw-alias-bg-base)',
          borderBottom: '1px solid var(--dsw-alias-border-l2)'
        }
      }, t(key)))));
      const rows = models.map((model, index) => h('tr', {
        key: `${model.vendor}:${model.model}:${index}`,
        className: 'dsh-usage-panel__row',
        style: {
          backgroundColor: index % 2 === 0 ? 'transparent' : 'var(--dsw-alias-bg-layer-1)'
        }
      },
        h('td', cellProps('left'),
          h('span', {
            'aria-hidden': true,
            style: {
              display: 'inline-block',
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: vendorColor(model.vendor),
              marginRight: '6px'
            }
          }),
          model.vendor),
        h('td', cellProps('left'), model.model),
        h('td', cellProps('right'), formatTokens(model.totalTokens)),
        h('td', cellProps('right'), h('span', {
          title: `${formatCredits(model.billedCredits)} ${t('cost.billed')} · ${formatCredits(model.estimatedCredits)} ${t('cost.estimated')}`
        }, formatCredits(model.totalCredits))),
        h('td', cellProps('right', 'var(--dsw-alias-label-secondary)'), String(model.steps || 0)),
        h('td', cellProps('right', 'var(--dsw-alias-label-secondary)'), formatRatio(model.cacheHitRatio)),
        h('td', cellProps('right', 'var(--dsw-alias-label-secondary)'), String(model.sessionCount || 0))));
      return h('table', {
        style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' }
      }, head, h('tbody', {}, ...rows));
    }

    function UsageBody(props) {
      const t = props.t;
      const [state, setState] = React.useState({ phase: 'loading' });

      const load = React.useCallback(async () => {
        setState({ phase: 'loading' });
        let reason = 'rpc';
        let detail = '';
        try {
          // The gateway resolves to { ok: true, value } or { ok: false, error }.
          // A failed call is an outcome, so it never throws across the wire.
          const result = await props.connection.rpc.call('/api', 'usage/getUsageSummary', { args: {} });
          if (!result || result.ok !== true) {
            // Discriminate a remote failure by its stable code, not by instanceof.
            const failure = result && result.error;
            detail = String((failure && failure.code) || (failure && failure.message) || '');
          } else if (!result.value || result.value.schemaVersion !== CLIENT_SCHEMA) {
            reason = 'schema';
          } else {
            setState({ phase: 'ready', payload: result.value });
            return;
          }
        } catch (error) {
          // Only a carrier fault throws: offline transport or an aborted call.
          detail = String((error && error.code) || (error && error.message) || '');
        }
        setState({ phase: 'error', reason, detail });
      }, [props.connection]);

      React.useEffect(() => { load(); }, [load]);

      const payload = state.payload;
      const vendors = Array.isArray(payload?.vendors) ? payload.vendors : [];
      const models = Array.isArray(payload?.models) ? payload.models : [];
      const dayRows = Array.isArray(payload?.days) ? payload.days : [];
      const totals = payload?.totals ?? {};
      const meta = payload?.window ?? {};

      // Group the per-day rows into one column per day, newest segments last.
      const byDay = new Map();
      for (const row of dayRows) {
        let column = byDay.get(row.day);
        if (!column) {
          column = { day: row.day, total: 0, parts: [] };
          byDay.set(row.day, column);
        }
        column.total += Number(row.totalCredits) || 0;
        column.parts.push({
          vendor: row.vendor,
          credits: Number(row.totalCredits) || 0,
          steps: Number(row.steps) || 0
        });
      }
      const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-31);
      for (const column of days) column.parts.sort((a, b) => b.credits - a.credits);

      const head = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }
      },
        h(SectionTitle, { key: 'label' },
          fill(t('window.label'), {}) + ' · ' + fill(t('window.days'), { days: String(meta.days ?? '') })),
        h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
        h(ToolButton, {
          key: 'refresh',
          label: t('action.refresh'),
          title: t('panel.retry'),
          onClick: load
        }));

      const cards = h('div', {
        style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }
      },
        h(SummaryCard, {
          key: 'tokens',
          label: t('totals.tokens'),
          value: formatTokens(totals.totalTokens),
          hint: fill(t('totals.output'), { tokens: formatTokens(totals.outputTokens) }),
          color: 'var(--dsw-alias-brand-primary)'
        }),
        h(SummaryCard, {
          key: 'credits',
          label: t('totals.credits'),
          value: formatCredits(totals.totalCredits),
          hint: fill(t('totals.ofBilled'), {
            billed: formatCredits(totals.billedCredits),
            estimated: formatCredits(totals.estimatedCredits)
          }),
          color: 'var(--dsw-alias-state-warn-primary)'
        }),
        h(SummaryCard, {
          key: 'sessions',
          label: t('totals.sessions'),
          value: String(totals.sessionCount || 0),
          hint: `${totals.steps || 0} ${t('column.steps')}`,
          color: 'var(--dsw-alias-state-success-primary)'
        }),
        h(SummaryCard, {
          key: 'cache',
          label: t('totals.cacheHit'),
          value: formatRatio(totals.cacheHitRatio),
          hint: fill(t('totals.cacheRead'), { read: formatTokens(totals.cacheReadTokens) }),
          color: 'var(--dsw-alias-state-idle-primary)'
        }));

      const limitBlock = h('div', { style: { marginBottom: '12px' } },
        h(SectionTitle, {}, t('section.limits')),
        vendors.length === 0
          ? h('div', {
            style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
          }, t('panel.empty'))
          : h('div', {}, ...vendors.map((vendor) => h(LimitRow, { key: vendor.vendor, vendor, t }))),
        h('div', {
          style: { marginTop: '6px', fontSize: '10px', color: 'var(--dsw-alias-label-secondary)' }
        }, t('limits.note')));

      const dayBlock = h('div', { style: { marginBottom: '12px' } },
        h(SectionTitle, {}, t('section.days')),
        days.length === 0
          ? h('div', {
            style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
          }, t('panel.empty'))
          : h(DayChart, { days, t }),
        meta.from && meta.to
          ? h('div', {
            style: { marginTop: '4px', fontSize: '10px', ...NUMERIC, color: 'var(--dsw-alias-label-secondary)' }
          }, fill(t('window.range'), { from: meta.from, to: meta.to }))
          : null);

      const modelBlock = h('div', {},
        h(SectionTitle, {}, t('section.models')),
        models.length === 0
          ? h('div', {
            style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }
          }, t('panel.empty'))
          : h('div', { style: { maxHeight: '190px', overflow: 'auto' } }, h(ModelsTable, { models, t })));

      let content;
      if (state.phase === 'loading') {
        content = h('div', {
          role: 'status',
          'aria-live': 'polite',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '20px 0',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-secondary)'
          }
        }, h(Spinner), t('panel.loading'));
      } else if (state.phase === 'error') {
        content = h('div', {
          role: 'alert',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '12px',
            border: '1px solid var(--dsw-alias-state-error-primary)',
            borderRadius: '6px',
            fontSize: '12px',
            color: 'var(--dsw-alias-label-primary)'
          }
        },
          h('span', {},
            state.reason === 'schema' ? t('panel.unexpected') : t('panel.error'),
            state.detail ? ' (' + state.detail + ')' : ''),
          h(ToolButton, { label: t('action.retry'), title: t('panel.retry'), onClick: load }));
      } else if (vendors.length === 0 && models.length === 0 && days.length === 0) {
        content = h('div', {
          style: { padding: '14px 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }
        }, t('panel.empty'));
      } else {
        content = h('div', {}, limitBlock, cards, dayBlock, modelBlock);
      }

      return h('div', {
        style: { padding: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-primary)' }
      },
        h('style', {
          // Two rules only. Every colour in the panel is a theme token.
          dangerouslySetInnerHTML: {
            __html: '@keyframes dsh-spin{to{transform:rotate(360deg)}}' +
              '.dsh-usage-panel__row:hover{background-color:var(--dsw-alias-bg-layer-2)!important}'
          }
        }),
        state.phase === 'ready' ? head : null,
        content);
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'dsh-usage-panel: en');
        ctx.effect(() => ctx.locale.register(NS, 'vi', vi), 'dsh-usage-panel: vi');
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'dsh-usage-panel: zh');

        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.sidebarRightTabs.register(usageTabDefinition(t)), 'dsh-usage-panel: type');

        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: USAGE_ID,
          locale: NS,
          inject: () => ({ connection: ctx.connection, t })
        }, UsageBody)), 'dsh-usage-panel: body');
      }
    };
  }
});
