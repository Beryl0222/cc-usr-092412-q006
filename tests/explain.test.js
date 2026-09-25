import assert from "node:assert/strict";
import test from "node:test";

import { explainBox, explainCommitment, explainLiabilities, explainQuota } from "../src/domain/index.js";
import { buildBaseService, fulfillStallBoxes, proposeStandard } from "./helpers.js";

test("活动结束后可解释：礼盒装什么、用哪版标签、额度如何变化、谁承担补偿", () => {
  const service = buildBaseService();
  fulfillStallBoxes(service, 2);
  service.redeemBox({ box_id: "box-1", at: "2026-09-25T11:00:00+08:00" });

  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0, cause: "作坊停产" });
  proposeStandard(service);
  service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-farm", reason: "燕麦批次无法追加" });
  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-1" });
  service.recordRemedy({ commitment_id: "cmt-welfare", detail: "公益机构改发等值礼包，农场承担差价" });

  // 每个礼盒实际装入什么、采用哪版标签。
  const box1 = explainBox(service.events, "box-1");
  assert.equal(box1.assembly, "gb-spring@1");
  assert.equal(box1.label, "label-gb@1");
  assert.deepEqual(box1.items, [
    { lot_id: "lot-badge", quantity: 1 },
    { lot_id: "lot-cookie-a", quantity: 2 },
    { lot_id: "lot-tea", quantity: 1 },
  ]);
  assert.equal(box1.redeemed, true);
  assert.equal(box1.redeemed_at, "2026-09-25T11:00:00+08:00");

  // 承诺履历：原始装配、迁移去向、标签版本链与通知。
  const stall = explainCommitment(service.events, "cmt-stall");
  assert.equal(stall.original_assembly, "gb-spring@1");
  assert.equal(stall.current_assembly, "gb-spring-b@1");
  assert.deepEqual(stall.label_history, ["label-gb@1", "label-gb-b@1"]);
  assert.equal(stall.migrations.length, 1);
  assert.equal(stall.fulfilled, 2);
  assert.ok(stall.notifications.length >= 2);

  // 公益承诺被冻结并完成补偿登记。
  const welfare = explainCommitment(service.events, "cmt-welfare");
  assert.equal(welfare.status, "frozen");
  assert.ok(welfare.timeline.some((t) => t.event_type === "REMEDY_COMPLETED"));

  // 额度如何变化：逐笔留痕且余额连续。
  const quota = explainQuota(service.events, "ch-stall");
  assert.equal(quota.kind, "commercial");
  assert.deepEqual(
    { total: quota.total, reserved: quota.reserved, consumed: quota.consumed },
    { total: 50, reserved: 18, consumed: 2 },
  );
  const types = quota.movements.map((m) => m.event_type);
  assert.deepEqual(types.slice(0, 2), ["CHANNEL_QUOTA_CONFIGURED", "CHANNEL_QUOTA_RESERVED"]);
  assert.ok(types.includes("CHANNEL_QUOTA_CONSUMED"));
  for (const m of quota.movements) {
    assert.ok(m.balance.reserved >= 0 && m.balance.consumed >= 0);
  }

  // 谁承担补偿：农场对公益组合负责，责任与承诺、数量挂钩。
  const liabilities = explainLiabilities(service.events);
  assert.equal(liabilities["partner-farm"].length, 1);
  assert.equal(liabilities["partner-farm"][0].detail.commitment_id, "cmt-welfare");
  assert.equal(liabilities["partner-farm"][0].detail.quantity, 10);
});
