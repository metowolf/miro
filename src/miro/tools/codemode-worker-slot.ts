/**
 * 同一时刻只让一个 codemode worker 存活。
 *
 * 结果 settle 与 `close()` 都不代表 worker 已退出：Bun 上不可中断的内置函数
 * （例如大字符串上的 `indexOf`）会继续算到返回，pi-codemode 因此把「已请求停止」
 * 和「真的退出」拆成两件事，并给出 `onWorkerStarted(exited)`。连续执行（含子 agent
 * 自己的 codemode）如果不在 worker 真正退出前占着槽位，就会有两个 QuickJS 堆同时
 * 存活，64 MiB 的堆上限只约束单个 VM，加起来就没边了。
 *
 * 等待有上限：worker 卡死时宁可让两代短暂并存，也不能把后续执行永久挂起。
 */
export const CODEMODE_WORKER_EXIT_WAIT_MS = 30_000;

export interface CodemodeWorkerSlot {
  /** 归还槽位；重复调用无效。 */
  release(): void;
  /** 等满上限时上一个 worker 仍未退出：本次执行与它短暂并存。 */
  readonly timedOut: boolean;
}

export interface CodemodeWorkerGate {
  /**
   * 等到上一个 worker 退出（最多 `timeoutMs`）再放行，返回本次占用的槽位。
   * 等待期间 `signal` 触发则拒绝；排队位置仍按上一代退出后归还，不提前放行更晚的执行。
   */
  acquire(options?: { signal?: AbortSignal | null; timeoutMs?: number }): Promise<CodemodeWorkerSlot>;
  /** 是否还有 worker 占着槽位；诊断与测试用。 */
  readonly live: boolean;
  /** 正在等上一个 worker 退出的执行数；诊断与测试用。 */
  readonly waiting: number;
}

export function createWorkerGate(defaultTimeoutMs = CODEMODE_WORKER_EXIT_WAIT_MS): CodemodeWorkerGate {
  /** 当前占用者的退出承诺；没有 worker 时为 null。 */
  let live: Promise<void> | null = null;
  /** 尚未归还的槽位数；诊断与测试用，也是 `live` 的准确来源。 */
  let held = 0;
  let waiting = 0;
  return {
    async acquire({ signal = null, timeoutMs = defaultTimeoutMs }: { signal?: AbortSignal | null; timeoutMs?: number } = {}) {
      // 已经取消的调用不占位，也不该把后面排队的执行推后。
      signal?.throwIfAborted?.();
      const previous = live;
      let resolveExit!: () => void;
      const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
      // 先占位再等上一代：后来的执行排在本代之后，先来先得。
      live = exited;
      held += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        held -= 1;
        if (live === exited) live = null;
        resolveExit();
      };
      if (!previous) return { release, timedOut: false };
      waiting += 1;
      try {
        return { release, timedOut: await waitForExit(previous, timeoutMs, signal) };
      } catch (error) {
        // 等待期间被取消：位置仍然算在本代之后，不能提前把后面的执行放上去。
        void previous.then(release, release);
        throw error;
      } finally {
        waiting -= 1;
      }
    },
    get live() {
      return held > 0;
    },
    get waiting() {
      return waiting;
    },
  };
}

/** 等待上一代退出；返回 true 表示等满上限先放行。 */
function waitForExit(previous: Promise<void>, timeoutMs: number, signal: AbortSignal | null): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      stop();
      reject(signal?.reason ?? new Error("Codemode execution was cancelled while waiting for the previous worker to exit"));
    };
    timer = setTimeout(() => {
      if (settled) return;
      stop();
      resolve(true);
    }, Math.max(0, timeoutMs));
    timer.unref?.();
    void previous.then(() => {
      if (settled) return;
      stop();
      resolve(false);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
