/**
 * 脚本按宿主收到调用的顺序排队：连续读取最多并行八条，MCP 调用是串行屏障。
 * 队列中的任务也属于在途调用，关闭时必须收拢，不能在外层回合结束后继续运行。
 */
export function createCodemodeScheduler(maxParallel = 8) {
  const queue: Array<{ parallel: boolean; action: () => Promise<any>; resolve: (value: any) => void; reject: (reason: any) => void; signal: AbortSignal }> = [];
  const tasks = new Set<Promise<any>>();
  let active = 0;
  let exclusive = false;
  let closed = false;
  const pump = () => {
    if (exclusive) return;
    while (queue.length) {
      const next = queue[0];
      if (next.signal.aborted || closed) {
        queue.shift();
        next.reject(next.signal.reason ?? new Error("Codemode execution finished before this call ran"));
        continue;
      }
      if ((!next.parallel && active > 0) || active >= maxParallel) return;
      queue.shift();
      active += 1;
      exclusive = !next.parallel;
      Promise.resolve().then(() => {
        next.signal.throwIfAborted();
        return next.action();
      }).then(next.resolve, next.reject).finally(() => {
        active -= 1;
        if (!next.parallel) exclusive = false;
        pump();
      });
      if (exclusive) return;
    }
  };
  return {
    schedule(parallel: boolean, signal: AbortSignal, action: () => Promise<any>) {
      if (closed) return Promise.reject(new Error("Codemode execution has finished"));
      const task = new Promise<any>((resolve, reject) => {
        queue.push({ parallel, signal, action, resolve, reject });
        pump();
      });
      tasks.add(task);
      void task.then(() => tasks.delete(task), () => tasks.delete(task));
      return task;
    },
    async close() {
      closed = true;
      // 即使独占调用仍在收尾，也先拒绝所有尚未运行的调用。
      for (const task of queue.splice(0)) task.reject(new Error("Codemode execution finished before this call ran"));
      await Promise.allSettled([...tasks]);
    },
  };
}
