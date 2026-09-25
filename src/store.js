// 仅追加事件存储：一批事件要么全部提交，要么全部不提交。
// 版本按聚合独立递增，event_id 全局唯一；事件一经提交不可原地改写。

export class EventStore {
  constructor() {
    this.events = [];
    this._sequence = new Map(); // aggregate_id -> 最新 version
    this._ids = new Set();
  }

  /**
   * 原子追加一整批事件。
   * @param {Array<object>} batch 已成形的事件信封
   * @returns {Array<object>} 提交后的事件（同一数组引用）
   */
  append(batch) {
    if (!Array.isArray(batch) || batch.length === 0) {
      throw new Error("事件批次不能为空");
    }

    // 第一阶段：纯校验，不改状态。
    const nextVersion = new Map(this._sequence);
    const ids = new Set(this._ids);
    for (const event of batch) {
      for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]) {
        if (!(field in event)) throw new Error(`事件缺少字段：${field}`);
      }
      if (ids.has(event.event_id)) throw new Error(`event_id 重复：${event.event_id}`);
      const expected = (nextVersion.get(event.aggregate_id) ?? 0) + 1;
      if (event.version !== expected) {
        throw new Error(
          `聚合 ${event.aggregate_id} 版本冲突：期望 ${expected}，实际 ${event.version}（${event.event_type}）`
        );
      }
      nextVersion.set(event.aggregate_id, expected);
      ids.add(event.event_id);
    }

    // 第二阶段：一次性提交。
    for (const event of batch) {
      this._sequence.set(event.aggregate_id, event.version);
      this._ids.add(event.event_id);
      this.events.push(Object.freeze(event));
    }
    return batch;
  }

  stream() {
    return this.events.slice();
  }

  versionOf(aggregateId) {
    return this._sequence.get(aggregateId) ?? 0;
  }
}

// 命令侧事件编号。
let counter = 0;
export function nextLocalId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}
export function resetEventCounter() {
  counter = 0;
}

// 在一批尚未提交的事件之间本地分配版本号：
// 同一聚合在批内连续产生多个事件时，版本依次递增而不是重复读取旧值。
export function eventBatch(store, now) {
  const pending = new Map(); // aggregate_id -> 已在批内占用到的版本
  const events = [];
  return {
    now,
    events,
    versionOf(aggregateId) {
      return pending.get(aggregateId) ?? store.versionOf(aggregateId);
    },
    add(eventType, aggregateType, aggregateId, payload, idPrefix) {
      const version = this.versionOf(aggregateId) + 1;
      pending.set(aggregateId, version);
      counter += 1;
      const event = {
        event_id: `${idPrefix ?? eventType.toLowerCase()}-${aggregateId}-${counter}`,
        event_type: eventType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        occurred_at: now,
        version,
        summary: payload.summary,
        ...payload,
      };
      events.push(event);
      return event;
    },
    commit() {
      return store.append(events);
    },
  };
}
