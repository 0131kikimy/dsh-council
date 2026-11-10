// 循环决议 · Council —— 团队内两位成员的简报模板
//
// 目标：每条消息都短、结构固定，便于对方一次读懂，避免把长对话复制给对方烧 token。

/** 单条消息裁剪（保留尾部更容易被截断出问题，所以头尾都留）。 */
export function clip(text, limit) {
  const value = String(text ?? '').trim();
  if (value.length <= limit) return value;
  const head = Math.max(1, Math.floor(limit * 0.75));
  const tail = Math.max(1, limit - head - 20);
  return `${value.slice(0, head)}\n…（已截断 ${value.length - head - tail} 字）…\n${value.slice(-tail)}`;
}

/**
 * 把验收标准渲染成编号列表。
 * @param {readonly string[]} criteria - 标准条目。
 * @returns {string} 多行文本。
 */
export function renderCriteria(criteria) {
  return criteria.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

/**
 * 派活简报。
 * @param {object} input - 轮次、任务、标准、写入范围。
 * @returns {string} 发给执行者的正文。
 */
export function dispatchBrief(input) {
  const { round, task, criteria, files } = input;
  const lines = [
    `【第 ${round} 轮 · 执行】`,
    task,
    '',
    '验收标准（检验者会逐条判定，没有证据的条目判 FAIL）：',
    renderCriteria(criteria),
  ];
  if (Array.isArray(files) && files.length > 0) {
    lines.push('', `写入范围（只改这些）：${files.join('、')}`);
  }
  lines.push(
    '',
    '做到以上各条即停手，不要扩大范围，也不要替检验者下结论。',
    '回报格式（≤15 行）：做了什么 / 改了哪些文件 / 怎么自查的 / 残余风险。',
  );
  return lines.join('\n');
}

/**
 * 检验简报。
 * @param {object} input - 轮次、任务、标准、执行者自述、写入范围。
 * @returns {string} 发给检验者的正文。
 */
export function verifyBrief(input) {
  const { round, task, criteria, report, files } = input;
  const lines = [
    `【第 ${round} 轮 · 检验】`,
    task,
    '',
    '验收标准：',
    renderCriteria(criteria),
    '',
    '执行者自述：',
    report.trim() === '' ? '（无自述，按标准自己去核对现场）' : report,
  ];
  if (Array.isArray(files) && files.length > 0) {
    lines.push('', `相关文件：${files.join('、')}`);
  }
  lines.push(
    '',
    '逐条判定，每行：标准编号 → PASS/FAIL → 证据（路径:行 或 命令输出）→ 必须修的问题（≤5 条，可执行）。',
    '没有证据的条目判 FAIL。只判定、不改文件、不重做任务。',
  );
  return lines.join('\n');
}

/**
 * 收权提示（给被限制的一方）。
 * @param {readonly string[]} denied - 被收回的工具名。
 * @returns {string} 提醒正文。
 */
export function deniedNotice(denied) {
  return [
    'Leader 收回了以下工具的使用权，遇到需要它们的步骤请在回报里说明，由 Leader 决定是否放开：',
    denied.map((name) => `· ${name}`).join('\n'),
  ].join('\n');
}
