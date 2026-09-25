// 活动结束后的解释查询：只读事件日志，回答
// 「每个礼盒实际装入什么、采用哪版标签、额度如何变化、谁承担补偿」。

/** 某个礼盒的实物事实：装配版本、实际装入的批次与数量、标签版本、是否已核销。 */
export function explainBox(events, box_id) {
  const assembled = events.find((e) => e.event_type === "BOX_ASSEMBLED" && e.payload.box_id === box_id);
  if (!assembled) return null;
  const redeemed = events.find((e) => e.event_type === "BOX_REDEEMED" && e.payload.box_id === box_id);
  const p = assembled.payload;
  return {
    box_id,
    commitment_id: p.commitment_id,
    assembly: p.assembly_key,
    items: p.items.map((i) => ({ ...i })),
    label: p.label_key,
    assembled_at: assembled.occurred_at,
    redeemed: Boolean(redeemed),
    redeemed_at: redeemed?.occurred_at ?? null,
  };
}

/** 某条组合承诺的完整履历：原始与当前装配版本、标签版本链、迁移、通知与状态。 */
export function explainCommitment(events, commitment_id) {
  const related = events.filter(
    (e) => e.aggregate_type === "customer_order" && e.aggregate_id === commitment_id,
  );
  const reserved = related.find((e) => e.event_type === "ORDER_RESERVED");
  if (!reserved) return null;
  const originalAssembly = `${reserved.payload.assembly_id}@${reserved.payload.assembly_version}`;
  const originalLabel = `${reserved.payload.label_id}@${reserved.payload.label_version}`;
  const migrations = related
    .filter((e) => e.event_type === "COMMITMENT_MIGRATED")
    .map((e) => ({
      plan_id: e.payload.plan_id,
      from_assembly: e.payload.from_assembly_key,
      to_assembly: e.payload.to_assembly_key,
      from_label: e.payload.from_label_key,
      to_label: e.payload.to_label_key,
      quantity: e.payload.quantity,
      at: e.occurred_at,
    }));
  const notifications = related
    .filter((e) => e.event_type === "IMPACT_NOTIFICATION_APPENDED")
    .map((e) => ({ ...e.payload, at: e.occurred_at }));
  const fulfilled = related
    .filter((e) => e.event_type === "COMMITMENT_FULFILLED")
    .reduce((n, e) => n + e.payload.quantity, 0);
  const frozen = related.some((e) => e.event_type === "COMMITMENT_FROZEN");
  return {
    commitment_id,
    channel_id: reserved.payload.channel_id,
    quantity: reserved.payload.quantity,
    fulfilled,
    status: frozen ? "frozen" : fulfilled >= reserved.payload.quantity ? "fulfilled" : fulfilled > 0 ? "partially_fulfilled" : "reserved",
    original_assembly: originalAssembly,
    current_assembly: migrations.length ? migrations[migrations.length - 1].to_assembly : originalAssembly,
    label_history: [originalLabel, ...migrations.map((m) => m.to_label)],
    migrations,
    notifications,
    timeline: related.map((e) => ({ event_type: e.event_type, at: e.occurred_at, summary: e.summary })),
  };
}

/** 某渠道的额度台账：总额、预留、核销及逐笔变动（含原因与关联单号）。 */
export function explainQuota(events, channel_id) {
  const moves = events.filter(
    (e) => e.aggregate_type === "channel_quota" && e.aggregate_id === channel_id,
  );
  if (moves.length === 0) return null;
  let total = 0;
  let reserved = 0;
  let consumed = 0;
  let kind;
  const movements = [];
  for (const e of moves) {
    const p = e.payload;
    switch (e.event_type) {
      case "CHANNEL_QUOTA_CONFIGURED":
        total = p.total;
        kind = p.kind;
        break;
      case "CHANNEL_QUOTA_RESERVED":
        reserved += p.quantity;
        break;
      case "CHANNEL_QUOTA_RELEASED":
        reserved -= p.quantity;
        break;
      case "CHANNEL_QUOTA_CONSUMED":
        reserved -= p.quantity;
        consumed += p.quantity;
        break;
      case "CHANNEL_QUOTA_TRANSFERRED":
        total += p.direction === "out" ? -p.quantity : p.quantity;
        break;
      default:
        break;
    }
    movements.push({
      event_type: e.event_type,
      quantity: p.quantity ?? null,
      reason: p.reason ?? "",
      ref: p.ref ?? p.counterparty ?? "",
      at: e.occurred_at,
      balance: { total, reserved, consumed },
    });
  }
  return { channel_id, kind, total, reserved, consumed, movements };
}

/** 合作方责任台账：按合作方归集补偿责任（缺货、检测不合格等起因）。 */
export function explainLiabilities(events) {
  const byPartner = {};
  for (const e of events) {
    if (e.event_type !== "LIABILITY_ASSIGNED") continue;
    const { partner_id, cause, ref, detail } = e.payload;
    (byPartner[partner_id] ??= []).push({ cause, ref, detail, at: e.occurred_at });
  }
  return byPartner;
}
