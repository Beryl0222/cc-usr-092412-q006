// 事件溯源投影：把追加的领域事件折叠成当前状态。
// 组件批次、装配版本、渠道额度、标签快照、合作方责任各自独立成账，
// 状态只由事件推导，任何更正都通过后继事件完成，不原地改写。

export function labelKey(label_id, version) {
  return `${label_id}@${version}`;
}

export function assemblyKey(assembly_id, version) {
  return `${assembly_id}@${version}`;
}

export function initialState() {
  return {
    lots: {}, // 组件批次台账：lot_id -> 批次
    labels: {}, // 标签快照：label_id@version -> 不可变快照
    assemblies: {}, // 装配版本：assembly_id@version -> 配方
    quotas: {}, // 渠道额度台账：channel_id -> 额度
    commitments: {}, // 组合承诺：commitment_id -> 承诺
    boxes: {}, // 已装配礼盒事实：box_id -> 实物记录
    plans: {}, // 重组方案：plan_id -> 方案
    receipts: {}, // 回执与清算：business_id -> 合并记录
    liabilities: [], // 合作方责任留痕（按发生顺序）
  };
}

export function applyEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    // ---- 组件批次台账 ----
    case "COMPONENT_ACCEPTED":
      state.lots[p.lot_id] = {
        lot_id: p.lot_id,
        partner_id: p.partner_id,
        kind: p.kind,
        name: p.name,
        total: p.quantity,
        reserved: 0,
        consumed: 0,
        available: p.quantity,
        allergens: [...(p.allergens ?? [])],
        inspection: { status: "accepted" },
        depleted: false,
        remaining_cap: null,
      };
      break;
    case "COMPONENT_INSPECTION_RECORDED": {
      const lot = state.lots[p.lot_id];
      lot.inspection = { status: p.status, note: p.note ?? "", inspector: p.inspector ?? "" };
      if (p.allergens) lot.allergens = [...p.allergens];
      break;
    }
    case "COMPONENT_SHORTAGE_DECLARED": {
      const lot = state.lots[p.lot_id];
      lot.depleted = true;
      lot.remaining_cap = p.remaining;
      lot.available = Math.min(lot.available, p.remaining);
      break;
    }
    case "COMPONENT_RESERVATION_ACQUIRED": {
      const lot = state.lots[p.lot_id];
      lot.reserved += p.quantity;
      lot.available -= p.quantity;
      break;
    }
    case "COMPONENT_RESERVATION_RELEASED": {
      const lot = state.lots[p.lot_id];
      lot.reserved -= p.quantity;
      lot.available += p.quantity;
      // 已宣告缺货的批次，释放的预留不回到可用量（实物并不存在）
      if (lot.depleted) lot.available = Math.min(lot.available, lot.remaining_cap);
      break;
    }
    case "COMPONENT_RESERVATION_CONSUMED": {
      const lot = state.lots[p.lot_id];
      lot.reserved -= p.quantity;
      lot.consumed += p.quantity;
      break;
    }
    // ---- 标签快照与装配版本 ----
    case "LABEL_SNAPSHOT_PUBLISHED":
      state.labels[labelKey(p.label_id, p.version)] = {
        label_id: p.label_id,
        version: p.version,
        allergens: [...(p.allergens ?? [])],
        lines: [...(p.lines ?? [])],
      };
      break;
    case "ASSEMBLY_VERSION_PUBLISHED":
      state.assemblies[assemblyKey(p.assembly_id, p.version)] = {
        assembly_id: p.assembly_id,
        version: p.version,
        items: p.items.map((i) => ({ ...i })),
        label_key: labelKey(p.label_id, p.label_version),
      };
      break;
    // ---- 渠道额度台账 ----
    case "CHANNEL_QUOTA_CONFIGURED":
      state.quotas[p.channel_id] = {
        channel_id: p.channel_id,
        kind: p.kind,
        total: p.total,
        reserved: 0,
        consumed: 0,
      };
      break;
    case "CHANNEL_QUOTA_RESERVED":
      state.quotas[p.channel_id].reserved += p.quantity;
      break;
    case "CHANNEL_QUOTA_RELEASED":
      state.quotas[p.channel_id].reserved -= p.quantity;
      break;
    case "CHANNEL_QUOTA_CONSUMED": {
      const q = state.quotas[p.channel_id];
      q.reserved -= p.quantity;
      q.consumed += p.quantity;
      break;
    }
    case "CHANNEL_QUOTA_TRANSFERRED":
      if (p.direction === "out") state.quotas[p.channel_id].total -= p.quantity;
      else state.quotas[p.channel_id].total += p.quantity;
      break;
    // ---- 组合承诺 ----
    case "ORDER_RESERVED":
      state.commitments[p.commitment_id] = {
        commitment_id: p.commitment_id,
        channel_id: p.channel_id,
        assembly_key: assemblyKey(p.assembly_id, p.assembly_version),
        label_key: labelKey(p.label_id, p.label_version),
        quantity: p.quantity,
        fulfilled: 0,
        status: "reserved",
        notifications: [],
      };
      break;
    case "COMMITMENT_FULFILLED": {
      const c = state.commitments[p.commitment_id];
      c.fulfilled += p.quantity;
      c.status = c.fulfilled >= c.quantity ? "fulfilled" : "partially_fulfilled";
      break;
    }
    case "COMMITMENT_FROZEN":
      state.commitments[p.commitment_id].status = "frozen";
      break;
    case "COMMITMENT_MIGRATED": {
      const c = state.commitments[p.commitment_id];
      c.assembly_key = p.to_assembly_key;
      c.label_key = p.to_label_key;
      break;
    }
    // ---- 礼盒实物事实 ----
    case "BOX_ASSEMBLED":
      state.boxes[p.box_id] = {
        box_id: p.box_id,
        commitment_id: p.commitment_id,
        assembly_key: p.assembly_key,
        items: p.items.map((i) => ({ ...i })),
        label_key: p.label_key,
        redeemed: false,
      };
      break;
    case "BOX_REDEEMED":
      state.boxes[p.box_id].redeemed = true;
      break;
    // ---- 重组流程 ----
    case "REORGANIZATION_PROPOSED":
      state.plans[p.plan_id] = {
        plan_id: p.plan_id,
        trigger: { ...p.trigger },
        items: p.items.map((i) => ({ ...i, status: i.feasible === false ? "blocked" : "pending" })),
        label_confirmed: null,
        quota_confirmed: null,
        refusals: [],
      };
      break;
    case "REORGANIZATION_LABEL_CONFIRMED":
      state.plans[p.plan_id].label_confirmed = { by: p.confirmed_by };
      break;
    case "REORGANIZATION_QUOTA_CONFIRMED":
      state.plans[p.plan_id].quota_confirmed = { by: p.confirmed_by };
      break;
    case "REORGANIZATION_PARTNER_REFUSED": {
      const plan = state.plans[p.plan_id];
      plan.refusals.push({ partner_id: p.partner_id, reason: p.reason });
      for (const item of plan.items) {
        if (p.frozen_item_ids.includes(item.item_id)) item.status = "frozen";
      }
      break;
    }
    case "REORGANIZATION_ITEM_EXECUTED": {
      const plan = state.plans[p.plan_id];
      plan.items.find((i) => i.item_id === p.item_id).status = "executed";
      break;
    }
    // ---- 影响通知与合作方责任 ----
    case "IMPACT_NOTIFICATION_APPENDED":
      state.commitments[p.commitment_id].notifications.push({
        audience: p.audience,
        message: p.message,
        cause: p.cause,
      });
      break;
    case "LIABILITY_ASSIGNED":
      state.liabilities.push({
        partner_id: p.partner_id,
        cause: p.cause,
        ref: p.ref,
        detail: p.detail,
      });
      break;
    // ---- 离线回执与清算 ----
    case "RECEIPT_SUBMITTED": {
      state.receipts[p.business_id] ??= {
        business_id: p.business_id,
        records: [],
        sources: [],
        status: "open",
      };
      state.receipts[p.business_id].records.push({ source: p.source, content: p.content });
      break;
    }
    case "RECEIPT_MERGED": {
      const r = state.receipts[p.business_id];
      r.sources = [...p.sources];
      if (r.status === "open") r.status = "ready";
      break;
    }
    case "RECEIPT_CONFLICT_DETECTED": {
      const r = state.receipts[p.business_id];
      r.status = "conflicted";
      r.conflict = { differing_fields: [...p.differing_fields] };
      break;
    }
    case "SETTLEMENT_PAUSED": {
      const r = state.receipts[p.business_id];
      r.status = "paused";
      r.pause_reason = p.reason;
      break;
    }
    case "SETTLEMENT_CLEARED":
      state.receipts[p.business_id].status = "cleared";
      break;
    default:
      // DESIGN_CLEARED / BUNDLE_RELEASED / REMEDY_COMPLETED 等仅留痕，不改变投影
      break;
  }
  return state;
}

export function reduceEvents(events) {
  return events.reduce(applyEvent, initialState());
}
