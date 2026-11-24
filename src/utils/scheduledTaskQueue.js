/**
 * 定时任务串行队列
 *
 * 背景：调度器每 10 秒检查一次，到达时间点就直接触发任务。若上一个任务
 * 还没跑完，新任务会并发启动，两个任务都会改写 selectedTokens，造成账号
 * 串台、连接冲突。这里把任务改为「排队执行」：到点的任务进入队列，前一个
 * 跑完再跑下一个，保证同一时刻只有一个定时任务在执行。
 */

export class ScheduledTaskQueue {
  /**
   * @param {Function} executor async (task) => result，实际执行单个任务的函数
   */
  constructor(executor) {
    this.executor = executor;
    this.queue = [];
    this.running = false;
    this.currentTask = null;
    /** @type {Array<Function>} 状态变化监听器 */
    this.listeners = [];
  }

  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.push(listener);
    // 返回取消监听函数
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  _notify(event, detail = {}) {
    // 复制一份再遍历：监听器可能在回调里取消订阅（splice），避免跳过其他监听器
    for (const listener of [...this.listeners]) {
      try {
        listener(event, detail);
      } catch {
        // 监听器异常不影响队列
      }
    }
  }

  get size() {
    return this.queue.length;
  }

  get busy() {
    return this.running;
  }

  /**
   * 把任务加入队列。同一 task.id 已在队列（含正在执行）时不重复入队，
   * 避免一个长任务被多次触发后堆积一堆相同任务。
   * @returns {{enqueued:boolean, reason?:string, position?:number}}
   */
  enqueue(task) {
    if (!task || task.id === undefined || task.id === null) {
      return { enqueued: false, reason: "任务缺少 id" };
    }
    if (this.currentTask && this.currentTask.id === task.id) {
      return { enqueued: false, reason: "任务正在执行中" };
    }
    if (this.queue.some((t) => t.id === task.id)) {
      return { enqueued: false, reason: "任务已在队列中等待" };
    }

    this.queue.push(task);
    this._notify("enqueued", { task, position: this.queue.length });
    // 用微任务触发，保证调用方能先拿到入队结果
    Promise.resolve().then(() => this._drain());
    return { enqueued: true, position: this.queue.length };
  }

  /** 依次执行队列中的任务，直到队列为空 */
  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        this.currentTask = task;
        this._notify("start", { task, remaining: this.queue.length });
        try {
          await this.executor(task);
          this._notify("completed", { task, remaining: this.queue.length });
        } catch (error) {
          this._notify("failed", { task, error, remaining: this.queue.length });
        } finally {
          this.currentTask = null;
        }
      }
    } finally {
      this.running = false;
      this._notify("idle", {});
    }
  }

  /**
   * 清空尚未开始的任务（正在执行的无法中断，由 shouldStop 机制停止）
   */
  clear() {
    const removed = this.queue.length;
    this.queue = [];
    if (removed > 0) this._notify("cleared", { removed });
    return removed;
  }

  /** 是否包含某个任务（队列中或正在执行） */
  has(taskId) {
    if (this.currentTask && this.currentTask.id === taskId) return true;
    return this.queue.some((t) => t.id === taskId);
  }
}
