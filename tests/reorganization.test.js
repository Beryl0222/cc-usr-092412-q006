import assert from "node:assert/strict";
import test from "node:test";

import { buildBaseService, fulfillStallBoxes, proposeStandard } from "./helpers.js";

test("缺货触发重组：双确认齐备后原子迁移未履约承诺，已领取礼盒保持原装配事实", () => {
  const service = buildBaseService();
  fulfillStallBoxes(service, 5);

  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0, cause: "作坊停产" });
  const proposed = proposeStandard(service);
  const plan = proposed.payload;
  assert.equal(plan.items.length, 3);
  const byCommitment = Object.fromEntries(plan.items.map((i) => [i.commitment_id, i]));
  // 商业渠道走芝麻配方，公益渠道经路由走燕麦配方，全部可行。
  assert.equal(byCommitment["cmt-stall"].to_assembly_key, "gb-spring-b@1");
  assert.equal(byCommitment["cmt-group"].to_assembly_key, "gb-spring-b@1");
  assert.equal(byCommitment["cmt-welfare"].to_assembly_key, "gb-spring-c@1");
  assert.ok(plan.items.every((i) => i.feasible));
  // 摊位承诺已履约 5 份，只有 15 份未履约数量参与迁移。
  assert.equal(byCommitment["cmt-stall"].quantity, 15);

  // 双确认缺一不可。
  assert.throws(() => service.executeReorganization({ plan_id: "plan-1" }), (e) => e.code === "LABEL_UNCONFIRMED");
  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  assert.throws(() => service.executeReorganization({ plan_id: "plan-1" }), (e) => e.code === "QUOTA_UNCONFIRMED");
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-1" });

  // 未履约承诺迁移到新装配与新标签快照。
  const stall = service.state.commitments["cmt-stall"];
  assert.equal(stall.assembly_key, "gb-spring-b@1");
  assert.equal(stall.label_key, "label-gb-b@1");
  assert.equal(stall.fulfilled, 5);
  assert.equal(service.state.commitments["cmt-welfare"].assembly_key, "gb-spring-c@1");

  // 旧批次预留原子释放（缺货批次释放不回到可用量），新批次原子占用。
  const cookieA = service.state.lots["lot-cookie-a"];
  assert.deepEqual({ reserved: cookieA.reserved, available: cookieA.available }, { reserved: 0, available: 0 });
  const cookieB = service.state.lots["lot-cookie-b"];
  assert.deepEqual({ reserved: cookieB.reserved, available: cookieB.available }, { reserved: 60, available: 20 });
  const cookieC = service.state.lots["lot-cookie-c"];
  assert.deepEqual({ reserved: cookieC.reserved, available: cookieC.available }, { reserved: 20, available: 80 });

  // 渠道额度不因迁移变化：摊位仍是 15 预留 + 5 核销。
  const quota = service.state.quotas["ch-stall"];
  assert.deepEqual({ reserved: quota.reserved, consumed: quota.consumed }, { reserved: 15, consumed: 5 });

  // 已领取礼盒保持原装配事实与原标签快照。
  const box = service.state.boxes["box-1"];
  assert.equal(box.assembly_key, "gb-spring@1");
  assert.equal(box.label_key, "label-gb@1");
  assert.ok(box.items.some((i) => i.lot_id === "lot-cookie-a"));

  // 按影响追加通知：待领取人收到标签升级（新增芝麻），已领取人收到过敏原提示。
  const audiences = stall.notifications.map((n) => n.audience);
  assert.ok(audiences.includes("待履约领取人"));
  assert.ok(audiences.includes("已领取人"));
  assert.ok(stall.notifications.find((n) => n.audience === "待履约领取人").message.includes("芝麻"));
  assert.ok(stall.notifications.find((n) => n.audience === "已领取人").message.includes("gb-spring@1"));
});

test("标签与配额确认顺序无关，齐备后方可执行", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  assert.throws(() => service.executeReorganization({ plan_id: "plan-1" }), (e) => e.code === "LABEL_UNCONFIRMED");
  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  service.executeReorganization({ plan_id: "plan-1" });
  assert.equal(service.state.commitments["cmt-group"].assembly_key, "gb-spring-b@1");
});

test("执行时替代批次不足：只冻结受影响组合，其余组合照常迁移，且不留半迁移状态", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);
  // 方案生成后情况变化：替代批次也宣告缺货，剩余不足以承接商业渠道。
  service.declareShortage({ lot_id: "lot-cookie-b", remaining: 10 });
  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-1" });

  // 商业两条组合被冻结，公益组合走燕麦配方正常迁移。
  assert.equal(service.state.commitments["cmt-stall"].status, "frozen");
  assert.equal(service.state.commitments["cmt-group"].status, "frozen");
  assert.equal(service.state.commitments["cmt-welfare"].assembly_key, "gb-spring-c@1");

  // 没有半迁移：芝麻批次零占用，被冻结组合仍指向原装配。
  const cookieB = service.state.lots["lot-cookie-b"];
  assert.equal(cookieB.reserved, 0);
  assert.equal(cookieB.available, 10);
  assert.equal(service.state.commitments["cmt-stall"].assembly_key, "gb-spring@1");

  // 冻结释放其渠道预留与组件预留，并留痕合作方补偿责任。
  assert.equal(service.state.quotas["ch-stall"].reserved, 0);
  const liabilities = service.state.liabilities.filter((l) => l.partner_id === "partner-bakery");
  assert.equal(liabilities.length, 2);
  assert.deepEqual(liabilities.map((l) => l.detail.commitment_id).sort(), ["cmt-group", "cmt-stall"]);
});

test("部分合作方拒绝时只冻结受影响组合", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);

  // 与方案无关的合作方拒绝会被直接驳回。
  assert.throws(
    () => service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-unknown", reason: "无关方" }),
    (e) => e.code === "NO_AFFECTED_ITEM",
  );

  // 芝麻饼干供应方（食品作坊）拒绝：商业两条组合冻结，公益组合（燕麦配方）不受影响。
  service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-bakery", reason: "不接受替代供货责任" });
  assert.equal(service.state.commitments["cmt-stall"].status, "frozen");
  assert.equal(service.state.commitments["cmt-group"].status, "frozen");
  assert.equal(service.state.commitments["cmt-welfare"].status, "reserved");

  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-1" });

  const plan = service.state.plans["plan-1"];
  const statusByCommitment = Object.fromEntries(plan.items.map((i) => [i.commitment_id, i.status]));
  assert.deepEqual(statusByCommitment, { "cmt-stall": "frozen", "cmt-group": "frozen", "cmt-welfare": "executed" });
  assert.equal(service.state.commitments["cmt-welfare"].assembly_key, "gb-spring-c@1");
  // 公益额度未被挪用：公益渠道预留保持 10，商业渠道预留因冻结释放为 0。
  assert.equal(service.state.quotas["ch-welfare"].reserved, 10);
  assert.equal(service.state.quotas["ch-stall"].reserved, 0);
});

test("检测结论变化同样触发重组，且已领取礼盒只追加通知不改事实", () => {
  const service = buildBaseService();
  fulfillStallBoxes(service, 3);
  service.recordInspection({ lot_id: "lot-cookie-a", status: "recalled", allergens: ["麸质", "鸡蛋", "花生"], note: "复检发现花生污染" });
  service.proposeReorganization({
    plan_id: "plan-recall",
    trigger: { type: "inspection", lot_id: "lot-cookie-a" },
    alternatives: [{ assembly_id: "gb-spring-c", assembly_version: 1 }],
  });
  service.confirmLabel({ plan_id: "plan-recall", confirmed_by: "食品负责人-王敏" });
  service.confirmQuota({ plan_id: "plan-recall", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-recall" });

  // 已领取 3 盒仍是原装配事实。
  assert.equal(service.state.boxes["box-1"].assembly_key, "gb-spring@1");
  const stall = service.state.commitments["cmt-stall"];
  assert.equal(stall.fulfilled, 3);
  assert.equal(stall.assembly_key, "gb-spring-c@1");
  // 通知同时覆盖待领取与已领取人群。
  const audiences = stall.notifications.map((n) => n.audience);
  assert.ok(audiences.includes("待履约领取人"));
  assert.ok(audiences.includes("已领取人"));
});

test("冻结的承诺登记补偿完成，未冻结的承诺不能登记", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);
  service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-bakery", reason: "拒绝替代供货" });

  assert.throws(() => service.recordRemedy({ commitment_id: "cmt-welfare", detail: "x" }), (e) => e.code === "NOT_FROZEN");
  service.recordRemedy({ commitment_id: "cmt-stall", detail: "食品作坊赔付等额券并承担通知费用" });
  const remedy = service.events.find((e) => e.event_type === "REMEDY_COMPLETED");
  assert.equal(remedy.aggregate_id, "cmt-stall");
});
