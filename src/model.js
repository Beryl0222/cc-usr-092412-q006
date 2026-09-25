// 读模型：从仅追加事件流投影出组件批次、装配版本、标签快照、渠道额度、
// 组合承诺、重组方案、礼盒实例、清算与合作方责任的当前状态与历史轨迹。
// 投影是纯函数，不修改事件；任何更正都必须以后继事件体现。

const CHANNEL_KINDS = new Set(["stall", "groupbuy", "charity"]);

export function project(events) {
  const state = {
    design: null,
    lots: new Map(), // lot_id -> 批次状态（含预留、消耗、合作方）
    labels: new Map(), // label_id -> 不可变标签快照
    assemblies: new Map(), // assembly_id -> 装配版本（组件构成 + 标签）
    quotas: new Map(), // quota_id -> 渠道额度（含台账与公益保护标记）
    commitments: new Map(), // commitment_id -> 组合承诺
    plans: new Map(), // plan_id -> 重组方案与审批/执行状态
    boxes: new Map(), // box_id -> 已装配/领取礼盒
    clearances: new Map(), // business_key -> 清算合并批次
    liabilities: new Map(), // liability_id -> 合作方责任
  };

  for (const e of events) apply(state, e);
  return state;
}

function apply(state, e) {
  switch (e.event_type) {
    case "DESIGN_CLEARED":
      state.design = { design_id: e.aggregate_id, at: e.occurred_at };
      break;

    case "COMPONENT_ACCEPTED": {
      state.lots.set(e.lot_id, {
        lot_id: e.lot_id,
        component: e.component,
        partner_id: e.partner_id,
        partner_name: e.partner_name ?? null,
        allergens: Object.freeze([...(e.allergens ?? [])]),
        quantity_total: e.quantity,
        reserved: 0, // 被未履约承诺占用
        consumed: 0, // 已实际装入礼盒
        status: "accepted",
        quarantine: null,
      });
      break;
    }

    case "LOT_QUARANTINED": {
      const lot = must(state.lots, e.lot_id, "组件批次");
      lot.status = "quarantined";
      lot.quarantine = { reason: e.reason, conclusion: e.conclusion ?? null, at: e.occurred_at };
      break;
    }

    case "LOT_RELEASED": {
      const lot = must(state.lots, e.lot_id, "组件批次");
      lot.status = "accepted";
      lot.quarantine = null;
      break;
    }

    case "LABEL_SNAPSHOT_TAKEN":
      state.labels.set(e.label_id, {
        label_id: e.label_id,
        label_version: e.label_version,
        allergens: Object.freeze([...(e.allergens ?? [])]),
        content_hash: e.content_hash,
        text: e.text ?? null,
        at: e.occurred_at,
      });
      break;

    case "ASSEMBLY_VERSION_PUBLISHED": {
      must(state.labels, e.label_id, "标签快照");
      for (const c of e.components) must(state.lots, c.lot_id, "组件批次");
      state.assemblies.set(e.assembly_id, {
        assembly_id: e.assembly_id,
        label_id: e.label_id,
        components: Object.freeze(e.components.map((c) => ({ ...c }))),
        at: e.occurred_at,
      });
      break;
    }

    case "CHANNEL_QUOTA_OPENED": {
      must(state.assemblies, e.assembly_id, "装配版本");
      if (!CHANNEL_KINDS.has(e.channel_kind)) throw new Error(`未知渠道类型：${e.channel_kind}`);
      state.quotas.set(e.quota_id, {
        quota_id: e.quota_id,
        channel_id: e.channel_id,
        channel_kind: e.channel_kind,
        assembly_id: e.assembly_id,
        quantity_total: e.quantity,
        reserved: 0,
        protected_reserve: e.channel_kind === "charity", // 公益保留量
        ledger: [
          { at: e.occurred_at, delta: e.quantity, kind: "open", commitment_id: null, plan_id: null },
        ],
      });
      break;
    }

    case "COMMITMENT_PROMISED": {
      const c = state.commitments.get(e.commitment_id);
      if (c) throw new Error(`承诺已存在：${e.commitment_id}`);
      const quota = must(state.quotas, e.reservations.quota_id, "渠道额度");
      applyLotDeltas(state, e.reservations.lots, +1, e.occurred_at, "promise", e.commitment_id, null);
      quota.reserved += e.quantity;
      quota.ledger.push({ at: e.occurred_at, delta: +e.quantity, kind: "promise", commitment_id: e.commitment_id, plan_id: null });
      state.commitments.set(e.commitment_id, {
        commitment_id: e.commitment_id,
        channel_id: e.channel_id,
        channel_kind: e.channel_kind,
        assembly_id: e.assembly_id,
        label_id: e.label_id,
        quantity: e.quantity,
        assembled: 0,
        status: "promised",
        quota_id: quota.quota_id,
        history: [
          { at: e.occurred_at, assembly_id: e.assembly_id, label_id: e.label_id, quantity: e.quantity, plan_id: null, kind: "promise" },
        ],
      });
      break;
    }

    case "RECONFIGURATION_PROPOSED": {
      state.plans.set(e.plan_id, {
        plan_id: e.plan_id,
        reason: e.reason,
        trigger: e.trigger ?? null,
        at: e.occurred_at,
        changes: e.changes.map((c) => ({
          ...c,
          released: Object.freeze(c.released.map((x) => ({ ...x }))),
          acquired: Object.freeze(c.acquired.map((x) => ({ ...x }))),
          blockers: Object.freeze([...c.blockers]),
          required_partner_ids: Object.freeze([...c.required_partner_ids]),
        })),
        label_approval: null,
        quota_approval: null,
        partner_decisions: {}, // partner_id -> {decision, at, by, reason}
        status: "proposed",
        executed_at: null,
      });
      break;
    }

    case "LABEL_APPROVAL_GRANTED": {
      const plan = must(state.plans, e.plan_id, "重组方案");
      plan.label_approval = { by: e.approver, at: e.occurred_at, to_label_id: e.to_label_id };
      break;
    }

    case "QUOTA_APPROVAL_GRANTED": {
      const plan = must(state.plans, e.plan_id, "重组方案");
      plan.quota_approval = { by: e.approver, at: e.occurred_at };
      break;
    }

    case "PARTNER_APPROVAL_GRANTED":
    case "PARTNER_APPROVAL_REJECTED": {
      const plan = must(state.plans, e.plan_id, "重组方案");
      plan.partner_decisions[e.partner_id] = {
        decision: e.event_type === "PARTNER_APPROVAL_GRANTED" ? "granted" : "rejected",
        by: e.responder ?? e.partner_id,
        reason: e.reason ?? null,
        at: e.occurred_at,
      };
      break;
    }

    case "COMMITMENT_MIGRATED": {
      const commitment = must(state.commitments, e.commitment_id, "组合承诺");
      applyLotDeltas(state, e.released, -1, e.occurred_at, "release", e.commitment_id, e.plan_id);
      applyLotDeltas(state, e.acquired, +1, e.occurred_at, "acquire", e.commitment_id, e.plan_id);
      const from = must(state.quotas, e.from_quota_id, "渠道额度");
      const to = must(state.quotas, e.to_quota_id, "渠道额度");
      from.reserved -= e.quantity;
      to.reserved += e.quantity;
      from.ledger.push({ at: e.occurred_at, delta: -e.quantity, kind: "migrate_out", commitment_id: e.commitment_id, plan_id: e.plan_id });
      to.ledger.push({ at: e.occurred_at, delta: +e.quantity, kind: "migrate_in", commitment_id: e.commitment_id, plan_id: e.plan_id });
      commitment.assembly_id = e.to_assembly_id;
      commitment.label_id = e.to_label_id;
      commitment.quota_id = to.quota_id;
      commitment.status = "promised";
      commitment.frozen = null; // 凭新方案恢复：冻结事实已保留在 history 中
      commitment.history.push({
        at: e.occurred_at,
        kind: "migrate",
        plan_id: e.plan_id,
        quantity: e.quantity,
        from_assembly_id: e.from_assembly_id,
        to_assembly_id: e.to_assembly_id,
        from_label_id: e.from_label_id,
        to_label_id: e.to_label_id,
        from_quota_id: e.from_quota_id,
        to_quota_id: e.to_quota_id,
      });
      break;
    }

    case "COMMITMENT_FROZEN": {
      const commitment = must(state.commitments, e.commitment_id, "组合承诺");
      commitment.status = "frozen";
      commitment.frozen = { plan_id: e.plan_id, reason: e.reason, rejecting_partner_id: e.rejecting_partner_id ?? null, at: e.occurred_at };
      commitment.history.push({
        at: e.occurred_at,
        assembly_id: commitment.assembly_id,
        label_id: commitment.label_id,
        quantity: remaining(commitment),
        plan_id: e.plan_id,
        kind: "freeze",
        reason: e.reason,
        rejecting_partner_id: e.rejecting_partner_id ?? null,
      });
      break;
    }

    case "RECONFIGURATION_EXECUTED": {
      const plan = must(state.plans, e.plan_id, "重组方案");
      plan.status = e.frozen.length > 0 && e.migrated.length === 0
        ? "all_frozen"
        : e.frozen.length > 0
          ? "partially_executed"
          : "executed";
      plan.executed_at = e.occurred_at;
      plan.execution = { migrated: [...e.migrated], frozen: [...e.frozen] };
      break;
    }

    case "GIFT_BOX_ASSEMBLED": {
      const commitment = must(state.commitments, e.commitment_id, "组合承诺");
      for (const p of e.packed) {
        const lot = must(state.lots, p.lot_id, "组件批次");
        lot.reserved -= p.qty;
        lot.consumed += p.qty;
      }
      const quota = must(state.quotas, commitment.quota_id, "渠道额度");
      quota.reserved -= 1;
      quota.ledger.push({ at: e.occurred_at, delta: -1, kind: "assemble", commitment_id: e.commitment_id, plan_id: null, box_id: e.box_id });
      commitment.assembled += 1;
      if (remaining(commitment) === 0) commitment.status = "fulfilled";
      state.boxes.set(e.box_id, {
        box_id: e.box_id,
        commitment_id: e.commitment_id,
        // 装配事实一经写入不再改变
        assembly_id: e.assembly_id,
        label_id: e.label_id,
        packed: Object.freeze(e.packed.map((p) => ({ ...p }))),
        assembled_at: e.occurred_at,
        claimed: false,
        claimed_at: null,
        notices: [],
      });
      break;
    }

    case "GIFT_BOX_CLAIMED": {
      const box = must(state.boxes, e.box_id, "礼盒");
      box.claimed = true;
      box.claimed_at = e.occurred_at;
      break;
    }

    case "BOX_IMPACT_NOTICE_APPENDED": {
      const box = must(state.boxes, e.box_id, "礼盒");
      box.notices.push({
        at: e.occurred_at,
        plan_id: e.plan_id ?? null,
        impact: e.impact,
        details: e.details ?? null,
      });
      break;
    }

    case "FULFILLMENT_RECEIPT_ACCEPTED": {
      const clearance = getClearance(state, e.business_key);
      clearance.receipts.push({
        receipt_id: e.receipt_id,
        source: e.source,
        content_hash: e.content_hash,
        amount: e.amount ?? 0,
        at: e.occurred_at,
      });
      break;
    }

    case "FULFILLMENT_RECEIPT_HELD": {
      const clearance = getClearance(state, e.business_key);
      const existing = clearance.receipts.find((r) => r.receipt_id === e.receipt_id);
      clearance.held_receipts.push({
        receipt_id: e.receipt_id,
        source: e.source,
        content_hash: e.content_hash,
        existing_hash: existing?.content_hash ?? null,
        existing_receipt_id: e.existing_receipt_id,
        at: e.occurred_at,
        resolved: null,
      });
      break;
    }

    case "HELD_RECEIPT_RESOLVED": {
      const clearance = getClearance(state, e.business_key);
      const held = clearance.held_receipts.find(
        (r) => r.receipt_id === e.receipt_id && !r.resolved
      );
      if (!held) throw new Error(`没有待处置的扣留回执：${e.business_key}/${e.receipt_id}`);
      held.resolved = { decision: e.decision, by: e.by, reason: e.reason ?? null, at: e.occurred_at };
      if (e.decision === "replaced") {
        // 以新内容转正：原接收记录仍留在台账，新增一条后继记录而不是覆盖。
        clearance.receipts.push({
          receipt_id: e.receipt_id,
          source: held.source,
          content_hash: held.content_hash,
          amount: e.amount ?? 0,
          at: e.occurred_at,
          supersedes_hash: held.existing_hash,
        });
      }
      break;
    }

    case "CLEARANCE_PAUSED": {
      const clearance = getClearance(state, e.business_key);
      clearance.status = "paused";
      clearance.pause_reasons.push({ at: e.occurred_at, reason: e.reason });
      break;
    }

    case "CLEARANCE_RESUMED": {
      const clearance = getClearance(state, e.business_key);
      clearance.status = "open";
      clearance.resumptions.push({ at: e.occurred_at, reason: e.reason, by: e.by });
      break;
    }

    case "CLEARANCE_SETTLED": {
      const clearance = getClearance(state, e.business_key);
      clearance.status = "settled";
      clearance.settled_at = e.occurred_at;
      clearance.settled_total = e.total_amount;
      break;
    }

    case "LIABILITY_ASSIGNED":
      state.liabilities.set(e.liability_id, {
        liability_id: e.liability_id,
        partner_id: e.partner_id,
        plan_id: e.plan_id ?? null,
        commitment_id: e.commitment_id ?? null,
        box_id: e.box_id ?? null,
        basis: e.basis,
        share: e.share ?? null,
        amount: e.amount ?? null,
        status: "open",
        at: e.occurred_at,
        remedy: null,
      });
      break;

    case "REMEDY_COMPLETED": {
      const liability = must(state.liabilities, e.aggregate_id, "合作方责任");
      liability.status = "remedied";
      liability.remedy = { at: e.occurred_at, note: e.summary };
      break;
    }

    case "BUNDLE_RELEASED":
    case "ORDER_RESERVED":
      // 基线保留事件：当前流程不依赖其载荷。
      break;

    default:
      throw new Error(`投影无法识别事件类型：${e.event_type}`);
  }
}

function applyLotDeltas(state, deltas, sign, at, kind, commitmentId, planId) {
  for (const d of deltas) {
    const lot = must(state.lots, d.lot_id, "组件批次");
    lot.reserved += sign * d.qty;
    if (lot.reserved < 0) throw new Error(`批次 ${d.lot_id} 预留量变为负数`);
  }
}

function getClearance(state, businessKey) {
  let clearance = state.clearances.get(businessKey);
  if (!clearance) {
    clearance = {
      business_key: businessKey,
      status: "open",
      receipts: [],
      held_receipts: [],
      pause_reasons: [],
      resumptions: [],
      settled_at: null,
      settled_total: null,
    };
    state.clearances.set(businessKey, clearance);
  }
  return clearance;
}

function remaining(commitment) {
  return commitment.quantity - commitment.assembled;
}

function must(map, id, label) {
  const v = map.get(id);
  if (!v) throw new Error(`${label}不存在：${id}`);
  return v;
}

// ---- 派生查询 ----

export function lotFreeQuantity(state, lotId) {
  const lot = must(state.lots, lotId, "组件批次");
  return lot.quantity_total - lot.reserved - lot.consumed;
}

export function quotaFreeQuantity(state, quotaId) {
  const quota = must(state.quotas, quotaId, "渠道额度");
  return quota.quantity_total - quota.reserved;
}

export function commitmentRemaining(state, commitmentId) {
  return remaining(must(state.commitments, commitmentId, "组合承诺"));
}
