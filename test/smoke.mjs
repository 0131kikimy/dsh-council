// 用一个假 ctx 跑一遍 apply，验证：
//   · 不抛错；
//   · 6 个 council_* 工具注册上了，且 when() 只对根 Agent 放行；
//   · 协议提示词只装在根 Agent 的 scope 上；
//   · 成员策略（检验者禁写）真的走了 tools.restrict。
import assert from 'node:assert/strict';

const sections = new Map();
const restricted = [];
const registered = [];
const listeners = new Map();

const memberTools = {
  restrict: (filter) => {
    restricted.push(filter);
    return () => {};
  },
};

const makeMember = (id) => ({
  id,
  session: { header: { parentSession: 'root-1' } },
  ctx: {
    get: (name) => (name === 'tools' ? memberTools : undefined),
    tools: memberTools,
  },
});
const memberAgent = makeMember('child-1');
const verifierAgent = makeMember('child-2');

const leadAgent = {
  id: 'root-1',
  session: { header: {} },
  ctx: { systemPrompt: { section: (s) => { sections.set(s.name, s); return () => {}; } } },
};

const roster = [
  { id: 'root-1', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
];

const agentTeams = {
  listMembers: () => roster,
  spawnTeammate: async (caller, request) => {
    roster.push({
      id: request.name === 'executor' ? 'child-1' : 'child-2',
      name: request.name,
      role: 'teammate',
      status: 'inactive',
      diagnostics: [],
    });
    return { member: { name: request.name } };
  },
  sendMessage: async () => ({ messageId: 'm1' }),
};

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (name) => (name === 'agentTeams' ? agentTeams : undefined),
  agentTeams,
  agents: {
    list: () => [leadAgent],
    get: (id) => (id === 'child-1' ? memberAgent : (id === 'child-2' ? verifierAgent : undefined)),
  },
  tools: {
    register: (definition, options) => {
      registered.push({ definition, options });
      return () => {};
    },
    definitions: () => [
      { name: 'write' }, { name: 'edit' }, { name: 'read' },
      { name: 'send_message' }, { name: 'bash' },
    ],
  },
  on: (event, handler) => { listeners.set(event, handler); },
};

const { apply } = await import('../index.js');
apply(ctx, {});

assert.equal(registered.length, 6, `期望 6 个工具，实际 ${registered.length}`);
const names = registered.map((item) => item.definition.name).sort();
assert.deepEqual(names, ['council_finish', 'council_policy', 'council_send', 'council_start', 'council_status', 'council_verdict']);
for (const item of registered) {
  assert.equal(item.options.when({ agent: leadAgent }), true, `${item.definition.name} 应对 Lead 可见`);
  assert.equal(item.options.when({ agent: memberAgent }), false, `${item.definition.name} 不应对成员可见`);
}

assert.ok(sections.has('council:protocol'), '缺少 council:protocol 提示词');
const text = sections.get('council:protocol').text();
assert.ok(text.includes('executor') && text.includes('verifier'), text.slice(0, 200));

const pick = (name) => registered.find((i) => i.definition.name === name).definition;
const exec = (agent = leadAgent) => ({ agent, signal: new AbortController().signal });

// 开局
const started = await pick('council_start').execute(
  { task: '实现 X', criteria: ['a.js 存在 run()', 'npm test 通过'] },
  exec(),
);
assert.equal(started.ok, true, JSON.stringify(started));
assert.equal(started.round, 1);
assert.deepEqual(started.created.sort(), ['executor', 'verifier']);

// 默认给检验者禁写；未知工具（ops_write_file 不在 definitions 里）被丢弃
const verifierRule = restricted.find((f) => f.deny && f.deny.includes('write'));
assert.ok(verifierRule, '检验者未装禁写限制：' + JSON.stringify(restricted));

// 派活
const sent = await pick('council_send').execute({}, exec());
assert.equal(sent.ok, true, JSON.stringify(sent));
assert.equal(sent.to, 'executor');

// 送检
const toVerifier = await pick('council_send').execute({ to: 'verifier', report: '做完了' }, exec());
assert.equal(toVerifier.ok, true, JSON.stringify(toVerifier));
assert.equal(toVerifier.phase, 'verifying');

// FAIL 必须带 fixes
const noFix = await pick('council_verdict').execute({ verdict: 'FAIL' }, exec());
assert.equal(noFix.ok, false);

const failed = await pick('council_verdict').execute({ verdict: 'FAIL', fixes: ['补测试'] }, exec());
assert.equal(failed.ok, true, JSON.stringify(failed));
assert.equal(failed.phase, 'open');
assert.equal(failed.round, 2);

// 修订标准：记录进历史，新标准生效
const revised = await pick('council_verdict').execute(
  { verdict: 'FAIL', fixes: ['还是不行'], criteria: ['新标准'] },
  exec(),
);
assert.equal(revised.phase, 'escalated', JSON.stringify(revised));
assert.deepEqual(revised.criteria, ['新标准']);

// 看板
const view = await pick('council_status').execute({}, exec());
assert.equal(view.ok, true);
assert.deepEqual(view.verdicts.map((v) => v.verdict), ['FAIL', 'FAIL']);
assert.ok(view.policy.verifier, 'policy 里应有 verifier');

// 收尾
const finished = await pick('council_finish').execute({ summary: '交付了' }, exec());
assert.equal(finished.ok, true);
assert.equal(finished.phase, 'accepted');

// 非法配置应响亮失败
let threw = false;
try {
  apply(ctx, { executorName: 'A B', maxRounds: 99 });
} catch (error) {
  threw = true;
  assert.ok(String(error.message).includes('配置非法'), String(error.message));
}
assert.ok(threw, '非法配置应抛错');

console.log('SMOKE PASSED');
console.log('  tools:', names.join(', '));
console.log('  verifier deny:', verifierRule.deny.join(', '));
console.log('  rounds:', view.round, 'phase:', finished.phase);
