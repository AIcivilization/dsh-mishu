// Board styles on DSH's own theme variables (with fallbacks), so the page
// follows DSH's light and dark themes. Every class is prefixed `mishu-`.

const v = (name: string, fallback: string) => `var(--dsw-alias-${name}, ${fallback})`

const TEXT = v('label-primary', 'CanvasText')
const MUTED = v('label-secondary', 'GrayText')
const FAINT = v('label-tertiary', 'GrayText')
const LINE = v('border-l2', 'rgba(127,127,127,.22)')
const LINE_STRONG = v('border-l3', 'rgba(127,127,127,.35)')
const LAYER1 = v('bg-layer-1', 'rgba(127,127,127,.06)')
const LAYER2 = v('bg-layer-2', 'rgba(127,127,127,.10)')
const HOVER = v('interactive-bg-hover', 'rgba(127,127,127,.12)')
const DANGER = v('state-error-primary', '#d14343')
const WARN = v('state-warn-primary', '#b7791f')
const OK = v('state-success-primary', '#2f855a')
const ACCENT = v('brand-primary', '#4d6bfe')

export const STYLES = `
.mishu-page{box-sizing:border-box;height:100%;overflow:auto;padding:20px 24px 32px;color:${TEXT};font-size:13px;line-height:1.5}
.mishu-page *{box-sizing:border-box}
.mishu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.mishu-head h1{font-size:18px;font-weight:600;margin:0}
.mishu-sources{display:flex;align-items:center;gap:10px;color:${MUTED};font-size:12px;flex-wrap:wrap}
.mishu-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px;vertical-align:1px;background:${FAINT}}
.mishu-dot.ok{background:${OK}}.mishu-dot.error{background:${DANGER}}
.mishu-summary{font-size:15px;margin:4px 0 14px;max-width:72ch}
.mishu-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
.mishu-metric{background:${LAYER1};border-radius:10px;padding:10px 12px}
.mishu-metric-label{font-size:12px;color:${MUTED}}
.mishu-metric-value{font-size:22px;font-weight:600;line-height:1.3}
.mishu-metric-value small{font-size:12px;font-weight:400;margin-left:6px}
.mishu-danger{color:${DANGER}}.mishu-warn{color:${WARN}}
.mishu-columns{display:grid;grid-template-columns:var(--mishu-cols,minmax(0,1fr) 10px minmax(0,1fr) 10px minmax(0,1fr));gap:0;align-items:stretch}
.mishu-divider{cursor:col-resize;position:relative;touch-action:none}
.mishu-divider::after{content:'';position:absolute;top:8px;bottom:8px;left:4px;width:2px;border-radius:1px;background:transparent;transition:background .12s}
.mishu-divider:hover::after,.mishu-divider:active::after{background:${ACCENT}}
.mishu-col{background:${LAYER1};border-radius:12px;padding:10px;min-height:120px;min-width:0;border:1px solid transparent;transition:border-color .12s;align-self:start}
.mishu-col.drop{border-color:${ACCENT};border-style:dashed}
.mishu-col-head{display:flex;justify-content:space-between;align-items:baseline;font-weight:600;margin:2px 4px 8px}
.mishu-col-head span{color:${MUTED};font-weight:400}
.mishu-empty{color:${FAINT};padding:8px 4px}
.mishu-card{background:${LAYER2};border:1px solid ${LINE};border-radius:8px;padding:8px 10px;margin-bottom:8px}
.mishu-card[draggable=true]{cursor:grab}
.mishu-card.danger{border-color:${DANGER}}
.mishu-card-title{font-weight:600;word-break:break-word}
.mishu-card-meta{font-size:12px;color:${MUTED};margin-top:2px}
.mishu-card.danger .mishu-card-meta{color:${DANGER}}
.mishu-card.warn .mishu-card-meta{color:${WARN}}
.mishu-card-note{font-size:12px;color:${MUTED};margin-top:4px;word-break:break-word}
.mishu-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.mishu-explain{margin-top:6px;display:flex;flex-direction:column;gap:4px}
.mishu-row-explain{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;font-size:12px;line-height:1.55;word-break:break-word}
.mishu-row-label{color:${FAINT};white-space:nowrap;font-size:12px}
.mishu-fix span:last-child{color:${TEXT}}
.mishu-detail{margin-top:8px;padding-top:8px;border-top:1px dashed ${LINE};display:flex;flex-direction:column;gap:6px}
.mishu-messages ul{margin:4px 0 0;padding-left:16px;font-size:12px;color:${MUTED}}
.mishu-messages li span{color:${FAINT};margin-right:4px}
.mishu-btn-quiet{border-color:transparent;color:${MUTED}}
.mishu-btn{font:inherit;font-size:12px;color:${TEXT};background:transparent;border:1px solid ${LINE_STRONG};border-radius:6px;padding:2px 9px;cursor:pointer}
.mishu-btn:hover{background:${HOVER}}
.mishu-btn:disabled{opacity:.5;cursor:default}
.mishu-btn.primary{border-color:${ACCENT};color:${ACCENT}}
.mishu-group{border-top:1px solid ${LINE};padding:6px 4px}
.mishu-group summary{cursor:pointer;display:flex;justify-content:space-between;list-style:none}
.mishu-group summary::-webkit-details-marker{display:none}
.mishu-group summary span{color:${MUTED}}
.mishu-group .mishu-card{margin-top:6px}
.mishu-hint{font-size:12px;color:${FAINT};margin:6px 4px 0}
.mishu-banner{margin-top:10px;padding:8px 10px;border-radius:8px;border:1px solid ${WARN};color:${WARN};font-size:12px}
.mishu-error{margin-bottom:12px;padding:8px 10px;border-radius:8px;border:1px solid ${DANGER};color:${DANGER};font-size:12px}
.mishu-add{border:1px dashed ${LINE_STRONG};border-radius:8px;padding:8px;margin-top:4px}
.mishu-add-toggle{width:100%;text-align:left;border-style:dashed}
.mishu-field{display:flex;flex-direction:column;gap:2px;margin-bottom:6px;font-size:12px;color:${MUTED}}
.mishu-field input,.mishu-field select{font:inherit;font-size:13px;color:${TEXT};background:${LAYER2};border:1px solid ${LINE_STRONG};border-radius:6px;padding:4px 6px;width:100%}
.mishu-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.mishu-preview{white-space:pre-wrap;font-size:12px;background:${LAYER2};border-radius:6px;padding:6px 8px;margin:4px 0 6px;color:${TEXT}}
@media (max-width:820px){.mishu-columns{grid-template-columns:1fr;gap:12px}.mishu-divider{display:none}.mishu-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
