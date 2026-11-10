window.__ModuleLoader__.load({
  id: '@local/dsh-usage-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-usage-panel';
    const USAGE_ID = '@local/dsh-usage-panel';
    const USAGE_KIND = 'usage';

    const en = {
      'type.label': 'Usage',
      'guide.title': 'Usage & credits',
      'guide.description': 'Token and credit usage of ns-bridge provider models',
      'panel.title': 'Usage summary',
      'panel.loading': 'Loading usage…',
      'panel.error': 'Failed to load usage',
      'panel.empty': 'No usage data yet',
      'column.vendor': 'Vendor',
      'column.model': 'Model',
      'column.tokens': 'Tokens',
      'column.credits': 'Credits',
      'column.remaining': 'Remaining',
      'column.sessions': 'Sessions',
      'section.vendorBudget': 'Vendor Budgets',
      'action.retry': 'Retry'
    };

    const vi = {
      'type.label': 'Mức dùng',
      'guide.title': 'Token & tín dụng',
      'guide.description': 'Token và tín dụng của các model provider ns-bridge',
      'panel.title': 'Tổng hợp mức dùng',
      'panel.loading': 'Đang tải mức dùng…',
      'panel.error': 'Không tải được mức dùng',
      'panel.empty': 'Chưa có dữ liệu mức dùng',
      'column.vendor': 'Nhà cung cấp',
      'column.model': 'Model',
      'column.tokens': 'Token',
      'column.credits': 'Tín dụng',
      'column.remaining': 'Còn lại',
      'column.sessions': 'Phiên',
      'section.vendorBudget': 'Ngân sách nhà cung cấp',
      'action.retry': 'Thử lại'
    };

    const zh = {
      'type.label': '用量',
      'guide.title': '用量与额度',
      'guide.description': 'ns-bridge 各模型的 token 与额度用量',
      'panel.title': '用量汇总',
      'panel.loading': '正在加载用量…',
      'panel.error': '用量加载失败',
      'panel.empty': '暂无用量数据',
      'column.vendor': '供应商',
      'column.model': '模型',
      'column.tokens': 'Token',
      'column.credits': '额度',
      'column.remaining': '剩余',
      'column.sessions': '会话',
      'section.vendorBudget': '供应商预算',
      'action.retry': '重试'
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

    function formatNumber(value) {
      return Number(value || 0).toLocaleString();
    }

    function formatCredits(value) {
      return Number(value || 0).toFixed(2);
    }

    function SummaryCard({ icon, label, value, accentColor }) {
      return h('div', { 
        style: { 
          borderLeft: `3px solid ${accentColor}`,
          padding: '12px 16px',
          backgroundColor: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: '6px',
          flex: '1 1 0'
        }
      },
        h('div', { 
          style: { 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px',
            marginBottom: '4px'
          }
        },
          h('span', { style: { fontSize: '18px' } }, icon),
          h('span', { 
            style: { 
              fontSize: '12px', 
              color: 'var(--dsw-alias-label-secondary)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              fontWeight: '500'
            }
          }, label)
        ),
        h('div', { 
          style: { 
            fontSize: '20px', 
            fontWeight: '600',
            color: 'var(--dsw-alias-label-primary)'
          }
        }, value)
      );
    }

    function Spinner() {
      return h('div', {
        style: {
          display: 'inline-block',
          width: '20px',
          height: '20px',
          border: '2px solid var(--dsw-alias-border-l1)',
          borderTopColor: 'var(--dsw-alias-brand-primary)',
          borderRadius: '50%',
          animation: 'dsh-spin 0.8s linear infinite'
        }
      });
    }

    function UsageBody(props) {
      const { t } = props;
      const [state, setState] = React.useState({ phase: 'loading', rows: [] });

      const load = React.useCallback(async () => {
        setState({ phase: 'loading', rows: [] });
        try {
          const result = await props.connection.rpc.call('/api', 'usage/getUsageSummary', { args: {} });
          const payload = result && result.ok === true ? result.value : result;
          const rows = Array.isArray(payload) ? payload : [];
          setState({ phase: 'ok', rows });
        } catch {
          setState({ phase: 'error', rows: [] });
        }
      }, [props.connection]);

      React.useEffect(() => {
        load();
      }, [load]);

      const totalTokens = state.rows.reduce((sum, row) => sum + (row.totalTokens || 0), 0);
      const totalCredits = state.rows.reduce((sum, row) => sum + (row.totalCredits || 0), 0);
      const totalSessions = state.rows.reduce((sum, row) => sum + (row.sessionCount || 0), 0);

      // Group by vendor to show remaining credits
      const vendorMap = new Map();
      state.rows.forEach(row => {
        if (!vendorMap.has(row.vendor)) {
          vendorMap.set(row.vendor, {
            vendor: row.vendor,
            totalCredits: 0,
            remainingCredits: row.remainingCredits || 0
          });
        }
        const vendor = vendorMap.get(row.vendor);
        vendor.totalCredits += row.totalCredits || 0;
      });
      const vendorBudgets = Array.from(vendorMap.values());

      if (state.phase === 'loading') {
        return h('div', { 
          style: { 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center', 
            justifyContent: 'center',
            padding: '40px 20px',
            gap: '12px'
          }
        },
          h(Spinner),
          h('span', { 
            style: { 
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '14px'
            }
          }, t('panel.loading'))
        );
      }

      if (state.phase === 'error') {
        return h('div', { 
          style: { 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center', 
            justifyContent: 'center',
            padding: '40px 20px',
            gap: '12px'
          }
        },
          h('span', { style: { fontSize: '32px' } }, '⚠️'),
          h('span', { 
            style: { 
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '14px'
            }
          }, t('panel.error')),
          h('button', {
            type: 'button',
            onClick: () => load(),
            style: {
              marginTop: '8px',
              padding: '8px 16px',
              backgroundColor: 'var(--dsw-alias-brand-primary)',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: '500'
            }
          }, t('action.retry'))
        );
      }

      if (state.rows.length === 0) {
        return h('div', { 
          style: { 
            display: 'flex', 
            flexDirection: 'column',
            alignItems: 'center', 
            justifyContent: 'center',
            padding: '60px 20px',
            gap: '12px'
          }
        },
          h('span', { style: { fontSize: '48px', opacity: '0.3' } }, '📊'),
          h('span', { 
            style: { 
              color: 'var(--dsw-alias-label-secondary)',
              fontSize: '14px'
            }
          }, t('panel.empty'))
        );
      }

      const vendorColors = {
        'deepseek': '#4A90E2',
        'openai': '#10A37F',
        'anthropic': '#D97706',
        'google': '#4285F4',
        'default': '#6B7280'
      };

      const getVendorColor = (vendor) => {
        const key = vendor.toLowerCase();
        return vendorColors[key] || vendorColors.default;
      };

      const headerCells = [
        ['vendor', 'column.vendor', 'left'],
        ['model', 'column.model', 'left'],
        ['tokens', 'column.tokens', 'right'],
        ['credits', 'column.credits', 'right'],
        ['sessions', 'column.sessions', 'right']
      ];

      return h('div', { 
        style: { 
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px'
        }
      },
        h('style', {}, `
          @keyframes dsh-spin {
            to { transform: rotate(360deg); }
          }
          .dsh-usage-panel__row:hover {
            background-color: var(--dsw-alias-bg-layer-2) !important;
          }
        `),
        
        // Summary cards
        h('div', { 
          style: { 
            display: 'flex', 
            gap: '12px',
            flexWrap: 'wrap'
          }
        },
          h(SummaryCard, {
            icon: '🔤',
            label: t('column.tokens'),
            value: formatNumber(totalTokens),
            accentColor: '#4A90E2'
          }),
          h(SummaryCard, {
            icon: '💰',
            label: t('column.credits'),
            value: formatCredits(totalCredits),
            accentColor: '#10A37F'
          }),
          h(SummaryCard, {
            icon: '💬',
            label: t('column.sessions'),
            value: formatNumber(totalSessions),
            accentColor: '#D97706'
          })
        ),

        // Vendor budgets section
        vendorBudgets.length > 0 && h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '8px',
            overflow: 'hidden'
          }
        },
          h('div', {
            style: {
              padding: '10px 12px',
              backgroundColor: 'var(--dsw-alias-bg-layer-2)',
              borderBottom: '1px solid var(--dsw-alias-border-l1)',
              fontWeight: '600',
              fontSize: '11px',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              color: 'var(--dsw-alias-label-secondary)'
            }
          }, t('section.vendorBudget')),
          h('div', {
            style: {
              padding: '8px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px'
            }
          },
            vendorBudgets.map((vendor, idx) => {
              const hasBudget = vendor.remainingCredits > 0 || vendor.totalCredits > 0;
              const budgetTotal = vendor.totalCredits + vendor.remainingCredits;
              const percentUsed = budgetTotal > 0 ? (vendor.totalCredits / budgetTotal * 100) : 0;
              const barColor = percentUsed > 80 ? '#EF4444' : percentUsed > 60 ? '#F59E0B' : '#10B981';
              
              return h('div', {
                key: vendor.vendor,
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px'
                }
              },
                h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    minWidth: '80px'
                  }
                },
                  h('span', {
                    style: {
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: getVendorColor(vendor.vendor),
                      flexShrink: 0
                    }
                  }),
                  h('span', {
                    style: {
                      fontWeight: '500',
                      fontSize: '13px',
                      color: 'var(--dsw-alias-label-primary)'
                    }
                  }, vendor.vendor)
                ),
                h('div', {
                  style: {
                    flex: 1,
                    height: '8px',
                    backgroundColor: 'var(--dsw-alias-border-l1)',
                    borderRadius: '4px',
                    overflow: 'hidden'
                  }
                },
                  h('div', {
                    style: {
                      width: `${Math.min(100, percentUsed)}%`,
                      height: '100%',
                      backgroundColor: barColor,
                      borderRadius: '4px',
                      transition: 'width 0.3s ease'
                    }
                  })
                ),
                h('div', {
                  style: {
                    display: 'flex',
                    gap: '8px',
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    minWidth: '140px',
                    justifyContent: 'flex-end'
                  }
                },
                  h('span', {
                    style: { color: 'var(--dsw-alias-label-secondary)' }
                  }, `${formatCredits(vendor.totalCredits)} / ${formatCredits(budgetTotal)}`),
                  h('span', {
                    style: { 
                      color: 'var(--dsw-alias-state-success-primary)',
                      fontWeight: '600'
                    }
                  }, `(${formatCredits(vendor.remainingCredits)})`)
                )
              );
            })
          )
        ),

        // Table
        h('div', {
          style: {
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: '8px',
            overflow: 'hidden'
          }
        },
          h('table', { 
            style: { 
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '13px'
            }
          },
            h('thead', {},
              h('tr', {
                style: {
                  backgroundColor: 'var(--dsw-alias-bg-layer-2)',
                  borderBottom: '1px solid var(--dsw-alias-border-l1)'
                }
              },
                headerCells.map(([key, labelKey, align]) => h('th', {
                  key,
                  style: {
                    padding: '10px 12px',
                    textAlign: align,
                    fontWeight: '600',
                    fontSize: '11px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px',
                    color: 'var(--dsw-alias-label-secondary)'
                  }
                }, t(labelKey)))
              )
            ),
            h('tbody', {},
              state.rows.map((row, index) => h('tr', { 
                key: `${row.vendor}:${row.model}:${index}`,
                className: 'dsh-usage-panel__row',
                style: {
                  borderBottom: index < state.rows.length - 1 ? '1px solid var(--dsw-alias-border-l1)' : 'none',
                  backgroundColor: index % 2 === 0 ? 'transparent' : 'var(--dsw-alias-bg-layer-2)',
                  transition: 'background-color 0.15s ease'
                }
              },
                h('td', { 
                  style: { 
                    padding: '10px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }
                },
                  h('span', {
                    style: {
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      backgroundColor: getVendorColor(row.vendor),
                      flexShrink: 0
                    }
                  }),
                  h('span', { 
                    style: { 
                      fontWeight: '500',
                      color: 'var(--dsw-alias-label-primary)'
                    } 
                  }, row.vendor)
                ),
                h('td', { 
                  style: { 
                    padding: '10px 12px',
                    color: 'var(--dsw-alias-label-secondary)'
                  }
                }, row.model),
                h('td', { 
                  style: { 
                    padding: '10px 12px',
                    textAlign: 'right',
                    fontFamily: 'monospace',
                    fontWeight: '500',
                    color: 'var(--dsw-alias-label-primary)'
                  }
                }, formatNumber(row.totalTokens)),
                h('td', { 
                  style: { 
                    padding: '10px 12px',
                    textAlign: 'right',
                    fontFamily: 'monospace',
                    fontWeight: '500',
                    color: row.totalCredits > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)'
                  }
                }, formatCredits(row.totalCredits)),
                h('td', { 
                  style: { 
                    padding: '10px 12px',
                    textAlign: 'right',
                    fontFamily: 'monospace',
                    fontWeight: '500',
                    color: 'var(--dsw-alias-label-primary)'
                  }
                }, formatNumber(row.sessionCount))
              ))
            )
          )
        )
      );
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
          inject: () => ({ connection: ctx.connection })
        }, UsageBody)), 'dsh-usage-panel: body');
      }
    };
  }
});
