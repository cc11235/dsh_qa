/**
 * Function-module inference for reports that contain no source path.
 *
 * A code path is more precise, but a user report usually describes the visible
 * feature instead ("检索里选择了业务…" / "grafana 跳转 localhost"). These rules
 * map common product vocabulary to a module label; the value remains editable
 * in the drawer, so a wrong guess is cheap to correct.
 */

const DEFAULT_RULES = [
  { label: '启动与部署', re: /(?:up\.sh|启动|部署|docker|compose|容器|端口|服务[^，。]{0,8}(?:没|未)[^，。]{0,8}(?:起|启动|运行)|没启动)/i },
  { label: '统计看板', re: /(?:业务明细|日志总量|统计|看板|图表|汇总|计数|数量|都是\s*0)/i },
  { label: '日志检索', re: /(?:日志检索|检索|搜索|查询|筛选|过滤|日志列表|日志中心)/i },
  { label: 'Grafana 集成', re: /grafana/i },
  { label: 'Prometheus 指标', re: /prometheus/i },
  { label: 'Loki 日志', re: /\bloki\b/i },
  { label: '认证与权限', re: /(?:登录|账号|密码|认证|权限|自动登录|用户名)/i },
  { label: 'Agent 管理', re: /(?:agent|业务列表)/i },
  { label: '告警', re: /(?:告警|alert)/i },
];

/** Return the first matching feature label for a block of text. */
export function featureFromText(text) {
  const body = String(text ?? '');
  for (const rule of DEFAULT_RULES) {
    if (rule.re.test(body)) return rule.label;
  }
  return '';
}