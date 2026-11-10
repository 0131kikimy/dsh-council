// 循环决议 · Council —— 插件入口
//
// 做三件事：
//   1. 给 Team Lead 注册 6 个 council_* 工具（执行者/检验者看不到）。
//   2. 给 Team Lead 追加一段协议提示词（什么时候开局、怎么循环、什么时候停）。
//   3. 给两位成员装默认工具限制（检验者禁写）。
//
// 生命周期约束（与 dsh-collect 一致）：
//   · apply 的返回值保持 undefined，不用 ctx.effect 的返回值当配置。
//   · 工具注册绑定在本插件 fiber 上，卸载时随作用域撤销。
//   · agentTeams 用 ctx.get 取：profile 没装 Agent Teams 时插件仍然加载（council_* 会如实报错）。

import { resolveConfig } from './lib/config.js';
import { installCouncilTools } from './lib/tools.js';
import { renderCriteria } from './lib/briefs.js';

/** 插件版本（与 package.json 同步）。 */
const VERSION = '0.1.0';

/** 协议提示词在 prompt 中的位置：紧跟在 Team 协作策略之后。 */
const PROTOCOL_ORDER = 650;

/** 依赖的宿主服务。 */
export const inject = ['agents', 'tools', 'systemPrompt'];

/**
 * 生成协议提示词。
 * @param {object} config - 生效配置。
 * @returns {string} 提示词正文。
 */
function protocolText(config) {
  return [
    '## 循环决议（Council）',
    '',
    `本会话里你有两位独立上下文的同伴：执行者 \`${config.executorName}\`（动手做）与检验者 \`${config.verifierName}\`（按标准判）。`,
    '它们各自独立对话，只能通过 send_message 往来；只有你能改标准、只有你能收权、只有你能向用户交付。',
    '',
    '什么时候用：用户要你**实际做完**一件可检验的活（改代码、写文档、查证一份材料）时。',
    '讨论、答疑、纯查询、一次就能答完的事，不要开局——那只会烧 token 而不提速。',
    '',
    '循环（每一步只做一件，别跳步）：',
    '1. `council_start(task, criteria, files?)` —— 先想清楚「做成什么样算好」，写成 3~6 条可判定的标准（要有路径/命令/证据），再建人。',
    `2. \`council_send(to="${config.executorName}")\` —— 派出。正文由插件拼装，不要重复粘贴任务。`,
    `3. 等执行者回报，然后 \`council_send(to="${config.verifierName}", report=回报原文)\` —— 送检。`,
    '4. 读检验结论，用 `council_verdict(verdict, fixes, criteria?)` 记账。',
    '',
    '判断力（这是你的核心职责，别一条路走到黑）：',
    '- 检验者反复针对标准而不是成果时，说明**标准错了**：用 council_verdict 的 `criteria` 修订，而不是逼执行者再改一遍。',
    '- 连续两轮同一条标准失败、或失败原因与任务目标无关，就停：把卡点和取舍交给用户，不要空转。',
    '- 执行者方向偏了就在 note 里纠正方向，别让它继续挖。',
    `- 执行者越界（乱删、跑危险命令）时用 \`council_policy(target="${config.executorName}", deny=[...])\` 收权，而不是喊话。`,
    `- 检验者默认不能用写类工具；需要它查看更多证据时，用 council_policy 放开只读工具即可。`,
    '',
    `轮次上限 ${config.maxRounds} 轮（council_verdict 到顶会转 escalated）。达标后：PASS → 你自己再抽查一遍 → \`council_finish\` → 回复用户。`,
    '省 token 的硬规矩：不要把你的对话复制给成员，让插件拼简报；成员回报只引用要点。',
  ].join('\n');
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - cordis.patch.yml 里这一行的 config。
 * @returns {void}
 */
export function apply(ctx, config) {
  const { config: active, issues } = resolveConfig(config);
  if (issues.length > 0) {
    throw new Error(`dsh-council 配置非法：${issues.join('；')}`);
  }
  if (!active.enabled) {
    ctx.logger?.info?.('dsh-council: enabled=false，跳过注册');
    return undefined;
  }

  const log = (message, level = 'info') => {
    const method = ctx.logger?.[level] ?? ctx.logger?.info;
    try {
      method?.(`dsh-council: ${message}`);
    } catch {
      // 日志失败不影响主流程。
    }
  };

  const teams = ctx.get('agentTeams');
  if (!teams) {
    log('未检测到 Agent Teams（dsh-experimental-agent-team）；council_* 会被调用时如实报错。请启用 Agent Teams 后重开会话。', 'warn');
  }

  // ── 工具 ──────────────────────────────────────────────────────────────────
  let installed;
  try {
    installed = installCouncilTools({
      ctx,
      getConfig: () => active,
      log,
    });
  } catch (error) {
    ctx.logger?.error?.(`dsh-council: 工具注册失败：${error?.stack ?? error}`);
    throw error;
  }

  // ── 协议提示词（只给 Lead） ───────────────────────────────────────────────
  const scoped = new Map();
  const buildLeadSection = (agent) => {
    try {
      const dispose = agent.ctx.systemPrompt.section({
        name: 'council:protocol',
        order: PROTOCOL_ORDER,
        text: () => protocolText(active),
      });
      scoped.set(agent, dispose);
    } catch (error) {
      log(`提示词注册失败：${error?.message ?? error}`, 'warn');
    }
  };

  const onCreated = ({ agent }) => {
    // 只有根 Agent（Team Lead）拿到协议；成员拿到的是各自的人设。
    if (agent.session?.header?.parentSession !== undefined) return;
    buildLeadSection(agent);
  };

  for (const agent of ctx.agents?.list?.() ?? []) {
    if (agent.session?.header?.parentSession === undefined) buildLeadSection(agent);
  }
  ctx.on('agent/created', onCreated);
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = scoped.get(agent);
    if (typeof dispose === 'function') {
      try { dispose(); } catch { /* 已随作用域撤销 */ }
    }
    scoped.delete(agent);
  });

  log(`启动完成（v${VERSION}，执行者 ${active.executorName}，检验者 ${active.verifierName}，上限 ${active.maxRounds} 轮，Team 服务${teams ? '可用' : '不可用'}）`);

  // 刻意不返回值。宿主卸载插件时会撤销本 fiber 上的注册。
  return undefined;
}

export { renderCriteria };
