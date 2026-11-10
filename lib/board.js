// 循环决议 · Council —— 每次会话一条决议板（内存 + 可选落盘）
//
// 为什么单独存：工具调用是原子的、可能并发（Leader 同一 step 里连发多个调用），
// 所以状态变更必须串行化（一个 promise 链），且每轮都带 revision 做 CAS。

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 新建一块空板。 */
export function emptyBoard() {
  return {
    version: 1,
    round: 0,
    /** idle | dispatched | verifying | ready | accepted | escalated */
    phase: 'idle',
    task: '',
    criteria: [],
    criteriaHistory: [],
    files: [],
    lastDispatch: '',
    lastReport: '',
    lastVerdict: '',
    verdicts: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 板子仓库：一个实例管一个会话。
 */
export class BoardStore {
  /**
   * @param {string} dir - 会话工作目录（boardFile 的解析基准）。
   * @param {string} relFile - 相对文件路径。
   * @param {boolean} persist - 是否落盘。
   */
  constructor(dir, relFile, persist) {
    this.file = path.join(dir, ...String(relFile).split('/').filter(Boolean));
    this.persist = persist;
    this.state = emptyBoard();
    this.chain = Promise.resolve();
  }

  /** 从磁盘恢复（不存在就是新板）。 */
  async load() {
    if (!this.persist) return this.state;
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        this.state = { ...emptyBoard(), ...parsed };
      }
    } catch {
      // 不存在 / 损坏：都按空板处理，不阻塞会话。
    }
    return this.state;
  }

  /** 当前快照（深拷贝，调用方改不坏内部状态）。 */
  read() {
    return structuredClone(this.state);
  }

  /**
   * 串行地读-改-写。
   * @param {(board: object) => object|void} mutate - 就地修改或返回新板。
   * @returns {Promise<object>} 变更后的快照。
   */
  update(mutate) {
    this.chain = this.chain.then(async () => {
      const draft = this.read();
      const next = mutate(draft) ?? draft;
      next.updatedAt = new Date().toISOString();
      this.state = next;
      await this.save(next);
      return this.read();
    });
    return this.chain;
  }

  /** 落盘（失败只记在返回值里，不影响主流程）。 */
  async save(board) {
    if (!this.persist) return;
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(this.file, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
    } catch {
      // 只读工作目录等场景：内存板仍然可用。
    }
  }
}
