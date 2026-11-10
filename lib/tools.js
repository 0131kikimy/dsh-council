// 循环决议 · Council —— 模型侧工具：把「Leader 派活 → 执行者做 → 检验者判 → Leader 定」
// 的循环做成可执行的机械动作，而不是只靠提示词自觉。
//
// 关键设计：
//   · 工具全局注册，但带 `when`：只有「根 Agent（Team Lead）」在它的 step 里看得到。
//     两位成员看不到这些工具，因此不可能自己改标准、自己宣布通过。
//   · 每个 Lead 会话一块独立决议板（工作目录各自不同），互相不串。
//   · 结果一律无损 JSON，render 出紧凑文本——省 token。

import { clip, deniedNotice, dispatchBrief, renderCriteria, verifyBrief } from './briefs.js';
import { BoardStore } from './board.js';

/** 文本块。 */
const textBlock = (text) => [{ type: 'text', text }];

/** 安全取字符串。 */
function str(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

/** 安全取字符串数组。 */
function strList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const text = str(item);
    if (text !== '' && !out.includes(text)) out.push(text);
  }
  return out;
}

/** 成员状态中文标签。 */
function statusLabel(status) {
  switch (status) {
    case 'running': return '运行中';
    case 'inactive': return '空闲';
    case 'provisioning': return '创建中';
    case 'failed': return '创建失败';
    default: return String(status ?? '未知');
  }
}

/**
 * 每个 Lead 会话的控制器（含决议板与成员策略）。
 */
class Sessions {
  /**
   * @param {object} options - 依赖。
   * @param {object} options.ctx - 插件上下文。
   * @param {() => object} options.getConfig - 生效配置。
   * @param {(message: string, level?: string) => void} options.log - 日志。
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.getConfig = options.getConfig;
    this.log = options.log;
    /** @type {Map<string, object>} */
    this.map = new Map();
  }

  /**
   * 取（或建立）一个 Lead 会话的控制器。
   * @param {object} agent - Lead Agent。
   * @returns {object} 控制器。
   */
  for(agent) {
    const key = String(agent.id);
    let entry = this.map.get(key);
    if (entry) return entry;
    const config = this.getConfig();
    let workspace = process.cwd();
    try {
      workspace = this.ctx.workingDirectory?.get?.(agent.session) ?? agent.session?.header?.cwd ?? workspace;
    } catch {
      // 取不到就用进程目录，板子仍是内存可用的。
    }
    const store = new BoardStore(workspace, config.boardFile, config.persist);
    entry = {
      workspace,
      store,
      policy: {},
      disposers: new Map(),
      /** 每个成员的策略 disposer。 */
      loaded: false,
    };
    this.map.set(key, entry);
    return entry;
  }

  /** 惰性恢复磁盘板。 */
  async ensure(agent) {
    const entry = this.for(agent);
    if (!entry.loaded) {
      await entry.store.load();
      entry.loaded = true;
    }
    return entry;
  }

  /** 清理一个会话。 */
  drop(agent) {
    const entry = this.map.get(String(agent.id));
    if (!entry) return;
    for (const dispose of entry.disposers.values()) {
      try { dispose(); } catch { /* 已失效 */ }
    }
    this.map.delete(String(agent.id));
  }
}

/**
 * 安装 Council 工具。
 * @param {object} options - 依赖。
 * @returns {{dispose: () => void}}
 */
export function installCouncilTools(options) {
  const { ctx, getConfig, log } = options;
  const teamsService = () => ctx.get('agentTeams') ?? ctx.agentTeams;
  const sessions = new Sessions({ ctx, getConfig, log });

  /** 是否 Team Lead（根 Agent，无人之上）。 */
  const isLead = (agent) => Boolean(agent) && agent.session?.header?.parentSession === undefined;

  /** 列出团队成员。 */
  const membersOf = (agent) => {
    const teams = teamsService();
    if (!teams?.listMembers) return [];
    try {
      return teams.listMembers(agent);
    } catch {
      return [];
    }
  };

  /** 按名字找 live agent。 */
  const liveAgent = (agent, name) => {
    const row = membersOf(agent).find((item) => item.name === name);
    if (!row) return undefined;
    return ctx.agents?.get?.(row.id);
  };

  /**
   * 给某成员装工具限制。
   * @param {object} lead - Lead Agent。
   * @param {string} name - 成员名。
   * @param {{allow?: string[], deny?: string[]}} filter - 限制。
   * @returns {{applied: string[], dropped: string[], live: boolean, error?: string}}
   */
  const applyPolicy = (lead, name, filter) => {
    const entry = sessions.for(lead);
    const allow = filter.allow && filter.allow.length > 0 ? filter.allow : [];
    const deny = filter.deny && filter.deny.length > 0 ? filter.deny : [];
    entry.policy[name] = { allow, deny };
    const live = liveAgent(lead, name);
    const result = { applied: [], dropped: [], live: Boolean(live) };
    if (!live) return result;

    const tools = live.ctx?.get?.('tools');
    if (!tools?.restrict) return { ...result, error: '该成员上下文中没有 tools 服务' };

    const known = new Set((ctx.tools?.definitions?.() ?? []).map((item) => item.name));
    const keep = (list) => list.filter((item) => known.has(item));
    const safeAllow = allow.length > 0 ? keep(allow) : [];
    const safeDeny = deny.length > 0 ? keep(deny) : [];
    result.dropped = [...allow, ...deny].filter((item) => !known.has(item));
    if (safeAllow.length === 0 && safeDeny.length === 0) return result;

    const previous = entry.disposers.get(name);
    if (typeof previous === 'function') {
      try { previous(); } catch { /* 旧限制已失效 */ }
    }
    try {
      const dispose = tools.restrict({
        ...(safeAllow.length > 0 ? { allow: safeAllow } : {}),
        ...(safeDeny.length > 0 ? { deny: safeDeny } : {}),
      });
      entry.disposers.set(name, dispose);
      result.applied = [...safeAllow, ...safeDeny];
    } catch (error) {
      return { ...result, error: String(error?.message ?? error) };
    }

    if (result.applied.length > 0) {
      try {
        void teamsService()?.sendMessage?.(lead, {
          target: name,
          content: [{ type: 'text', text: deniedNotice(result.applied) }],
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // 发不出去不影响限制本身。
      }
    }
    return result;
  };

  /** 确保两位成员存在。 */
  const ensureMembers = async (lead) => {
    const config = getConfig();
    const teams = teamsService();
    if (!teams?.spawnTeammate) {
      throw new Error('这个 profile 没装 Agent Teams（dsh-experimental-agent-team），无法创建执行者与检验者。请在插件里启用 Agent Teams 后重开一个会话。');
    }
    const entry = sessions.for(lead);
    const have = new Set(membersOf(lead).map((item) => item.name));
    const created = [];

    const spawn = async (name, description, persona) => {
      if (have.has(name)) return;
      const result = await teams.spawnTeammate(lead, {
        name,
        description,
        prompt: [{ type: 'text', text: persona }],
        context: config.context,
        provider: config.context === 'fork' ? config.forkProvider : config.freshProvider,
        signal: AbortSignal.timeout(120000),
      });
      created.push(result?.member?.name ?? name);
      have.add(name);
    };

    await spawn(config.executorName, '按验收标准执行任务', [
      `你是「执行者」（${config.executorName}），只负责把交代的任务做出来。`,
      '规则：只做简报里的事，不扩大范围；每条验收标准都要有可核对的证据（文件路径、命令输出）；',
      '做完立刻停手并回报；不判定自己是否通过，也不修改验收标准。',
      '需要额外工具时在回报里写明，由 Leader 决定。',
    ].join('\n'));

    await spawn(config.verifierName, '按标准逐条检验并给出修复意见', [
      `你是「检验者」（${config.verifierName}），只负责判定，不动手改。`,
      '规则：逐条核对验收标准，没有证据的条目判 FAIL；给出可执行的修复意见（≤5 条）；',
      '不改文件、不重做任务、不替执行者解释；标准本身不合理时明确指出并说明理由。',
    ].join('\n'));

    if (config.verifierDenyTools.length > 0 && !entry.policy[config.verifierName]?.deny?.length) {
      applyPolicy(lead, config.verifierName, { deny: [...config.verifierDenyTools] });
    }
    if (config.executorDenyTools.length > 0 && !entry.policy[config.executorName]?.deny?.length) {
      applyPolicy(lead, config.executorName, { deny: [...config.executorDenyTools] });
    }
    return created;
  };

  /** 发一条消息给成员。 */
  const sendText = async (lead, target, text) => {
    const teams = teamsService();
    if (!teams?.sendMessage) throw new Error('Agent Teams 服务不可用，无法给成员发消息。');
    await teams.sendMessage(lead, {
      target,
      content: [{ type: 'text', text: clip(text, getConfig().maxMessageChars) }],
      signal: AbortSignal.timeout(30000),
    });
  };

  /** 注册一个工具（仅 Lead 可见）。 */
  const tools = [];
  const register = (definition) => {
    tools.push(ctx.tools.register(definition, { when: (context) => isLead(context.agent) }));
  };

  // ── 1. 开局 ───────────────────────────────────────────────────────────────
  register({
    name: 'council_start',
    description: [
      '开启一次「Leader → 执行者 → 检验者」循环决议：登记任务与可判定的验收标准，并按需创建两位成员。',
      '只在用户要你实际动手完成一件需要检验的活时用；讨论、答疑、纯查询不要用。',
      '验收标准要能被第三方逐条判定（有证据/路径/命令），否则检验者只能判 FAIL。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: '要做成什么（一句话，含边界）。' },
        criteria: { type: 'array', items: { type: 'string' }, description: '可判定的验收标准，3~6 条为宜。' },
        files: { type: 'array', items: { type: 'string' }, description: '可选：预计改动的文件/目录（相对工作目录）。' },
      },
      required: ['task', 'criteria'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          round: { type: 'number' },
          phase: { type: 'string' },
          created: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'object', additionalProperties: true } },
          criteria: { type: 'array', items: { type: 'string' } },
          next: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock(`council_start 失败：${value?.error ?? '未知原因'}`);
        return textBlock([
          `已开局：第 ${value.round} 轮，${value.criteria.length} 条标准。`,
          value.created.length > 0 ? `新成员：${value.created.join('、')}` : '成员已就位。',
          value.members.map((item) => `· ${item.target}（${item.status}）`).join('\n'),
          '',
          `下一步：${value.next}`,
        ].filter((line) => line !== '').join('\n'));
      },
    },
    async execute(args, exec) {
      const lead = exec.agent;
      const task = str(args?.task).slice(0, 2000);
      const criteria = strList(args?.criteria).map((item) => item.slice(0, 400));
      const files = strList(args?.files).map((item) => item.slice(0, 300));
      if (task === '') return { ok: false, error: 'task 不能为空' };
      if (criteria.length === 0) return { ok: false, error: 'criteria 至少要有一条可判定的标准' };
      const entry = await sessions.ensure(lead);
      const created = await ensureMembers(lead);
      const config = getConfig();
      const board = await entry.store.update((draft) => {
        draft.round = 1;
        draft.phase = 'open';
        draft.task = task;
        draft.criteria = criteria;
        draft.criteriaHistory = [];
        draft.files = files;
        draft.lastDispatch = '';
        draft.lastReport = '';
        draft.lastVerdict = '';
        draft.verdicts = [];
        return draft;
      });
      return {
        ok: true,
        round: board.round,
        phase: board.phase,
        created,
        members: membersOf(lead).map((item) => ({ target: item.name, role: item.role, status: statusLabel(item.status) })),
        criteria: board.criteria,
        next: `调用 council_send(to="${config.executorName}") 把这一轮派给执行者。`,
      };
    },
  });

  // ── 2. 派活 / 送检 ────────────────────────────────────────────────────────
  register({
    name: 'council_send',
    description: [
      '把当前一轮派给某位成员：to=执行者发派活简报（任务+标准+写入范围），to=检验者发检验简报（含执行者回报）。',
      '正文由插件按决议板拼装，你只补一句可选 note，不要重复粘贴任务全文，以省 token。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        to: { type: 'string', description: '成员名（默认执行者）。' },
        note: { type: 'string', description: '可选：补充一句上下文/重点，≤500 字。' },
        report: { type: 'string', description: 'to=检验者时：执行者回报原文（不填则用最近一次记录）。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          sent: { type: 'boolean' },
          to: { type: 'string' },
          round: { type: 'number' },
          phase: { type: 'string' },
          next: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock(`council_send 失败：${value?.error ?? '未知原因'}`);
        return textBlock([`已发给 ${value.to}（第 ${value.round} 轮）。`, `下一步：${value.next}`].join('\n'));
      },
    },
    async execute(args, exec) {
      const lead = exec.agent;
      const config = getConfig();
      const entry = await sessions.ensure(lead);
      const board = entry.store.read();
      if (board.round === 0) return { ok: false, error: '还没有开局，先调用 council_start' };
      const asked = str(args?.to);
      const target = asked === '' ? config.executorName
        : (asked === config.verifierName || asked === config.executorName) ? asked
          : '';
      if (target === '') return { ok: false, error: `to 只能是 ${config.executorName} 或 ${config.verifierName}` };
      const note = str(args?.note).slice(0, 500);
      if (!membersOf(lead).some((item) => item.name === target)) {
        return { ok: false, error: `没有名为 ${target} 的成员；先调用 council_start 建人。` };
      }

      const isVerifier = target === config.verifierName;
      const report = str(args?.report) || board.lastReport;
      const body = isVerifier
        ? verifyBrief({ round: board.round, task: board.task, criteria: board.criteria, report, files: board.files })
        : dispatchBrief({ round: board.round, task: board.task, criteria: board.criteria, files: board.files });
      const text = note === '' ? body : `${body}\n\nLeader 补充：${note}`;

      try {
        await sendText(lead, target, text);
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) };
      }

      const phase = isVerifier ? 'verifying' : 'dispatched';
      await entry.store.update((draft) => {
        draft.phase = phase;
        draft.lastDispatch = clip(text, 1500);
        return draft;
      });
      return {
        ok: true,
        sent: true,
        to: target,
        round: board.round,
        phase,
        next: isVerifier
          ? '读到检验结论后调用 council_verdict 记录：PASS 则终检并回复用户；FAIL 会自动开下一轮。'
          : '等执行者回报，然后用 council_send(to=检验者, report=回报原文) 送检。',
      };
    },
  });

  // ── 3. 记录裁决（含修订标准） ─────────────────────────────────────────────
  register({
    name: 'council_verdict',
    description: [
      '记录检验结论并推进循环。PASS 进入终检；FAIL 自动开下一轮（到 maxRounds 上限会锁成 escalated，必须由你决断并告知用户）。',
      'criteria 可选：修订验收标准时传新的完整列表——标准是你的权力，但每次修订都记入历史。',
      'fixes 填检验者给的必须修问题（≤5 条），下一轮会带给执行者。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['PASS', 'FAIL'], description: '检验结论。' },
        fixes: { type: 'array', items: { type: 'string' }, description: '必须修的问题（FAIL 时必填）。' },
        criteria: { type: 'array', items: { type: 'string' }, description: '可选：修订后的完整验收标准列表。' },
        report: { type: 'string', description: '可选：检验者原文（≤2000 字，供下一轮引用）。' },
      },
      required: ['verdict'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          verdict: { type: 'string' },
          round: { type: 'number' },
          phase: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          next: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock(`council_verdict 失败：${value?.error ?? '未知原因'}`);
        return textBlock([
          `第 ${value.round} 轮裁决：${value.verdict}（阶段 ${value.phase}）。`,
          value.criteria.length > 0 ? `当前标准：\n${renderCriteria(value.criteria)}` : '',
          `下一步：${value.next}`,
        ].filter((line) => line !== '').join('\n'));
      },
    },
    async execute(args, exec) {
      const lead = exec.agent;
      const config = getConfig();
      const entry = await sessions.ensure(lead);
      const board = entry.store.read();
      if (board.round === 0) return { ok: false, error: '还没有开局，先调用 council_start' };
      const verdict = str(args?.verdict).toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
      const fixes = strList(args?.fixes).slice(0, 5).map((item) => item.slice(0, 400));
      const nextCriteria = strList(args?.criteria).map((item) => item.slice(0, 400));
      const report = str(args?.report).slice(0, 2000);
      if (verdict === 'FAIL' && fixes.length === 0) {
        return { ok: false, error: 'FAIL 必须给出至少一条可执行的 fixes，否则执行者无从下手。' };
      }

      const updated = await entry.store.update((draft) => {
        if (nextCriteria.length > 0) {
          draft.criteriaHistory.push({ round: draft.round, criteria: draft.criteria, at: new Date().toISOString() });
          draft.criteria = nextCriteria;
        }
        if (report !== '') draft.lastVerdict = report;
        draft.verdicts.push({ round: draft.round, verdict, fixes });
        if (verdict === 'PASS') {
          draft.phase = 'ready';
        } else if (draft.round >= config.maxRounds) {
          draft.phase = 'escalated';
        } else {
          const failed = draft.round;
          draft.round += 1;
          draft.phase = 'open';
          draft.lastReport = '';
          if (fixes.length > 0) {
            draft.task = `${draft.task}\n\n第 ${failed} 轮必须修：\n${fixes.map((item) => `· ${item}`).join('\n')}`;
          }
        }
        return draft;
      });

      const next = updated.phase === 'ready'
        ? '标准已达标：自己做最后一遍检查（逐条对照标准、抽查文件），然后回复用户。'
        : updated.phase === 'escalated'
          ? `已到 ${config.maxRounds} 轮上限仍未达标。不要再来一轮：把现状、卡点和你建议的取舍告诉用户，由用户定。`
          : `下一轮已开：调用 council_send(to="${config.executorName}")。`;
      return {
        ok: true,
        verdict,
        round: updated.round,
        phase: updated.phase,
        criteria: updated.criteria,
        next,
      };
    },
  });

  // ── 4. 收权 / 放权 ────────────────────────────────────────────────────────
  register({
    name: 'council_policy',
    description: [
      '限制某位成员的权力：deny 收回列出的工具，allow 只保留列出的工具（可同时给）。',
      '检验者默认已禁写；执行者若越界（乱删、跑危险命令）就用它收权，而不是靠喊话。',
      '未知工具名会被丢弃并在 dropped 里回报；传空数组表示不限制。',
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: '成员名（执行者或检验者）。' },
        deny: { type: 'array', items: { type: 'string' }, description: '要收回的工具名。' },
        allow: { type: 'array', items: { type: 'string' }, description: '只保留这些工具（白名单）。' },
      },
      required: ['target'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          applied: { type: 'array', items: { type: 'string' } },
          dropped: { type: 'array', items: { type: 'string' } },
          live: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock(`council_policy 失败：${value?.error ?? '未知原因'}`);
        const lines = [`已对 ${value.target} 生效：${value.applied.length > 0 ? value.applied.join('、') : '无（已清空限制）'}`];
        if (value.dropped.length > 0) lines.push(`忽略的未知工具：${value.dropped.join('、')}`);
        if (!value.live) lines.push('该成员当前未运行，限制会在它被唤醒时生效。');
        return textBlock(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const lead = exec.agent;
      const config = getConfig();
      const target = str(args?.target);
      if (target !== config.executorName && target !== config.verifierName) {
        return { ok: false, error: `target 只能是 ${config.executorName} 或 ${config.verifierName}` };
      }
      await sessions.ensure(lead);
      const result = applyPolicy(lead, target, { allow: strList(args?.allow), deny: strList(args?.deny) });
      if (result.error) return { ok: false, error: result.error };
      return { ok: true, target, applied: result.applied, dropped: result.dropped, live: result.live };
    },
  });

  // ── 5. 看板 ───────────────────────────────────────────────────────────────
  register({
    name: 'council_status',
    description: '读当前决议板：轮次、阶段、任务、标准、最近裁决、成员状态与生效的工具限制。开局前也可用来确认环境。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          round: { type: 'number' },
          phase: { type: 'string' },
          task: { type: 'string' },
          criteria: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'object', additionalProperties: true } },
          policy: { type: 'object', additionalProperties: true },
          verdicts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock('council_status 失败。');
        return textBlock([
          `阶段：${value.phase}　轮次：${value.round}`,
          value.task ? `任务：${clip(value.task, 600)}` : '',
          value.criteria.length > 0 ? `标准：\n${renderCriteria(value.criteria)}` : '',
          value.members.length > 0
            ? `成员：\n${value.members.map((item) => `· ${item.target}（${item.status}）`).join('\n')}`
            : '成员：尚未创建',
          Object.keys(value.policy).length > 0
            ? `限制：\n${Object.entries(value.policy).map(([name, rule]) => `· ${name}：deny=${rule.deny.join(',') || '-'} allow=${rule.allow.join(',') || '-'}`).join('\n')}`
            : '',
          value.verdicts.length > 0 ? `裁决：${value.verdicts.map((item) => `第${item.round}轮 ${item.verdict}`).join('，')}` : '',
          value.note,
        ].filter((line) => line !== '').join('\n'));
      },
    },
    async execute(_args, exec) {
      const lead = exec.agent;
      const entry = await sessions.ensure(lead);
      const board = entry.store.read();
      return {
        ok: true,
        round: board.round,
        phase: board.phase,
        task: board.task,
        criteria: board.criteria,
        members: membersOf(lead).map((item) => ({ target: item.name, role: item.role, status: statusLabel(item.status) })),
        policy: entry.policy,
        verdicts: board.verdicts,
        note: board.phase === 'idle' ? '尚未开局：先 council_start。' : '',
      };
    },
  });

  // ── 6. 收尾 ───────────────────────────────────────────────────────────────
  register({
    name: 'council_finish',
    description: '把这次决议标记为完成（PASS 终检后调用），可附一句交付摘要。只记账，不代替你回复用户。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: '可选：交付摘要（≤500 字）。' },
        accepted: { type: 'boolean', description: '是否接受当前结果（默认 true）。' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          phase: { type: 'string' },
          round: { type: 'number' },
          summary: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (!value?.ok) return textBlock(`council_finish 失败：${value?.error ?? '未知原因'}`);
        return textBlock(`决议已收尾：${value.phase}（共 ${value.round} 轮）。请把结果和风险如实回复用户。`);
      },
    },
    async execute(args, exec) {
      const lead = exec.agent;
      const entry = await sessions.ensure(lead);
      const board = entry.store.read();
      if (board.round === 0) return { ok: false, error: '还没有开局，无需收尾。' };
      const summary = str(args?.summary).slice(0, 1000);
      const accepted = args?.accepted !== false;
      const updated = await entry.store.update((draft) => {
        draft.phase = accepted ? 'accepted' : 'escalated';
        draft.summary = summary;
        return draft;
      });
      return { ok: true, phase: updated.phase, round: updated.round, summary };
    },
  });

  const dispose = () => {
    for (const item of tools.reverse()) item();
    tools.length = 0;
  };

  // 成员被唤醒时重装策略（新 agent 实例上没有旧限制）。
  const onCreated = ({ agent }) => {
    const parentId = agent.session?.header?.parentSession;
    if (parentId === undefined) return;
    for (const [leadId, entry] of sessions.map) {
      const lead = ctx.agents?.get?.(leadId);
      if (!lead) continue;
      const row = membersOf(lead).find((item) => item.id === agent.id);
      if (!row) continue;
      const rule = entry.policy[row.name];
      if (!rule) continue;
      if ((rule.allow?.length ?? 0) === 0 && (rule.deny?.length ?? 0) === 0) continue;
      applyPolicy(lead, row.name, rule);
      return;
    }
  };

  ctx.on('agent/created', onCreated);
  ctx.on('agent/disposed', ({ agent }) => {
    sessions.drop(agent);
  });

  return {
    dispose: () => {
      dispose();
    },
  };
}
