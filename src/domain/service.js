import { validateEvent } from "../validator.js";
import { applyEvent, assemblyKey, initialState, labelKey } from "./state.js";

// 组合承诺与重组服务。
// 所有状态变更都以追加事件完成；一批相关变更先整体校验再整体落账，
// 保证「旧组件原子释放、新组件原子占用」，不会留下半迁移状态。

class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let seq = 0;

export class FulfillmentService {
  constructor({ clock } = {}) {
    this.events = [];
    this.state = initialState();
    this.versions = new Map();
    this.clock = clock ?? (() => new Date().toISOString());
  }

  append(event_type, aggregate_type, aggregate_id, payload, summary, occurred_at) {
    const version = (this.versions.get(aggregate_id) ?? 0) + 1;
    const event = {
      event_id: `evt-${String(++seq).padStart(5, "0")}`,
      event_type,
      aggregate_type,
      aggregate_id,
      occurred_at: occurred_at ?? this.clock(),
      version,
      summary,
      payload,
    };
    const errors = validateEvent(event);
    if (errors.length) throw new DomainError("INVALID_EVENT", errors.join("；"));
    this.events.push(event);
    applyEvent(this.state, event);
    this.versions.set(aggregate_id, version);
    return event;
  }

  // ---- 基础登记 ----

  acceptComponentLot({ lot_id, partner_id, kind, name, quantity, allergens = [] }) {
    if (this.state.lots[lot_id]) throw new DomainError("LOT_EXISTS", `组件批次已存在：${lot_id}`);
    return this.append(
      "COMPONENT_ACCEPTED",
      "component_lot",
      lot_id,
      { lot_id, partner_id, kind, name, quantity, allergens },
      `登记组件批次 ${lot_id}（${name}）${quantity} 件，供应方 ${partner_id}`,
    );
  }

  recordInspection({ lot_id, status, allergens, note = "", inspector = "" }) {
    this.#requireLot(lot_id);
    return this.append(
      "COMPONENT_INSPECTION_RECORDED",
      "component_lot",
      lot_id,
      { lot_id, status, allergens, note, inspector },
      `组件批次 ${lot_id} 检测结论更新为 ${status}`,
    );
  }

  declareShortage({ lot_id, remaining = 0, cause = "" }) {
    this.#requireLot(lot_id);
    return this.append(
      "COMPONENT_SHORTAGE_DECLARED",
      "component_lot",
      lot_id,
      { lot_id, remaining, cause },
      `组件批次 ${lot_id} 宣告缺货，实物剩余 ${remaining}`,
    );
  }

  publishLabel({ label_id, version, allergens = [], lines = [] }) {
    const key = labelKey(label_id, version);
    if (this.state.labels[key]) throw new DomainError("LABEL_EXISTS", `标签快照已存在：${key}`);
    return this.append(
      "LABEL_SNAPSHOT_PUBLISHED",
      "label_snapshot",
      key,
      { label_id, version, allergens, lines },
      `发布标签快照 ${key}，过敏原：${allergens.join("、") || "无"}`,
    );
  }

  publishAssembly({ assembly_id, version, items, label_id, label_version }) {
    const key = assemblyKey(assembly_id, version);
    if (this.state.assemblies[key]) throw new DomainError("ASSEMBLY_EXISTS", `装配版本已存在：${key}`);
    if (!this.state.labels[labelKey(label_id, label_version)]) {
      throw new DomainError("LABEL_MISSING", `装配引用的标签快照不存在：${labelKey(label_id, label_version)}`);
    }
    for (const item of items) this.#requireLot(item.lot_id);
    this.append(
      "ASSEMBLY_VERSION_PUBLISHED",
      "assembly_version",
      key,
      { assembly_id, version, items, label_id, label_version },
      `发布装配版本 ${key}，采用标签 ${labelKey(label_id, label_version)}`,
    );
    return this.append("BUNDLE_RELEASED", "bundle_batch", assembly_id, { assembly_id, version }, `组合 ${assembly_id} 第 ${version} 版放行`);
  }

  configureChannelQuota({ channel_id, kind, total }) {
    if (!["commercial", "public_welfare"].includes(kind)) {
      throw new DomainError("BAD_CHANNEL_KIND", "渠道类型必须是 commercial 或 public_welfare");
    }
    return this.append(
      "CHANNEL_QUOTA_CONFIGURED",
      "channel_quota",
      channel_id,
      { channel_id, kind, total },
      `配置${kind === "public_welfare" ? "公益" : "商业"}渠道 ${channel_id} 额度 ${total}`,
    );
  }

  // ---- 组合承诺 ----

  reserveCommitment({ commitment_id, channel_id, assembly_id, assembly_version, quantity }) {
    const aKey = assemblyKey(assembly_id, assembly_version);
    const assembly = this.state.assemblies[aKey];
    if (!assembly) throw new DomainError("ASSEMBLY_MISSING", `装配版本不存在：${aKey}`);
    const quota = this.state.quotas[channel_id];
    if (!quota) throw new DomainError("CHANNEL_MISSING", `渠道未配置额度：${channel_id}`);
    if (quota.total - quota.reserved - quota.consumed < quantity) {
      throw new DomainError("QUOTA_EXCEEDED", `渠道 ${channel_id} 剩余额度不足，无法承诺 ${quantity} 份`);
    }
    this.#assertLotsAvailable(assembly.items, quantity, `承诺 ${commitment_id}`);

    this.append("CHANNEL_QUOTA_RESERVED", "channel_quota", channel_id, {
      channel_id,
      quantity,
      reason: "commitment",
      ref: commitment_id,
    }, `渠道 ${channel_id} 为承诺 ${commitment_id} 预留 ${quantity} 份额度`);
    for (const item of assembly.items) {
      this.append("COMPONENT_RESERVATION_ACQUIRED", "component_lot", item.lot_id, {
        lot_id: item.lot_id,
        quantity: item.quantity * quantity,
        reason: "commitment",
        ref: commitment_id,
      }, `组件批次 ${item.lot_id} 为承诺 ${commitment_id} 预留 ${item.quantity * quantity} 件`);
    }
    const label = this.state.labels[assembly.label_key];
    return this.append("ORDER_RESERVED", "customer_order", commitment_id, {
      commitment_id,
      channel_id,
      assembly_id,
      assembly_version,
      label_id: label.label_id,
      label_version: label.version,
      quantity,
    }, `渠道 ${channel_id} 按 ${aKey} / 标签 ${assembly.label_key} 承诺 ${quantity} 份`);
  }

  assembleBox({ box_id, commitment_id }) {
    if (this.state.boxes[box_id]) throw new DomainError("BOX_EXISTS", `礼盒已存在：${box_id}`);
    const c = this.#requireCommitment(commitment_id);
    if (["frozen"].includes(c.status)) throw new DomainError("COMMITMENT_FROZEN", `承诺已冻结，不能装配：${commitment_id}`);
    if (c.fulfilled >= c.quantity) throw new DomainError("COMMITMENT_DONE", `承诺已全部履约：${commitment_id}`);
    const assembly = this.state.assemblies[c.assembly_key];
    // 装配前再核一次实物可用量；不足则交由重组流程，不允许私自替换组件。
    this.#assertLotsAvailable(assembly.items, 1, `礼盒 ${box_id}`);

    const items = assembly.items.map((i) => ({ lot_id: i.lot_id, quantity: i.quantity }));
    for (const item of assembly.items) {
      this.append("COMPONENT_RESERVATION_CONSUMED", "component_lot", item.lot_id, {
        lot_id: item.lot_id,
        quantity: item.quantity,
        ref: box_id,
      }, `组件批次 ${item.lot_id} 由礼盒 ${box_id} 实际消耗 ${item.quantity} 件`);
    }
    this.append("CHANNEL_QUOTA_CONSUMED", "channel_quota", c.channel_id, {
      channel_id: c.channel_id,
      quantity: 1,
      ref: box_id,
    }, `渠道 ${c.channel_id} 因礼盒 ${box_id} 核销 1 份额度`);
    this.append("COMMITMENT_FULFILLED", "customer_order", commitment_id, {
      commitment_id,
      quantity: 1,
      box_id,
    }, `承诺 ${commitment_id} 履约 1 份（礼盒 ${box_id}）`);
    return this.append("BOX_ASSEMBLED", "bundle_unit", box_id, {
      box_id,
      commitment_id,
      assembly_key: c.assembly_key,
      label_key: c.label_key,
      items,
    }, `礼盒 ${box_id} 按 ${c.assembly_key} 完成装配，标签 ${c.label_key}`);
  }

  redeemBox({ box_id, at }) {
    const box = this.state.boxes[box_id];
    if (!box) throw new DomainError("BOX_MISSING", `礼盒不存在：${box_id}`);
    if (box.redeemed) throw new DomainError("BOX_REDEEMED", `礼盒已核销：${box_id}`);
    // 离线核销可携带设备端原始时间，保持事实发生时刻不失真。
    return this.append("BOX_REDEEMED", "bundle_unit", box_id, { box_id }, `礼盒 ${box_id} 离线核销，保持 ${box.assembly_key} 装配事实`, at);
  }

  // ---- 重组流程 ----

  /**
   * 缺货或检测结论变化后生成可重组方案：
   * 找出当前装配版本受影响、且尚有未履约数量的承诺，按渠道路由选择替代装配并逐条给出可行性。
   * alternatives 给出一个或多个替代装配；routes 可按渠道指定路由（如公益渠道专用替代方案），
   * 未命中路由的承诺按 alternatives 顺序挑选第一个可行方案；都不可行则该组合标记 blocked。
   * 已全部履约的承诺不迁移（其礼盒保持原装配事实，执行时只追加通知）。
   */
  proposeReorganization({ plan_id, trigger, alternatives, routes = [] }) {
    if (this.state.plans[plan_id]) throw new DomainError("PLAN_EXISTS", `重组方案已存在：${plan_id}`);
    if (!Array.isArray(alternatives) || alternatives.length === 0) {
      throw new DomainError("BAD_ALTERNATIVES", "至少需要一个替代装配");
    }
    const targets = alternatives.map((a) => {
      const key = assemblyKey(a.assembly_id, a.assembly_version);
      const assembly = this.state.assemblies[key];
      if (!assembly) throw new DomainError("ASSEMBLY_MISSING", `替代装配版本不存在：${key}`);
      if (!this.state.labels[assembly.label_key]) {
        throw new DomainError("LABEL_MISSING", `替代装配缺少标签快照：${assembly.label_key}`);
      }
      return { key, assembly };
    });
    const affectedLot = trigger.lot_id;
    if (!["shortage", "inspection"].includes(trigger.type)) {
      throw new DomainError("BAD_TRIGGER", "重组触发类型必须是 shortage 或 inspection");
    }

    // 候选承诺：未冻结、未履约完、当前装配含受影响批次。
    const candidates = Object.values(this.state.commitments).filter(
      (c) => c.status !== "frozen" && c.fulfilled < c.quantity &&
        this.state.assemblies[c.assembly_key].items.some((i) => i.lot_id === affectedLot),
    );

    // 按承诺逐条顺序模拟「释放旧预留 → 占用新预留」，与执行口径一致，
    // 使多个组合争用同一替代批次时可行性结论真实可信。
    const projected = {};
    const items = candidates.map((c) => {
      const outstanding = c.quantity - c.fulfilled;
      const oldAssembly = this.state.assemblies[c.assembly_key];
      const route = routes.find((r) => r.channel_ids.includes(c.channel_id));
      const ordered = route
        ? [
            targets.find((t) => t.key === assemblyKey(route.assembly_id, route.assembly_version)),
            ...targets,
          ].filter((t, i, arr) => t && arr.findIndex((x) => x.key === t.key) === i)
        : targets;

      let chosen = null;
      const tried = [];
      for (const target of ordered) {
        const trial = { ...projected };
        for (const comp of oldAssembly.items) {
          if (!this.state.lots[comp.lot_id].depleted) {
            trial[comp.lot_id] = (trial[comp.lot_id] ?? this.state.lots[comp.lot_id].available) + comp.quantity * outstanding;
          }
        }
        let ok = true;
        for (const comp of target.assembly.items) {
          trial[comp.lot_id] = (trial[comp.lot_id] ?? this.state.lots[comp.lot_id].available) - comp.quantity * outstanding;
          if (trial[comp.lot_id] < 0) {
            ok = false;
            tried.push(`${target.key}：${comp.lot_id} 不足`);
            break;
          }
        }
        if (ok) {
          chosen = target;
          Object.assign(projected, trial);
          break;
        }
      }

      const partners = chosen
        ? [...new Set(chosen.assembly.items.map((i) => this.state.lots[i.lot_id].partner_id))]
        : [];
      return {
        item_id: `${plan_id}-item-${c.commitment_id}`,
        commitment_id: c.commitment_id,
        channel_id: c.channel_id,
        quantity: outstanding,
        from_assembly_key: c.assembly_key,
        to_assembly_key: chosen?.key ?? null,
        to_label_key: chosen?.assembly.label_key ?? null,
        partners,
        feasible: Boolean(chosen),
        blocked_reason: chosen ? "" : tried.join("；"),
      };
    });

    return this.append("REORGANIZATION_PROPOSED", "reorganization_plan", plan_id, {
      plan_id,
      trigger,
      items,
    }, `依据${trigger.type === "shortage" ? "缺货" : "检测结论变化"}（${affectedLot}）提出重组方案 ${plan_id}，涉及 ${items.length} 条承诺`);
  }

  confirmLabel({ plan_id, confirmed_by }) {
    const plan = this.#requirePlan(plan_id);
    if (plan.label_confirmed) throw new DomainError("ALREADY_CONFIRMED", "标签已经过食品负责人确认");
    // 食品负责人确认的是替换装配标签快照的过敏原说明真实有效（仅核对可执行组合）。
    for (const item of plan.items) {
      if (item.status !== "pending") continue;
      if (!this.state.labels[item.to_label_key]) {
        throw new DomainError("LABEL_MISSING", `标签快照不存在：${item.to_label_key}`);
      }
    }
    return this.append("REORGANIZATION_LABEL_CONFIRMED", "reorganization_plan", plan_id, {
      plan_id,
      confirmed_by,
    }, `食品负责人 ${confirmed_by} 确认方案 ${plan_id} 的替换标签过敏原说明`);
  }

  /**
   * 渠道负责人确认配额。可随确认提交渠道间额度划转；
   * 公益保留量受硬保护：禁止从公益渠道向商业渠道划出，
   * 且任何划出都不能使渠道低于已预留+已履约数量。
   */
  confirmQuota({ plan_id, confirmed_by, transfers = [] }) {
    const plan = this.#requirePlan(plan_id);
    if (plan.quota_confirmed) throw new DomainError("ALREADY_CONFIRMED", "配额已经渠道负责人确认");
    for (const t of transfers) {
      const from = this.state.quotas[t.from_channel_id];
      const to = this.state.quotas[t.to_channel_id];
      if (!from || !to) throw new DomainError("CHANNEL_MISSING", "划转涉及的渠道不存在");
      if (from.kind === "public_welfare" && to.kind === "commercial") {
        throw new DomainError("WELFARE_PROTECTED", "公益保留量不得划转给商业渠道");
      }
      if (from.total - t.quantity < from.reserved + from.consumed) {
        throw new DomainError("QUOTA_EXCEEDED", `渠道 ${t.from_channel_id} 划出后低于已承诺数量`);
      }
    }
    // 逐条复核方案内渠道剩余额度仍容纳未履约数量。
    const needByChannel = {};
    for (const item of plan.items) {
      if (item.status !== "pending") continue;
      needByChannel[item.channel_id] = (needByChannel[item.channel_id] ?? 0) + item.quantity;
    }
    for (const [channel_id, need] of Object.entries(needByChannel)) {
      const q = this.state.quotas[channel_id];
      if (q.total - q.reserved - q.consumed + need < need) {
        // 未履约数量本就占着该渠道预留，正常恒成立；显式校验防止额度被其他变更挪用。
        throw new DomainError("QUOTA_EXCEEDED", `渠道 ${channel_id} 额度已被占用，无法承接重组`);
      }
    }
    for (const t of transfers) {
      this.append("CHANNEL_QUOTA_TRANSFERRED", "channel_quota", t.from_channel_id, {
        channel_id: t.from_channel_id,
        direction: "out",
        quantity: t.quantity,
        counterparty: t.to_channel_id,
        reason: "reorganization",
        ref: plan_id,
      }, `渠道 ${t.from_channel_id} 向 ${t.to_channel_id} 划出 ${t.quantity} 份额度`);
      this.append("CHANNEL_QUOTA_TRANSFERRED", "channel_quota", t.to_channel_id, {
        channel_id: t.to_channel_id,
        direction: "in",
        quantity: t.quantity,
        counterparty: t.from_channel_id,
        reason: "reorganization",
        ref: plan_id,
      }, `渠道 ${t.to_channel_id} 接收 ${t.from_channel_id} 划入 ${t.quantity} 份额度`);
    }
    return this.append("REORGANIZATION_QUOTA_CONFIRMED", "reorganization_plan", plan_id, {
      plan_id,
      confirmed_by,
    }, `渠道负责人 ${confirmed_by} 确认方案 ${plan_id} 的渠道配额`);
  }

  /** 合作方拒绝参与：只冻结由该合作方供货的受影响组合，其余组合仍可执行。 */
  partnerRefuse({ plan_id, partner_id, reason = "" }) {
    const plan = this.#requirePlan(plan_id);
    const frozenItems = plan.items.filter(
      (i) => i.status === "pending" && i.partners.includes(partner_id),
    );
    if (!frozenItems.length) {
      throw new DomainError("NO_AFFECTED_ITEM", `合作方 ${partner_id} 与方案中待执行组合无关`);
    }
    const frozenIds = frozenItems.map((i) => i.item_id);
    this.append("REORGANIZATION_PARTNER_REFUSED", "reorganization_plan", plan_id, {
      plan_id,
      partner_id,
      reason,
      frozen_item_ids: frozenIds,
    }, `合作方 ${partner_id} 拒绝方案 ${plan_id}，冻结 ${frozenIds.length} 个受影响组合`);
    for (const item of frozenItems) this.#freezeItem(plan_id, item, { partner_id, reason });
    return this.state.plans[plan_id];
  }

  /** 执行重组：标签与配额双确认齐备后，原子释放旧组件、占用新组件并迁移承诺。 */
  executeReorganization({ plan_id }) {
    const plan = this.#requirePlan(plan_id);
    if (!plan.label_confirmed) throw new DomainError("LABEL_UNCONFIRMED", "缺少食品负责人的标签确认");
    if (!plan.quota_confirmed) throw new DomainError("QUOTA_UNCONFIRMED", "缺少渠道负责人的配额确认");
    if (!plan.items.some((i) => i.status === "pending")) {
      throw new DomainError("NO_PENDING_ITEM", "方案中没有可执行的组合");
    }

    // 逐条按当前真实状态处理：可行则原子迁移；
    // 情况变化导致净占用不足的组合只冻结自身（#freezeItem 同样只释放该组合的预留），
    // 不阻断其余组合，且任何组合都不会出现旧组件已释放而新组件未占住的半迁移。
    for (const item of plan.items) {
      if (item.status !== "pending") continue;
      const shortageLot = this.#firstInsufficientLot(item);
      if (shortageLot) {
        const { lot_id, short } = shortageLot;
        this.#freezeItem(plan_id, item, {
          partner_id: this.state.lots[lot_id].partner_id,
          reason: `执行时组件 ${lot_id} 不足 ${short} 件`,
        });
      } else {
        this.#migrateItem(plan_id, item);
      }
    }
    return this.state.plans[plan_id];
  }

  /** 模拟单组合「释放旧预留 → 占用新预留」的净效应，返回第一个不足的批次。 */
  #firstInsufficientLot(item) {
    const c = this.state.commitments[item.commitment_id];
    const oldAssembly = this.state.assemblies[item.from_assembly_key];
    const newAssembly = this.state.assemblies[item.to_assembly_key];
    const n = item.quantity;
    const simulated = {};
    for (const comp of oldAssembly.items) {
      if (!this.state.lots[comp.lot_id].depleted) {
        simulated[comp.lot_id] = (simulated[comp.lot_id] ?? this.state.lots[comp.lot_id].available) + comp.quantity * n;
      }
    }
    for (const comp of newAssembly.items) {
      const left = (simulated[comp.lot_id] ?? this.state.lots[comp.lot_id].available) - comp.quantity * n;
      if (left < 0) return { lot_id: comp.lot_id, short: -left };
      simulated[comp.lot_id] = left;
    }
    return null;
  }

  #migrateItem(plan_id, item) {
    const c = this.state.commitments[item.commitment_id];
    const oldAssembly = this.state.assemblies[item.from_assembly_key];
    const newAssembly = this.state.assemblies[item.to_assembly_key];
    const n = item.quantity;
    // 迁移前留存旧标签引用：COMMITMENT_MIGRATED 落账后承诺即指向新标签。
    const oldLabelKey = c.label_key;

    // 原子性预检：先模拟「释放旧预留 → 占用新预留」后的批次余量，
    // 任一组件不足则整组不落任何事件，杜绝旧组件已释放而新组件未占住的半迁移。
    const simulated = {};
    for (const comp of oldAssembly.items) {
      if (!this.state.lots[comp.lot_id].depleted) {
        simulated[comp.lot_id] = (simulated[comp.lot_id] ?? this.state.lots[comp.lot_id].available) + comp.quantity * n;
      }
    }
    for (const comp of newAssembly.items) {
      const left = (simulated[comp.lot_id] ?? this.state.lots[comp.lot_id].available) - comp.quantity * n;
      if (left < 0) {
        throw new DomainError("LOT_INSUFFICIENT", `组件 ${comp.lot_id} 可用量不足，组合 ${c.commitment_id} 未迁移`);
      }
      simulated[comp.lot_id] = left;
    }

    // 预检通过后落账：同一事件批次内先释放旧预留、再占用新预留。
    for (const comp of oldAssembly.items) {
      this.append("COMPONENT_RESERVATION_RELEASED", "component_lot", comp.lot_id, {
        lot_id: comp.lot_id,
        quantity: comp.quantity * n,
        reason: "reorganization_release",
        ref: plan_id,
      }, `方案 ${plan_id} 释放承诺 ${c.commitment_id} 在旧批次 ${comp.lot_id} 的预留 ${comp.quantity * n} 件`);
    }
    for (const comp of newAssembly.items) {
      const lot = this.state.lots[comp.lot_id];
      if (lot.available < comp.quantity * n) {
        // 防御性兜底：单组合口径不足时不允许半迁移（本应由执行前整体校验拦截）。
        throw new DomainError("LOT_INSUFFICIENT", `组件 ${comp.lot_id} 可用量不足，组合 ${c.commitment_id} 未迁移`);
      }
      this.append("COMPONENT_RESERVATION_ACQUIRED", "component_lot", comp.lot_id, {
        lot_id: comp.lot_id,
        quantity: comp.quantity * n,
        reason: "reorganization_acquire",
        ref: plan_id,
      }, `方案 ${plan_id} 为承诺 ${c.commitment_id} 占用新批次 ${comp.lot_id} ${comp.quantity * n} 件`);
    }
    this.append("COMMITMENT_MIGRATED", "customer_order", c.commitment_id, {
      commitment_id: c.commitment_id,
      plan_id,
      from_assembly_key: item.from_assembly_key,
      to_assembly_key: item.to_assembly_key,
      from_label_key: c.label_key,
      to_label_key: item.to_label_key,
      quantity: n,
    }, `承诺 ${c.commitment_id} 的 ${n} 份未履约数量迁移到 ${item.to_assembly_key}`);

    // 过敏原差异通知：用迁移前留存的旧标签快照对比新快照。
    const oldAllergens = new Set(this.state.labels[oldLabelKey]?.allergens ?? []);
    const newAllergens = new Set(this.state.labels[item.to_label_key].allergens);
    const added = [...newAllergens].filter((a) => !oldAllergens.has(a));
    const removed = [...oldAllergens].filter((a) => !newAllergens.has(a));
    const delta = [
      added.length ? `新增过敏原：${added.join("、")}` : "",
      removed.length ? `移除过敏原：${removed.join("、")}` : "",
    ].filter(Boolean).join("；");
    this.append("IMPACT_NOTIFICATION_APPENDED", "customer_order", c.commitment_id, {
      commitment_id: c.commitment_id,
      audience: "待履约领取人",
      cause: "reorganization",
      message: `未履约的 ${n} 份改用 ${item.to_assembly_key} 装配，标签升级为 ${item.to_label_key}${delta ? `；${delta}` : ""}`,
    }, `向承诺 ${c.commitment_id} 的待领取人追加标签变更通知`);

    // 已领取礼盒保持原装配事实，仅按影响追加通知。
    if (c.fulfilled > 0) {
      this.append("IMPACT_NOTIFICATION_APPENDED", "customer_order", c.commitment_id, {
        commitment_id: c.commitment_id,
        audience: "已领取人",
        cause: "allergen_advisory",
        message: `您已领取的 ${c.fulfilled} 份礼盒维持 ${item.from_assembly_key} 原装配不变；${
          added.length ? `请注意原标签未声明的过敏原：${added.join("、")}。` : "本次检测变化不改变原礼盒过敏原结论。"
        }`,
      }, `向承诺 ${c.commitment_id} 的已领取人追加影响通知（原装配事实不变）`);
    }
    this.append("REORGANIZATION_ITEM_EXECUTED", "reorganization_plan", plan_id, {
      plan_id,
      item_id: item.item_id,
    }, `方案 ${plan_id} 的组合 ${c.commitment_id} 完成迁移`);
  }

  #freezeItem(plan_id, item, { partner_id, reason }) {
    const c = this.state.commitments[item.commitment_id];
    if (c.status === "frozen") return;
    const assembly = this.state.assemblies[c.assembly_key];
    const outstanding = c.quantity - c.fulfilled;
    // 冻结即退出原承诺：释放该承诺未履约部分的组件预留与渠道额度，便于其他组合使用。
    for (const comp of assembly.items) {
      this.append("COMPONENT_RESERVATION_RELEASED", "component_lot", comp.lot_id, {
        lot_id: comp.lot_id,
        quantity: comp.quantity * outstanding,
        reason: "commitment_frozen",
        ref: plan_id,
      }, `承诺 ${c.commitment_id} 冻结，释放批次 ${comp.lot_id} 预留 ${comp.quantity * outstanding} 件`);
    }
    this.append("CHANNEL_QUOTA_RELEASED", "channel_quota", c.channel_id, {
      channel_id: c.channel_id,
      quantity: outstanding,
      reason: "commitment_frozen",
      ref: plan_id,
    }, `承诺 ${c.commitment_id} 冻结，释放渠道 ${c.channel_id} 预留 ${outstanding} 份`);
    this.append("COMMITMENT_FROZEN", "customer_order", c.commitment_id, {
      commitment_id: c.commitment_id,
      plan_id,
      reason,
    }, `承诺 ${c.commitment_id} 因「${reason}」冻结，等待补偿处理`);
    this.append("LIABILITY_ASSIGNED", "partner_liability", partner_id, {
      partner_id,
      cause: reason,
      ref: plan_id,
      detail: { commitment_id: c.commitment_id, quantity: outstanding, channel_id: c.channel_id },
    }, `合作方 ${partner_id} 对承诺 ${c.commitment_id} 的 ${outstanding} 份承担补偿责任`);
    this.append("IMPACT_NOTIFICATION_APPENDED", "customer_order", c.commitment_id, {
      commitment_id: c.commitment_id,
      audience: "受影响领取人",
      cause: "commitment_frozen",
      message: `您的 ${outstanding} 份礼盒暂无法按原承诺交付，运营方将按合作方责任安排补偿。`,
    }, `向承诺 ${c.commitment_id} 的受影响领取人追加冻结与补偿通知`);
  }

  recordRemedy({ commitment_id, detail }) {
    const c = this.#requireCommitment(commitment_id);
    if (c.status !== "frozen") throw new DomainError("NOT_FROZEN", "只有冻结的承诺需要登记补偿完成");
    return this.append("REMEDY_COMPLETED", "customer_order", commitment_id, {
      commitment_id,
      detail,
    }, `承诺 ${commitment_id} 的补偿处理完成：${detail}`);
  }

  // ---- 离线回执与清算 ----

  /**
   * 提交离线核销/装配回执，按业务标识合并：
   * - 同一业务标识、内容一致：合并，进入可清算；
   * - 同一业务标识、内容改变：记录冲突并暂停清算，等待人工核对。
   */
  submitReceipt({ business_id, source, content }) {
    const existing = this.state.receipts[business_id];
    if (existing && (existing.status === "paused" || existing.status === "conflicted")) {
      throw new DomainError("RECEIPT_PAUSED", `回执 ${business_id} 清算已暂停，须人工核对后才能继续提交`);
    }
    this.append("RECEIPT_SUBMITTED", "fulfillment_receipt", business_id, {
      business_id,
      source,
      content,
    }, `收到来自 ${source} 的回执 ${business_id}`);

    if (!existing) {
      // 首个来源：按业务标识直接合并，进入可清算。
      this.append("RECEIPT_MERGED", "fulfillment_receipt", business_id, {
        business_id,
        sources: [source],
      }, `回执 ${business_id} 按业务标识合并 1 个来源，内容一致`);
      return this.state.receipts[business_id];
    }

    const first = existing.records[0].content;
    const differing = diffContent(first, content);
    if (differing.length) {
      this.append("RECEIPT_CONFLICT_DETECTED", "fulfillment_receipt", business_id, {
        business_id,
        differing_fields: differing,
      }, `回执 ${business_id} 编号相同但内容改变（${differing.join("、")}），记录冲突`);
      this.append("SETTLEMENT_PAUSED", "fulfillment_receipt", business_id, {
        business_id,
        reason: `内容不一致：${differing.join("、")}`,
      }, `回执 ${business_id} 清算暂停`);
      return this.state.receipts[business_id];
    }
    const sources = [...new Set([...existing.sources, source])];
    this.append("RECEIPT_MERGED", "fulfillment_receipt", business_id, {
      business_id,
      sources,
    }, `回执 ${business_id} 按业务标识合并 ${sources.length} 个来源，内容一致`);
    return this.state.receipts[business_id];
  }

  clearSettlement({ business_id, note = "" }) {
    const receipt = this.state.receipts[business_id];
    if (!receipt) throw new DomainError("RECEIPT_MISSING", `回执不存在：${business_id}`);
    if (receipt.status !== "paused" && receipt.status !== "conflicted") {
      throw new DomainError("SETTLEMENT_NOT_PAUSED", `回执 ${business_id} 未处于暂停状态`);
    }
    return this.append("SETTLEMENT_CLEARED", "fulfillment_receipt", business_id, {
      business_id,
      note,
    }, `回执 ${business_id} 经人工核对后恢复并完成清算：${note}`);
  }

  // ---- 内部校验 ----

  #requireLot(lot_id) {
    const lot = this.state.lots[lot_id];
    if (!lot) throw new DomainError("LOT_MISSING", `组件批次不存在：${lot_id}`);
    return lot;
  }

  #requireCommitment(commitment_id) {
    const c = this.state.commitments[commitment_id];
    if (!c) throw new DomainError("COMMITMENT_MISSING", `承诺不存在：${commitment_id}`);
    return c;
  }

  #requirePlan(plan_id) {
    const plan = this.state.plans[plan_id];
    if (!plan) throw new DomainError("PLAN_MISSING", `重组方案不存在：${plan_id}`);
    return plan;
  }

  #assertLotsAvailable(items, quantity, context) {
    for (const item of items) {
      const lot = this.#requireLot(item.lot_id);
      if (lot.available < item.quantity * quantity) {
        throw new DomainError("LOT_INSUFFICIENT", `${context} 需要批次 ${item.lot_id} ${item.quantity * quantity} 件，仅剩 ${lot.available}`);
      }
    }
  }
}

function diffContent(a, b) {
  const fields = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...fields].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]));
}

export { DomainError };
