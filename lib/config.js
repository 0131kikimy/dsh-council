// 循环决议 · Council —— 配置：默认值 + 校验
//
// 设计约束（与 dsh-collect 相同）：
//   · 不静态 import 任何 @deepseek-ai/* 模块：宿主在加载入口时这些包未必可见。
//     tools.register 的原始定义对象就够了，不需要 defineTool / schemastery。
//   · apply 第一句就校验配置；非法值**响亮失败**，不静默回落默认值。

/** 默认配置。 */
export const DEFAULTS = Object.freeze({
  /** 总开关：false 时插件只加载、不注册任何工具与提示词。 */
  enabled: true,

  /** 两个执行侧成员的固定名字（Team 内唯一、不可复用）。 */
  executorName: 'executor',
  verifierName: 'verifier',

  /** 成员创建方式：fresh（零上下文）或 fork（继承 Lead 已完成轮次）。 */
  context: 'fresh',
  /** spawn / fork 由宿主 provider 决定，一般不用改。 */
  freshProvider: 'spawn',
  forkProvider: 'fork',

  /** 最多几轮「派活 → 检验」。超过后 Leader 必须 accept 或 escalate。 */
  maxRounds: 2,

  /** 单条团队消息的字符上限（防止把整篇对话塞给对方、烧 token）。 */
  maxMessageChars: 4000,

  /** 检验者的默认权限：禁止改文件（它只判、不动手）。 */
  verifierDenyTools: Object.freeze([
    'write', 'edit', 'apply_patch',
    'ops_write_file', 'ops_edit_file', 'ops_replace', 'ops_remove', 'ops_move', 'ops_copy',
  ]),
  /** 执行者默认不额外限制。 */
  executorDenyTools: Object.freeze([]),

  /** 看板落盘（相对工作目录），便于 HMR / 重启后接着走。 */
  persist: true,
  boardFile: '.council/board.json',
});

/** 单个短字段的字符上限。 */
const MAX_FIELD = 200;

/** 取布尔值。 */
function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** 取有长度上限的字符串。 */
function strOf(value, fallback, maxLength = MAX_FIELD) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed.slice(0, maxLength);
}

/**
 * 取范围内的整数。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} min - 下界（含）。
 * @param {number} max - 上界（含）。
 * @param {string} path - 字段路径，用于错误信息。
 * @param {string[]} issues - 错误收集器。
 * @returns {number} 合法整数。
 */
function intIn(value, fallback, min, max, path, issues) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    issues.push(`${path} 必须是整数（当前：${String(value)}）`);
    return fallback;
  }
  if (number < min || number > max) {
    issues.push(`${path} 必须在 ${min}~${max} 之间（当前：${number}）`);
    return fallback;
  }
  return number;
}

/**
 * 取字符串数组（去空、去重、限长）。
 * @param {unknown} value - 原始值。
 * @param {readonly string[]} fallback - 默认值。
 * @param {string} path - 字段路径。
 * @param {string[]} issues - 错误收集器。
 * @returns {string[]} 合法数组。
 */
function stringListOf(value, fallback, path, issues) {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value)) {
    issues.push(`${path} 必须是字符串数组`);
    return [...fallback];
  }
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      issues.push(`${path} 只能包含字符串`);
      return [...fallback];
    }
    const trimmed = item.trim();
    if (trimmed !== '' && !out.includes(trimmed)) out.push(trimmed.slice(0, MAX_FIELD));
  }
  return out;
}

/**
 * 校验并补全配置。
 * @param {unknown} raw - cordis.patch.yml 里这一行的 config。
 * @returns {{config: object, issues: string[]}} 结果；issues 非空即为非法。
 */
export function resolveConfig(raw) {
  const issues = [];
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const executorName = strOf(input.executorName, DEFAULTS.executorName, 32);
  const verifierName = strOf(input.verifierName, DEFAULTS.verifierName, 32);
  if (executorName === verifierName) issues.push('executorName 与 verifierName 不能相同');
  for (const [key, name] of [['executorName', executorName], ['verifierName', verifierName]]) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) issues.push(`${key} 只能是 lower-kebab-case（当前：${name}）`);
  }

  const context = input.context === 'fork' ? 'fork' : 'fresh';
  if (input.context !== undefined && input.context !== 'fresh' && input.context !== 'fork') {
    issues.push('context 只能是 fresh 或 fork');
  }

  const boardFile = strOf(input.boardFile, DEFAULTS.boardFile, 200)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (boardFile.includes('..')) issues.push('boardFile 不能包含 ".."');

  const config = {
    enabled: boolOf(input.enabled, DEFAULTS.enabled),
    executorName,
    verifierName,
    context,
    freshProvider: strOf(input.freshProvider, DEFAULTS.freshProvider, 32),
    forkProvider: strOf(input.forkProvider, DEFAULTS.forkProvider, 32),
    maxRounds: intIn(input.maxRounds, DEFAULTS.maxRounds, 1, 8, 'maxRounds', issues),
    maxMessageChars: intIn(input.maxMessageChars, DEFAULTS.maxMessageChars, 400, 32000, 'maxMessageChars', issues),
    verifierDenyTools: stringListOf(input.verifierDenyTools, DEFAULTS.verifierDenyTools, 'verifierDenyTools', issues),
    executorDenyTools: stringListOf(input.executorDenyTools, DEFAULTS.executorDenyTools, 'executorDenyTools', issues),
    persist: boolOf(input.persist, DEFAULTS.persist),
    boardFile: boardFile === '' ? DEFAULTS.boardFile : boardFile,
  };

  return { config, issues };
}
