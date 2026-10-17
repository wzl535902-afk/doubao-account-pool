export interface AccountTask {
  key: string;
  accountId: number;
}

export class AccountTaskScheduler<T extends AccountTask> {
  private readonly pending: T[] = [];
  private readonly activeKeys = new Set<string>();
  private readonly activeAccountIds = new Set<number>();
  /** 当前 key 仍在执行时提交的后续任务（例如换号重试），在该 key 释放后再入队。 */
  private readonly deferred = new Map<string, T>();
  private draining = false;

  constructor(
    private readonly getConcurrency: () => number,
    private readonly worker: (item: T) => Promise<void>,
    private readonly onWorkerError: (error: unknown) => void = () => undefined
  ) {}

  enqueue(item: T) {
    if (this.has(item.key)) {
      return false;
    }
    this.pending.push(item);
    this.drain();
    return true;
  }

  /**
   * 供执行中的 worker 为同一个 key 安排下一次执行（换号重试）。
   * enqueue 会因为 key 仍在 activeKeys 中而静默丢弃，导致请求永远卡在 accepted；
   * requeue 则在当前执行结束、key 释放后再入队，并排在队首，保证重试不被插队。
   */
  requeue(item: T) {
    if (this.activeKeys.has(item.key)) {
      this.deferred.set(item.key, item);
      return true;
    }
    const pendingIndex = this.pending.findIndex((queued) => queued.key === item.key);
    if (pendingIndex >= 0) {
      this.pending[pendingIndex] = item;
      return true;
    }
    this.pending.unshift(item);
    this.drain();
    return true;
  }

  /** key 是否在执行、排队或等待重入队。 */
  has(key: string) {
    return this.activeKeys.has(key)
      || this.deferred.has(key)
      || this.pending.some((queued) => queued.key === key);
  }

  isActive(key: string) {
    return this.activeKeys.has(key);
  }

  /** 从排队中移除尚未开始的任务；正在执行的任务不受影响。返回是否移除了排队项。 */
  remove(key: string) {
    let removed = this.deferred.delete(key);
    const pendingIndex = this.pending.findIndex((queued) => queued.key === key);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      removed = true;
    }
    return removed;
  }

  pendingKeys() {
    return [...this.pending.map((item) => item.key), ...this.deferred.keys()];
  }

  private drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const concurrency = Math.max(1, Math.trunc(this.getConcurrency()) || 1);
      while (this.activeKeys.size < concurrency) {
        const nextIndex = this.pending.findIndex(
          (item) => !this.activeAccountIds.has(item.accountId)
        );
        if (nextIndex < 0) break;

        const [item] = this.pending.splice(nextIndex, 1);
        this.activeKeys.add(item.key);
        this.activeAccountIds.add(item.accountId);

        void Promise.resolve()
          .then(() => this.worker(item))
          .catch((error) => this.onWorkerError(error))
          .finally(() => {
            this.activeKeys.delete(item.key);
            this.activeAccountIds.delete(item.accountId);
            const followUp = this.deferred.get(item.key);
            if (followUp) {
              this.deferred.delete(item.key);
              this.pending.unshift(followUp);
            }
            this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }
}
