// 组合承诺与重组应用服务。
// 所有状态改变都以仅追加事件体现；一次业务动作产生的事件在同一批次原子提交。
//
// 角色（由调用方在 approver/responder 字段中留痕）：
// - 食品负责人：确认重组采用的标签版本（过敏原覆盖新组件）
// - 渠道负责人：确认渠道额度变化（配额不被突破、公益保留不被挪用）
// - 合作方：对自己新供组件的替换逐项批准/拒绝

import { EventStore, eventBatch } from "./store.js";
import { project, lotFreeQuantity, quotaFreeQuantity, commitmentRemaining } from "./model.js";

const CHANNEL_KINDS = ["stall", "groupbuy", "charity"];

export class BusinessRuleError extends Error {}

export class CollaborationService {
  constructor(store = new EventStore()) {
    this.store = store;
  }

  state() {
    return project(this.store.stream());
  }

  // ---------- 基础资料：合作方、组件批次、标签、装配版本、渠道额度 ----------

  acceptComponent({ lot_id, component, partner_id, partner_name = null, quantity, allergens = [], at = nowIso() }) {
    if (this.state().lots.has(lot_id)) throw new BusinessRuleError(`组件批次编号重复：${lot_id}`);
    const b = eventBatch(this.store, at);
    b.add("COMPONENT_ACCEPTED", "component_lot", lot_id, {
      summary: `入库组件批次 ${lot_id}（${component}），合作方 ${partner_id}`,
      lot_id, component, partner_id, partner_name, quantity, allergens: [...allergens],
    }, "component");
    b.commit();
  }

  // 缺货或检测结论变化：冻结批次，已承诺数量仍保留在批次台账上待重组。
  quarantineLot({ lot_id, reason, conclusion = null, at = nowIso() }) {
    const b = eventBatch(this.store, at);
    b.add("LOT_QUARANTINED", "component_lot", lot_id, {
      summary: `批次 ${lot_id} 冻结：${reason}`,
      lot_id, reason, conclusion,
    }, "quarantine");
    b.commit();
  }

  releaseLot({ lot_id, at = nowIso() }) {
    const b = eventBatch(this.store, at);
    b.add("LOT_RELEASED", "component_lot", lot_id, {
      summary: `批次 ${lot_id} 解除冻结`,
      lot_id,
    }, "release-lot");
    b.commit();
  }

  // 标签是不可变快照：过敏原说明的任何更正都产生新版本，而不是覆盖旧版。
  takeLabelSnapshot({ label_id, label_version, allergens = [], content_hash, text = null, at = nowIso() }) {
    if (this.state().labels.has(label_id)) throw new BusinessRuleError(`标签快照不可覆盖，请新建版本：${label_id}`);
    const b = eventBatch(this.store, at);
    b.add("LABEL_SNAPSHOT_TAKEN", "label_snapshot", label_id, {
      summary: `留存标签快照 ${label_id}（版本 ${label_version}）`,
      label_id, label_version, allergens: [...allergens], content_hash, text,
    }, "label");
    b.commit();
  }

  publishAssembly({ assembly_id, label_id, components, at = nowIso() }) {
    const s = this.state();
    if (s.assemblies.has(assembly_id)) throw new BusinessRuleError(`装配版本编号重复：${assembly_id}`);
    const label = require(s.labels, label_id, "标签快照");
    for (const c of components) {
      require(s.lots, c.lot_id, "组件批次");
      if (!Number.isInteger(c.qty) || c.qty <= 0) throw new BusinessRuleError(`组件数量非法：${c.lot_id}`);
    }
    assertAllergensCovered(s, components, label, `装配 ${assembly_id}`);
    const b = eventBatch(this.store, at);
    b.add("ASSEMBLY_VERSION_PUBLISHED", "assembly_version", assembly_id, {
      summary: `发布装配版本 ${assembly_id}，采用标签 ${label_id}`,
      assembly_id, label_id,
      components: components.map((c) => ({ lot_id: c.lot_id, qty: c.qty })),
    }, "assembly");
    b.commit();
  }

  openChannelQuota({ quota_id, channel_id, channel_kind, assembly_id, quantity, at = nowIso() }) {
    if (!CHANNEL_KINDS.includes(channel_kind)) throw new BusinessRuleError(`未知渠道类型：${channel_kind}`);
    const s = this.state();
    require(s.assemblies, assembly_id, "装配版本");
    if (s.quotas.has(quota_id)) throw new BusinessRuleError(`渠道额度编号重复：${quota_id}`);
    if (findQuota(s, channel_id, assembly_id)) {
      throw new BusinessRuleError(`渠道 ${channel_id} 针对装配 ${assembly_id} 已开放额度`);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BusinessRuleError("额度必须为正整数");
    const b = eventBatch(this.store, at);
    b.add("CHANNEL_QUOTA_OPENED", "channel_quota", quota_id, {
      summary: `开放渠道额度 ${quota_id}（${channelLabel(channel_kind)} ${channel_id}，${quantity} 份，装配 ${assembly_id}）`,
      quota_id, channel_id, channel_kind, assembly_id, quantity,
    }, "quota");
    b.commit();
  }

  // ---------- 组合承诺：同时占用组件批次与渠道额度 ----------

  promise({ commitment_id, channel_id, channel_kind, assembly_id, quantity, at = nowIso() }) {
    const s = this.state();
    const assembly = require(s.assemblies, assembly_id, "装配版本");
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BusinessRuleError("承诺数量必须为正整数");

    const quota = findQuota(s, channel_id, assembly_id);
    if (!quota) throw new BusinessRuleError(`渠道 ${channel_id} 针对装配 ${assembly_id} 的额度尚未开放`);
    if (quota.channel_kind !== channel_kind) {
      throw new BusinessRuleError(`渠道类型不匹配：额度为 ${quota.channel_kind}，承诺声明为 ${channel_kind}`);
    }
    if (quotaFreeQuantity(s, quota.quota_id) < quantity) {
      throw new BusinessRuleError(`渠道额度不足：${quota.quota_id} 剩余 ${quotaFreeQuantity(s, quota.quota_id)}，需 ${quantity}`);
    }

    const lotReservations = [];
    for (const c of assembly.components) {
      const lot = require(s.lots, c.lot_id, "组件批次");
      if (lot.status !== "accepted") throw new BusinessRuleError(`批次 ${lot.lot_id} 已冻结，不能据此承诺`);
      const need = c.qty * quantity;
      if (lotFreeQuantity(s, lot.lot_id) < need) {
        throw new BusinessRuleError(`组件批次 ${lot.lot_id} 可用量不足：剩余 ${lotFreeQuantity(s, lot.lot_id)}，需 ${need}`);
      }
      lotReservations.push({ lot_id: lot.lot_id, qty: need });
    }

    const b = eventBatch(this.store, at);
    b.add("COMMITMENT_PROMISED", "bundle_commitment", commitment_id, {
      summary: `${channelLabel(channel_kind)}渠道 ${channel_id} 承诺 ${quantity} 份装配 ${assembly_id}（标签 ${assembly.label_id}）`,
      commitment_id, channel_id, channel_kind, assembly_id, label_id: assembly.label_id, quantity,
      reservations: { quota_id: quota.quota_id, lots: lotReservations },
    }, "promise");
    b.commit();
  }

  // ---------- 缺货 / 检测变化：找出受影响的未履约承诺 ----------

  affectedCommitments(lotId) {
    const s = this.state();
    const out = [];
    for (const c of s.commitments.values()) {
      if (c.status !== "promised") continue;
      const remaining = commitmentRemaining(s, c.commitment_id);
      if (remaining <= 0) continue;
      const assembly = s.assemblies.get(c.assembly_id);
      if (assembly.components.some((x) => x.lot_id === lotId)) out.push(c.commitment_id);
    }
    return out;
  }

  /**
   * 提出重组方案。系统为每个受影响承诺计算：
   * 剩余份数、释放的旧组件、占用的新组件、目标渠道额度、需表态的合作方、当前可行性。
   */
  proposeReconfiguration({ plan_id, reason, trigger = null, changes, at = nowIso() }) {
    if (!Array.isArray(changes) || changes.length === 0) throw new BusinessRuleError("方案至少包含一项变更");
    const s = this.state();
    if (s.plans.has(plan_id)) throw new BusinessRuleError(`重组方案编号重复：${plan_id}`);

    // 同一方案内逐项模拟占用，避免两项变更互相超额。
    const lotDelta = new Map();
    const quotaDelta = new Map();
    const planned = [];
    const seenCommitments = new Set();

    for (const ch of changes) {
      if (seenCommitments.has(ch.commitment_id)) {
        throw new BusinessRuleError(`同一方案中承诺 ${ch.commitment_id} 只能出现一次`);
      }
      seenCommitments.add(ch.commitment_id);
      const commitment = require(s.commitments, ch.commitment_id, "组合承诺");
      if (commitment.status !== "promised" && commitment.status !== "frozen") {
        throw new BusinessRuleError(`承诺 ${ch.commitment_id} 状态为 ${commitment.status}，不能纳入重组`);
      }
      // 已冻结组合可以凭新方案（例如找到替代合作方）重新纳入评估。
      const toAssembly = require(s.assemblies, ch.to_assembly_id, "目标装配版本");
      const toLabel = ch.to_label_id ? require(s.labels, ch.to_label_id, "目标标签快照") : s.labels.get(toAssembly.label_id);
      if (!toLabel) throw new BusinessRuleError(`标签快照不存在：${ch.to_label_id ?? toAssembly.label_id}`);

      if (ch.to_assembly_id === commitment.assembly_id && toLabel.label_id === commitment.label_id) {
        throw new BusinessRuleError(`承诺 ${ch.commitment_id} 的装配与标签均未变化，无需重组`);
      }

      const remaining = commitmentRemaining(s, commitment.commitment_id);
      const fromAssembly = require(s.assemblies, commitment.assembly_id, "原装配版本");
      const released = diffComponents(fromAssembly.components, toAssembly.components, remaining, "release");
      const acquired = diffComponents(fromAssembly.components, toAssembly.components, remaining, "acquire");

      const toQuota = findQuota(s, commitment.channel_id, toAssembly.assembly_id);
      const blockers = [];
      if (!toQuota) blockers.push(`渠道 ${commitment.channel_id} 未开放装配 ${toAssembly.assembly_id} 的额度`);

      for (const a of acquired) {
        const lot = require(s.lots, a.lot_id, "组件批次");
        if (lot.status !== "accepted") blockers.push(`新组件批次 ${a.lot_id} 处于冻结状态`);
        const free = lotFreeQuantity(s, lot.lot_id) - (lotDelta.get(lot.lot_id) ?? 0);
        if (free < a.qty) blockers.push(`新组件批次 ${a.lot_id} 可用量不足：剩 ${free}，需 ${a.qty}`);
      }
      if (toQuota) {
        if (toQuota.channel_kind !== commitment.channel_kind) {
          blockers.push(`目标额度渠道类型 ${toQuota.channel_kind} 与承诺渠道 ${commitment.channel_kind} 不一致`);
        }
        const free = quotaFreeQuantity(s, toQuota.quota_id) - (quotaDelta.get(toQuota.quota_id) ?? 0);
        if (free < remaining) blockers.push(`目标渠道额度 ${toQuota.quota_id} 不足：剩 ${free}，需 ${remaining}`);
      }
      try {
        assertAllergensCovered(s, toAssembly.components, toLabel, `承诺 ${commitment.commitment_id} 的目标标签`);
      } catch (err) {
        blockers.push(err.message);
      }

      const requiredPartnerIds = [...new Set(acquired.map((a) => require(s.lots, a.lot_id, "组件批次").partner_id))];
      for (const a of acquired) lotDelta.set(a.lot_id, (lotDelta.get(a.lot_id) ?? 0) + a.qty);
      if (toQuota) quotaDelta.set(toQuota.quota_id, (quotaDelta.get(toQuota.quota_id) ?? 0) + remaining);

      planned.push({
        commitment_id: commitment.commitment_id,
        remaining,
        from_assembly_id: fromAssembly.assembly_id,
        to_assembly_id: toAssembly.assembly_id,
        from_label_id: commitment.label_id,
        to_label_id: toLabel.label_id,
        from_quota_id: commitment.quota_id,
        to_quota_id: toQuota ? toQuota.quota_id : null,
        released,
        acquired,
        required_partner_ids: requiredPartnerIds,
        feasible: blockers.length === 0,
        blockers,
      });
    }

    const b = eventBatch(this.store, at);
    b.add("RECONFIGURATION_PROPOSED", "reconfiguration_plan", plan_id, {
      summary: `提出重组方案 ${plan_id}：${reason}（${planned.length} 项承诺，${planned.filter((p) => p.feasible).length} 项当前可行）`,
      plan_id, reason, trigger, changes: planned,
    }, "plan");
    b.commit();
    return planned;
  }

  // ---------- 双闸门 + 合作方逐项表态 ----------

  approveLabel({ plan_id, approver, to_label_id = null, at = nowIso() }) {
    const s = this.state();
    const plan = require(s.plans, plan_id, "重组方案");
    assertOpen(plan);
    const targetLabelIds = new Set();
    for (const ch of plan.changes) {
      const labelId = to_label_id ?? ch.to_label_id;
      targetLabelIds.add(labelId);
      const label = require(s.labels, labelId, "标签快照");
      const assembly = require(s.assemblies, ch.to_assembly_id, "目标装配版本");
      assertAllergensCovered(s, assembly.components, label, `方案 ${plan_id} 标签审批`);
    }
    const b = eventBatch(this.store, at);
    b.add("LABEL_APPROVAL_GRANTED", "reconfiguration_plan", plan_id, {
      summary: `食品负责人 ${approver} 确认方案 ${plan_id} 标签版本${to_label_id ? `：${to_label_id}` : "（各项目标标签）"}`,
      plan_id, approver, to_label_id,
    }, "label-ok");
    b.commit();
  }

  approveQuota({ plan_id, approver, at = nowIso() }) {
    const s = this.state();
    const plan = require(s.plans, plan_id, "重组方案");
    assertOpen(plan);
    // 渠道负责人确认时复核此刻的额度，防止提案后额度被别的承诺占用。
    // 方案内所有项目都要确认；缺目标额度的项目执行时会被冻结，不影响其余项目的核算。
    const quotaNeed = new Map();
    for (const ch of plan.changes) {
      const commitment = require(s.commitments, ch.commitment_id, "组合承诺");
      const toQuota = ch.to_quota_id ? require(s.quotas, ch.to_quota_id, "目标渠道额度") : null;
      if (!toQuota) continue;
      if (toQuota.channel_kind !== commitment.channel_kind) {
        throw new BusinessRuleError(`公益/商业渠道不可互换：承诺 ${ch.commitment_id} 为 ${commitment.channel_kind}，目标额度为 ${toQuota.channel_kind}`);
      }
      const remaining = commitmentRemaining(s, commitment.commitment_id);
      quotaNeed.set(toQuota.quota_id, (quotaNeed.get(toQuota.quota_id) ?? 0) + remaining);
    }
    for (const [quotaId, need] of quotaNeed) {
      if (quotaFreeQuantity(s, quotaId) < need) {
        throw new BusinessRuleError(`渠道额度 ${quotaId} 此刻不足，渠道负责人不能确认`);
      }
    }
    const b = eventBatch(this.store, at);
    b.add("QUOTA_APPROVAL_GRANTED", "reconfiguration_plan", plan_id, {
      summary: `渠道负责人 ${approver} 确认方案 ${plan_id} 配额变化`,
      plan_id, approver,
    }, "quota-ok");
    b.commit();
  }

  partnerRespond({ plan_id, partner_id, decision, responder = null, reason = null, at = nowIso() }) {
    if (!["granted", "rejected"].includes(decision)) throw new BusinessRuleError("decision 只能是 granted 或 rejected");
    const s = this.state();
    const plan = require(s.plans, plan_id, "重组方案");
    assertOpen(plan);
    const involved = plan.changes.some((ch) => ch.required_partner_ids.includes(partner_id));
    if (!involved) throw new BusinessRuleError(`合作方 ${partner_id} 不在方案 ${plan_id} 的责任范围内`);

    const b = eventBatch(this.store, at);
    const type = decision === "granted" ? "PARTNER_APPROVAL_GRANTED" : "PARTNER_APPROVAL_REJECTED";
    b.add(type, "reconfiguration_plan", plan_id, {
      summary: `合作方 ${partner_id} 对方案 ${plan_id} ${decision === "granted" ? "同意" : "拒绝"}${reason ? `：${reason}` : ""}`,
      plan_id, partner_id, responder, reason,
    }, decision === "granted" ? "partner-ok" : "partner-no");
    b.commit();
  }

  /**
   * 执行重组：
   * - 必须同时持有食品负责人的标签确认与渠道负责人的配额确认；
   * - 任一必需合作方拒绝、或执行时条件不再成立的，仅冻结该受影响组合，其余照常迁移；
   * - 全部释放/占用事件在同一批次原子提交，任一项校验失败则整体不生效；
   * - 已装配（含已领取）礼盒保持原装配事实，仅按影响追加通知。
   */
  executePlan(plan_id, { at = nowIso() } = {}) {
    const s = this.state();
    const plan = require(s.plans, plan_id, "重组方案");
    assertOpen(plan);
    if (!plan.label_approval) throw new BusinessRuleError("缺少食品负责人的标签确认");
    if (!plan.quota_approval) throw new BusinessRuleError("缺少渠道负责人的配额确认");

    const migrated = [];
    const frozen = [];
    const b = eventBatch(this.store, at);
    // 同一方案内多项迁移共享新组件/新额度：记录批内已占用量，后一项不得挤用前一项。
    const lotUsed = new Map();
    const quotaUsed = new Map();

    for (const ch of plan.changes) {
      const commitment = s.commitments.get(ch.commitment_id);
      const freeze = (reason, rejectingPartnerId = null) => {
        frozen.push({ commitment_id: ch.commitment_id, reason, rejecting_partner_id: rejectingPartnerId });
        b.add("COMMITMENT_FROZEN", "bundle_commitment", ch.commitment_id, {
          summary: `承诺 ${ch.commitment_id} 因重组受阻被冻结：${reason}`,
          commitment_id: ch.commitment_id, plan_id, reason, rejecting_partner_id: rejectingPartnerId,
        }, "freeze");
      };

      // 合作方拒绝：只冻结受影响组合，不波及其它承诺。
      const rejected = ch.required_partner_ids.filter(
        (pid) => plan.partner_decisions[pid]?.decision === "rejected"
      );
      if (rejected.length > 0) {
        freeze(`合作方 ${rejected.join("、")} 拒绝替换`, rejected[0]);
        continue;
      }
      // 合作方尚未表态：同样只暂缓本组合，等待表态后可另行提案。
      const undecided = ch.required_partner_ids.filter((pid) => !plan.partner_decisions[pid]);
      if (undecided.length > 0) {
        freeze(`合作方 ${undecided.join("、")} 尚未表态`);
        continue;
      }

      if (!commitment) {
        freeze("承诺不存在");
        continue;
      }
      // 上轮被冻结的组合可凭本方案恢复；其它终态不可迁移。
      if (commitment.status !== "promised" && commitment.status !== "frozen") {
        freeze(`承诺状态为 ${commitment.status}`);
        continue;
      }

      // 按执行当下的剩余量重算释放与占用（提案后可能已有礼盒装配/领取）。
      const remaining = commitmentRemaining(s, ch.commitment_id);
      if (remaining <= 0) {
        freeze("承诺已全部履约，无可迁移数量");
        continue;
      }
      const fromAssembly = require(s.assemblies, ch.from_assembly_id, "原装配版本");
      const toAssembly = require(s.assemblies, ch.to_assembly_id, "目标装配版本");
      const released = diffComponents(fromAssembly.components, toAssembly.components, remaining, "release");
      const acquired = diffComponents(fromAssembly.components, toAssembly.components, remaining, "acquire");
      const toLabelId = plan.label_approval.to_label_id ?? ch.to_label_id;

      const blockers = [];
      for (const a of acquired) {
        const lot = s.lots.get(a.lot_id);
        if (!lot) { blockers.push(`新组件批次 ${a.lot_id} 不存在`); continue; }
        if (lot.status !== "accepted") blockers.push(`新组件批次 ${a.lot_id} 已冻结`);
        const free = lotFreeQuantity(s, lot.lot_id) - (lotUsed.get(lot.lot_id) ?? 0);
        if (free < a.qty) blockers.push(`新组件批次 ${a.lot_id} 可用量不足：剩 ${free}，需 ${a.qty}`);
      }
      const toQuota = ch.to_quota_id ? s.quotas.get(ch.to_quota_id) : null;
      if (!toQuota) {
        blockers.push("目标渠道额度不存在");
      } else {
        if (toQuota.channel_kind !== commitment.channel_kind) blockers.push("公益/商业渠道不可互换");
        const free = quotaFreeQuantity(s, toQuota.quota_id) - (quotaUsed.get(toQuota.quota_id) ?? 0);
        if (free < remaining) blockers.push(`目标渠道额度 ${toQuota.quota_id} 不足：剩 ${free}，需 ${remaining}`);
      }
      const toLabel = s.labels.get(toLabelId);
      if (!toLabel) blockers.push("目标标签快照不存在");
      else {
        try {
          assertAllergensCovered(s, toAssembly.components, toLabel, "目标标签");
        } catch (err) {
          blockers.push(err.message);
        }
      }
      if (blockers.length > 0) {
        freeze(blockers.join("；"));
        continue;
      }

      for (const a of acquired) lotUsed.set(a.lot_id, (lotUsed.get(a.lot_id) ?? 0) + a.qty);
      if (toQuota) quotaUsed.set(toQuota.quota_id, (quotaUsed.get(toQuota.quota_id) ?? 0) + remaining);

      migrated.push({ commitment_id: ch.commitment_id, remaining });
      const fromLabel = commitment.label_id;
      const allergenAdded = allergensAdded(s, fromLabel, toLabelId);
      b.add("COMMITMENT_MIGRATED", "bundle_commitment", ch.commitment_id, {
        summary: `承诺 ${ch.commitment_id} 迁移至装配 ${toAssembly.assembly_id}（标签 ${toLabelId}），剩余 ${remaining} 份`,
        commitment_id: ch.commitment_id, plan_id,
        quantity: remaining,
        from_assembly_id: fromAssembly.assembly_id, to_assembly_id: toAssembly.assembly_id,
        from_label_id: fromLabel, to_label_id: toLabelId,
        from_quota_id: ch.from_quota_id, to_quota_id: ch.to_quota_id,
        released, acquired,
      }, "migrate");

      // 已存在的礼盒（含已领取）装配事实不动，仅追加影响通知。
      for (const box of s.boxes.values()) {
        if (box.commitment_id !== ch.commitment_id) continue;
        b.add("BOX_IMPACT_NOTICE_APPENDED", "gift_box", box.box_id, {
          summary: `礼盒 ${box.box_id} 受方案 ${plan_id} 影响：后续未履约份数改用新装配，本盒保持原装配`,
          box_id: box.box_id, plan_id,
          impact: {
            kind: "reconfiguration",
            claimed: box.claimed,
            from_assembly_id: fromAssembly.assembly_id,
            to_assembly_id: toAssembly.assembly_id,
            from_label_id: fromLabel,
            to_label_id: toLabelId,
            allergen_added: allergenAdded,
            component_changes: acquired.map((a) => ({ lot_id: a.lot_id, qty: a.qty })),
          },
          details: plan.reason,
        }, "notice");
      }
    }

    b.add("RECONFIGURATION_EXECUTED", "reconfiguration_plan", plan_id, {
      summary: `方案 ${plan_id} 执行：迁移 ${migrated.length} 项，冻结 ${frozen.length} 项`,
      plan_id, migrated, frozen,
    }, "executed");

    // 提交前用试投影验证整批占用（含批次总量、渠道额度上限、版本连贯）。
    const tentative = project([...this.store.stream(), ...b.events]);
    this._postCheck(tentative, plan, migrated, frozen);
    b.commit();
    return { migrated, frozen };
  }

  _postCheck(state, plan, migrated, frozen) {
    for (const lot of state.lots.values()) {
      if (lot.reserved + lot.consumed > lot.quantity_total) {
        throw new BusinessRuleError(`批次 ${lot.lot_id} 占用总量超过库存，重组整体回滚`);
      }
    }
    for (const quota of state.quotas.values()) {
      if (quota.reserved > quota.quantity_total) {
        throw new BusinessRuleError(`渠道额度 ${quota.quota_id} 被突破，重组整体回滚`);
      }
    }
    const migratedIds = new Set(migrated.map((m) => m.commitment_id));
    for (const ch of plan.changes) {
      const c = state.commitments.get(ch.commitment_id);
      const wasMigrated = migratedIds.has(ch.commitment_id);
      if (wasMigrated && c.status !== "promised") throw new BusinessRuleError("迁移后承诺状态异常");
      if (!wasMigrated && c.status !== "frozen") throw new BusinessRuleError("未迁移承诺必须为冻结状态");
    }
  }

  // ---------- 实物装配、领取 ----------

  assembleBox({ box_id, commitment_id, at = nowIso() }) {
    const s = this.state();
    const commitment = require(s.commitments, commitment_id, "组合承诺");
    if (commitment.status === "frozen") throw new BusinessRuleError(`承诺 ${commitment_id} 已冻结，不能装配`);
    if (commitment.status !== "promised") throw new BusinessRuleError(`承诺 ${commitment_id} 状态为 ${commitment.status}，不能装配`);
    if (commitmentRemaining(s, commitment_id) < 1) throw new BusinessRuleError("承诺数量已全部履约");
    const assembly = require(s.assemblies, commitment.assembly_id, "装配版本");
    const packed = assembly.components.map((c) => {
      const lot = require(s.lots, c.lot_id, "组件批次");
      if (lot.status !== "accepted") throw new BusinessRuleError(`批次 ${lot.lot_id} 已冻结，无法装入`);
      return { lot_id: lot.lot_id, partner_id: lot.partner_id, qty: c.qty };
    });

    const b = eventBatch(this.store, at);
    b.add("GIFT_BOX_ASSEMBLED", "gift_box", box_id, {
      summary: `礼盒 ${box_id} 按装配 ${assembly.assembly_id} 完成装配，标签 ${commitment.label_id}`,
      box_id, commitment_id,
      assembly_id: assembly.assembly_id, label_id: commitment.label_id, packed,
    }, "box");
    // 同业务标识的装配回执并入同一清算批次。
    b.add("FULFILLMENT_RECEIPT_ACCEPTED", "clearance_batch", commitment.channel_id, {
      summary: `装配回执并入清算批次 ${commitment.channel_id}`,
      business_key: commitment.channel_id, receipt_id: box_id, source: "assembly",
      content_hash: hashOf({ assembly_id: assembly.assembly_id, label_id: commitment.label_id, packed }),
      amount: 1,
    }, "receipt");
    b.commit();
  }

  claimBox({ box_id, at = nowIso() }) {
    const s = this.state();
    const box = require(s.boxes, box_id, "礼盒");
    if (box.claimed) throw new BusinessRuleError(`礼盒 ${box_id} 已被领取`);
    const b = eventBatch(this.store, at);
    b.add("GIFT_BOX_CLAIMED", "gift_box", box_id, {
      summary: `礼盒 ${box_id} 已领取`,
      box_id,
    }, "claim");
    b.commit();
  }

  // ---------- 离线核销与装配回执：按业务标识合并，同号异容暂停清算 ----------

  /**
   * @returns {'accepted'|'duplicate'|'held'}
   * 同一业务标识（渠道/清算批次）下，离线核销与装配回执合并清算；
   * 回执编号相同但内容哈希变化时扣留并暂停清算，等待人工复核。
   */
  acceptReceipt({ business_key, receipt_id, source = "offline", content_hash, amount = 0, at = nowIso() }) {
    if (!content_hash) throw new BusinessRuleError("回执必须携带内容哈希 content_hash");
    const s = this.state();
    const clearance = s.clearances.get(business_key);
    const existing = clearance?.receipts.find((r) => r.receipt_id === receipt_id);
    const held = clearance?.held_receipts.find((r) => r.receipt_id === receipt_id);

    if (existing && existing.content_hash === content_hash) return "duplicate";
    if (held && held.content_hash === content_hash) return "duplicate";

    const b = eventBatch(this.store, at);
    if (existing || held) {
      b.add("FULFILLMENT_RECEIPT_HELD", "clearance_batch", business_key, {
        summary: `回执 ${receipt_id} 编号相同但内容变化，扣留待核`,
        business_key, receipt_id, source, content_hash,
        existing_receipt_id: receipt_id,
      }, "receipt-held");
      if (!clearance || clearance.status !== "paused") {
        b.add("CLEARANCE_PAUSED", "clearance_batch", business_key, {
          summary: `清算批次 ${business_key} 因回执 ${receipt_id} 同号异容暂停`,
          business_key, reason: `回执 ${receipt_id} 内容哈希不一致`,
        }, "pause");
      }
      b.commit();
      return "held";
    }

    b.add("FULFILLMENT_RECEIPT_ACCEPTED", "clearance_batch", business_key, {
      summary: `回执 ${receipt_id}（${source}）并入清算批次 ${business_key}`,
      business_key, receipt_id, source, content_hash, amount,
    }, "receipt");
    b.commit();
    return "accepted";
  }

  resolveHeldReceipt({ business_key, receipt_id, decision, by, reason = null, amount = 0, at = nowIso() }) {
    if (!["replaced", "discarded"].includes(decision)) throw new BusinessRuleError("decision 只能是 replaced 或 discarded");
    const s = this.state();
    const clearance = require(s.clearances, business_key, "清算批次");
    const held = clearance.held_receipts.find((r) => r.receipt_id === receipt_id && !r.resolved);
    if (!held) throw new BusinessRuleError(`清算批次 ${business_key} 下没有待处置的扣留回执 ${receipt_id}`);
    const otherUnresolved = clearance.held_receipts.some(
      (r) => !r.resolved && r.receipt_id !== receipt_id
    );

    const b = eventBatch(this.store, at);
    b.add("HELD_RECEIPT_RESOLVED", "clearance_batch", business_key, {
      summary: `扣留回执 ${receipt_id} 经 ${by} 判定为 ${decision === "replaced" ? "以新内容替换" : "废弃"}`,
      business_key, receipt_id, decision, by, reason,
      amount: decision === "replaced" ? amount : 0,
    }, "held-resolved");
    // 仅当这是最后一张未处置扣留时才恢复清算；其余扣留仍在则保持暂停。
    if (clearance.status === "paused" && !otherUnresolved) {
      b.add("CLEARANCE_RESUMED", "clearance_batch", business_key, {
        summary: `全部扣留回执处置完毕，清算批次 ${business_key} 恢复`,
        business_key, by, reason: "全部扣留回执已处置",
      }, "resume");
    }
    b.commit();
  }

  settleClearance({ business_key, total_amount, at = nowIso() }) {
    const s = this.state();
    const clearance = require(s.clearances, business_key, "清算批次");
    if (clearance.status === "settled") {
      throw new BusinessRuleError(`清算批次 ${business_key} 已结算，不能重复清算`);
    }
    if (clearance.status === "paused") {
      throw new BusinessRuleError(`清算批次 ${business_key} 处于暂停状态（${clearance.pause_reasons.at(-1)?.reason ?? ""}），不能清算`);
    }
    const unresolvedHeld = clearance.held_receipts.filter((r) => !r.resolved);
    if (unresolvedHeld.length > 0 && clearance.status !== "settled") {
      throw new BusinessRuleError(`清算批次 ${business_key} 存在 ${unresolvedHeld.length} 张未处置扣留回执，不能清算`);
    }
    const acceptedTotal = clearance.receipts.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    const b = eventBatch(this.store, at);
    b.add("CLEARANCE_SETTLED", "clearance_batch", business_key, {
      summary: `清算批次 ${business_key} 完成清算，入账 ${total_amount}（已合并回执 ${clearance.receipts.length} 张）`,
      business_key, total_amount, accepted_total: acceptedTotal,
    }, "settle");
    b.commit();
  }

  // ---------- 合作方责任与补偿 ----------

  assignLiability({ liability_id, partner_id, basis, plan_id = null, commitment_id = null, box_id = null, share = null, amount = null, at = nowIso() }) {
    const b = eventBatch(this.store, at);
    b.add("LIABILITY_ASSIGNED", "partner_liability", liability_id, {
      summary: `合作方 ${partner_id} 承担补偿责任：${basis}`,
      liability_id, partner_id, basis, plan_id, commitment_id, box_id, share, amount,
    }, "liability");
    b.commit();
  }

  completeRemedy({ liability_id, note, at = nowIso() }) {
    const s = this.state();
    require(s.liabilities, liability_id, "合作方责任");
    const b = eventBatch(this.store, at);
    b.add("REMEDY_COMPLETED", "partner_liability", liability_id, {
      summary: `责任 ${liability_id} 补偿完成：${note}`,
    }, "remedy");
    b.commit();
  }

  // ---------- 活动结束后的解释视图 ----------

  /**
   * 解释一个礼盒：实际装入了什么、采用哪版标签、额度如何变化、谁承担补偿。
   */
  explainBox(box_id) {
    const s = this.state();
    const box = require(s.boxes, box_id, "礼盒");
    const commitment = require(s.commitments, box.commitment_id, "组合承诺");
    const label = require(s.labels, box.label_id, "标签快照");

    const packedDetail = box.packed.map((p) => {
      const lot = require(s.lots, p.lot_id, "组件批次");
      return {
        lot_id: p.lot_id, component: lot.component, partner_id: lot.partner_id,
        partner_name: lot.partner_name, qty: p.qty,
      };
    });

    // 直接从额度台账抽取与该承诺相关的全部变动；核销条目只计入本盒。
    const quotaChanges = [];
    for (const quota of s.quotas.values()) {
      for (const entry of quota.ledger) {
        if (entry.commitment_id !== commitment.commitment_id) continue;
        if (entry.kind === "assemble" && entry.box_id && entry.box_id !== box_id) continue;
        quotaChanges.push({ at: entry.at, quota_id: quota.quota_id, channel_id: quota.channel_id, kind: entry.kind, delta: entry.delta, plan_id: entry.plan_id });
      }
    }
    quotaChanges.sort((a, z) => a.at.localeCompare(z.at));

    const liabilities = [...s.liabilities.values()].filter(
      (l) => l.box_id === box_id || l.commitment_id === commitment.commitment_id
    ).map((l) => ({
      liability_id: l.liability_id, partner_id: l.partner_id, basis: l.basis,
      share: l.share, amount: l.amount, status: l.status,
      remedy: l.remedy, plan_id: l.plan_id,
    }));

    return {
      box: {
        box_id: box.box_id,
        assembled_at: box.assembled_at,
        claimed: box.claimed,
        claimed_at: box.claimed_at,
        assembly_id: box.assembly_id,
        packed: packedDetail,
        label: { label_id: label.label_id, label_version: label.label_version, allergens: label.allergens, content_hash: label.content_hash },
      },
      commitment: {
        commitment_id: commitment.commitment_id,
        channel_id: commitment.channel_id,
        channel_kind: commitment.channel_kind,
        status: commitment.status,
        promised_quantity: commitment.quantity,
        assembled_quantity: commitment.assembled,
        history: commitment.history,
      },
      quota_changes: quotaChanges,
      impact_notices: box.notices,
      liabilities,
    };
  }
}

// ---------------- 辅助函数 ----------------

function diffComponents(from, to, units, mode) {
  const fromMap = new Map(from.map((c) => [c.lot_id, c.qty]));
  const toMap = new Map(to.map((c) => [c.lot_id, c.qty]));
  const out = [];
  for (const [lotId, qty] of toMap) {
    const delta = qty - (fromMap.get(lotId) ?? 0);
    if (mode === "acquire" && delta > 0) out.push({ lot_id: lotId, qty: delta * units });
  }
  for (const [lotId, qty] of fromMap) {
    const delta = qty - (toMap.get(lotId) ?? 0);
    if (mode === "release" && delta > 0) out.push({ lot_id: lotId, qty: delta * units });
  }
  return out;
}

function assertAllergensCovered(s, components, label, scope) {
  const required = new Set();
  for (const c of components) {
    const lot = s.lots.get(c.lot_id);
    for (const a of lot?.allergens ?? []) required.add(a);
  }
  const declared = new Set(label.allergens);
  const missing = [...required].filter((a) => !declared.has(a));
  if (missing.length > 0) {
    throw new BusinessRuleError(`${scope} 的标签 ${label.label_id} 未声明过敏原：${missing.join("、")}`);
  }
}

function allergensAdded(s, fromLabelId, toLabelId) {
  if (fromLabelId === toLabelId) return [];
  const a = new Set(s.labels.get(toLabelId)?.allergens ?? []);
  const before = new Set(s.labels.get(fromLabelId)?.allergens ?? []);
  return [...a].filter((x) => !before.has(x));
}

function findQuota(s, channelId, assemblyId) {
  for (const q of s.quotas.values()) {
    if (q.channel_id === channelId && q.assembly_id === assemblyId) return q;
  }
  return null;
}

function assertOpen(plan) {
  if (plan.status !== "proposed") throw new BusinessRuleError(`方案 ${plan.plan_id} 已执行，不能再变更审批`);
}

function require(map, id, label) {
  const v = map.get(id);
  if (!v) throw new BusinessRuleError(`${label}不存在：${id}`);
  return v;
}

function channelLabel(kind) {
  return { stall: "线下摊位", groupbuy: "团购", charity: "公益赠送" }[kind] ?? kind;
}

function hashOf(obj) {
  const str = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(16)}`;
}

function nowIso() {
  return new Date().toISOString();
}
