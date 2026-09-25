import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EventStore, eventBatch, resetEventCounter } from "../src/store.js";
import { project, lotFreeQuantity, quotaFreeQuantity, commitmentRemaining } from "../src/model.js";
import { CollaborationService } from "../src/service.js";
import { validateEvent } from "../src/validator.js";

const T = (n) => `2026-09-21T0${n}:00:00+08:00`;

// 搭建节令礼盒场景：
// 月饼 A（作坊一，含麸质/蛋）到货后被检测异常；月饼 B（作坊二，额外含花生）与
// 月饼 C（作坊三）可作替代；茶包与外盒由公园文创合作方供应。
function seed(svc) {
  svc.acceptComponent({ at: T(1), lot_id: "lot-mooncake-A", component: "莲蓉月饼", partner_id: "bakery-01", partner_name: "第一食品作坊", quantity: 100, allergens: ["麸质", "蛋"] });
  svc.acceptComponent({ at: T(1), lot_id: "lot-mooncake-B", component: "杂粮月饼", partner_id: "bakery-02", partner_name: "第二食品作坊", quantity: 100, allergens: ["麸质", "蛋", "花生"] });
  svc.acceptComponent({ at: T(1), lot_id: "lot-mooncake-C", component: "果仁月饼", partner_id: "bakery-03", partner_name: "第三食品作坊", quantity: 50, allergens: ["麸质", "蛋"] });
  svc.acceptComponent({ at: T(1), lot_id: "lot-tea", component: "桂花茶包", partner_id: "park-co", partner_name: "公园文创", quantity: 200, allergens: [] });
  svc.acceptComponent({ at: T(1), lot_id: "lot-box", component: "联名礼盒外包装", partner_id: "park-co", partner_name: "公园文创", quantity: 300, allergens: [] });

  svc.takeLabelSnapshot({ at: T(2), label_id: "label-v1", label_version: "2026秋-1", allergens: ["麸质", "蛋"], content_hash: "hash-l1" });
  svc.takeLabelSnapshot({ at: T(2), label_id: "label-v2", label_version: "2026秋-2", allergens: ["麸质", "蛋", "花生"], content_hash: "hash-l2" });
  // 标签 v3 保守声明了大豆（组件本身不含），用于验证标签只能更严、且新增声明会进入通知。
  svc.takeLabelSnapshot({ at: T(2), label_id: "label-v3", label_version: "2026秋-3", allergens: ["麸质", "蛋", "大豆"], content_hash: "hash-l3" });

  svc.publishAssembly({ at: T(3), assembly_id: "asm-v1", label_id: "label-v1", components: [{ lot_id: "lot-mooncake-A", qty: 1 }, { lot_id: "lot-tea", qty: 1 }, { lot_id: "lot-box", qty: 1 }] });
  svc.publishAssembly({ at: T(3), assembly_id: "asm-v2", label_id: "label-v2", components: [{ lot_id: "lot-mooncake-B", qty: 1 }, { lot_id: "lot-tea", qty: 1 }, { lot_id: "lot-box", qty: 1 }] });
  svc.publishAssembly({ at: T(3), assembly_id: "asm-v2b", label_id: "label-v3", components: [{ lot_id: "lot-mooncake-C", qty: 1 }, { lot_id: "lot-tea", qty: 1 }, { lot_id: "lot-box", qty: 1 }] });

  svc.openChannelQuota({ at: T(4), quota_id: "q-stall-v1", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 30 });
  svc.openChannelQuota({ at: T(4), quota_id: "q-stall-v2", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v2", quantity: 30 });
  svc.openChannelQuota({ at: T(4), quota_id: "q-gb-v1", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 40 });
  svc.openChannelQuota({ at: T(4), quota_id: "q-gb-v2b", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v2b", quantity: 20 });
  svc.openChannelQuota({ at: T(4), quota_id: "q-ngo-v1", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 30 });
  svc.openChannelQuota({ at: T(4), quota_id: "q-ngo-v2", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v2", quantity: 30 });
}

function scenario() {
  resetEventCounter();
  const svc = new CollaborationService();
  seed(svc);
  return svc;
}

test("承诺同时占用组件批次与渠道额度，超额与跨渠道被拒绝", () => {
  const svc = scenario();

  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-gb", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 15 });
  svc.promise({ at: T(5), commitment_id: "c-charity", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 20 });

  const s = svc.state();
  // 每盒 1 个月饼 A：共 45 份被占用；100 - 45 = 55 可再承诺。
  assert.equal(lotFreeQuantity(s, "lot-mooncake-A"), 55);
  assert.equal(quotaFreeQuantity(s, "q-stall-v1"), 20);
  assert.equal(quotaFreeQuantity(s, "q-gb-v1"), 25);
  assert.equal(quotaFreeQuantity(s, "q-ngo-v1"), 10);

  // 渠道额度不足：摊位只剩 20。
  assert.throws(
    () => svc.promise({ at: T(5), commitment_id: "c-x1", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 21 }),
    /渠道额度不足/
  );
  // 组件库存不足：新开一个大额渠道，额度充足但批次 A 只剩 55。
  svc.openChannelQuota({ at: T(4), quota_id: "q-gb2-v1", channel_id: "gb-02", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 1000 });
  assert.throws(
    () => svc.promise({ at: T(5), commitment_id: "c-x2", channel_id: "gb-02", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 56 }),
    /组件批次 lot-mooncake-A 可用量不足/
  );
  // 渠道类型必须与额度登记一致，防止商业渠道借公益名义占用。
  assert.throws(
    () => svc.promise({ at: T(5), commitment_id: "c-x3", channel_id: "ngo-gift", channel_kind: "stall", assembly_id: "asm-v1", quantity: 1 }),
    /渠道类型不匹配/
  );
  // 承诺失败不留痕：状态中没有失败承诺，也没有产生任何事件（两个调用都在提交前抛错）。
  assert.equal(svc.state().commitments.size, 3);
});

test("标签未覆盖组件过敏原时装配发布与标签确认都被拒绝", () => {
  const svc = scenario();
  // 用 v1 标签（缺花生）装配含花生的月饼 B：过敏原说明失真，拒绝发布。
  assert.throws(
    () => svc.publishAssembly({ at: T(3), assembly_id: "asm-bad", label_id: "label-v1", components: [{ lot_id: "lot-mooncake-B", qty: 1 }, { lot_id: "lot-tea", qty: 1 }, { lot_id: "lot-box", qty: 1 }] }),
    /未声明过敏原：花生/
  );

  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "抽检微生物超标", conclusion: "该批不得用于装配" });
  svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-bad", reason: "月饼 A 缺货",
    changes: [{ commitment_id: "c-stall", to_assembly_id: "asm-v2" }],
  });
  // 食品负责人若错认旧标签 v1：花生缺失，确认无效。
  assert.throws(
    () => svc.approveLabel({ at: T(8), plan_id: "plan-bad", approver: "food-lead", to_label_id: "label-v1" }),
    /未声明过敏原：花生/
  );
  // 被拒绝的确认不落事件，方案仍只有提案事件。
  const planEvents = svc.store.stream().filter((e) => e.aggregate_id === "plan-bad");
  assert.deepEqual(planEvents.map((e) => e.event_type), ["RECONFIGURATION_PROPOSED"]);
});

test("缺货后给出受影响承诺与可重组方案；双闸门缺失不得迁移", () => {
  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-gb", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 15 });
  svc.promise({ at: T(5), commitment_id: "c-charity", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 20 });

  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "抽检微生物超标", conclusion: "该批不得用于装配" });
  assert.deepEqual(svc.affectedCommitments("lot-mooncake-A").sort(), ["c-charity", "c-gb", "c-stall"]);

  const planned = svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-1", reason: "月饼 A 批次检测异常，需替换",
    trigger: { type: "lot_quarantined", lot_id: "lot-mooncake-A" },
    changes: [
      { commitment_id: "c-stall", to_assembly_id: "asm-v2" },
      { commitment_id: "c-charity", to_assembly_id: "asm-v2" },
      { commitment_id: "c-gb", to_assembly_id: "asm-v2b" },
    ],
  });
  assert.equal(planned.length, 3);
  assert.ok(planned.every((p) => p.feasible), JSON.stringify(planned));

  // 未确认标签与配额：执行被两道闸门分别拦截。
  assert.throws(() => svc.executePlan("plan-1", { at: T(9) }), /食品负责人/);
  svc.approveLabel({ at: T(8), plan_id: "plan-1", approver: "food-lead" });
  assert.throws(() => svc.executePlan("plan-1", { at: T(9) }), /渠道负责人/);
  svc.approveQuota({ at: T(8), plan_id: "plan-1", approver: "channel-lead" });

  // 合作方均未表态：此时执行只冻结全部组合，不发生任何迁移。
  let r = svc.executePlan("plan-1", { at: T(9) });
  assert.deepEqual(r.migrated, []);
  assert.equal(r.frozen.length, 3);
  // 方案已执行终态，不能用同一方案重复操作；未表态场景改由新方案承载。
  assert.throws(() => svc.approveLabel({ at: T(9), plan_id: "plan-1", approver: "food-lead" }), /已执行/);
});

test("主流程：部分合作方拒绝只冻结受影响组合，其余原子迁移且不挪用公益保留", () => {
  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-gb", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 15 });
  svc.promise({ at: T(5), commitment_id: "c-charity", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 20 });

  // 团购先装配并被领取 1 盒：这是“已履约”部分。
  svc.assembleBox({ at: T(5), box_id: "box-gb-1", commitment_id: "c-gb" });
  svc.claimBox({ at: T(5), box_id: "box-gb-1" });

  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "抽检微生物超标", conclusion: "该批不得用于装配" });
  svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-1", reason: "月饼 A 批次检测异常，需替换",
    changes: [
      { commitment_id: "c-stall", to_assembly_id: "asm-v2" },
      { commitment_id: "c-charity", to_assembly_id: "asm-v2" },
      { commitment_id: "c-gb", to_assembly_id: "asm-v2b" },
    ],
  });
  svc.approveLabel({ at: T(8), plan_id: "plan-1", approver: "food-lead" });
  svc.approveQuota({ at: T(8), plan_id: "plan-1", approver: "channel-lead" });
  // 第二作坊拒绝供应（摊位与公益受影响）；第三作坊同意（团购可迁移）。
  svc.partnerRespond({ at: T(8), plan_id: "plan-1", partner_id: "bakery-02", decision: "rejected", reason: "产能不足" });
  svc.partnerRespond({ at: T(8), plan_id: "plan-1", partner_id: "bakery-03", decision: "granted", responder: "bakery-03-sales" });

  const charityV2FreeBefore = quotaFreeQuantity(svc.state(), "q-ngo-v2");
  const r = svc.executePlan("plan-1", { at: T(9) });
  assert.deepEqual(r.migrated.map((x) => x.commitment_id), ["c-gb"]);
  assert.equal(r.migrated[0].remaining, 14); // 15 - 已领取 1
  assert.deepEqual(r.frozen.map((x) => x.commitment_id).sort(), ["c-charity", "c-stall"]);
  assert.match(r.frozen[0].reason, /bakery-02/);

  const s = svc.state();
  // 团购：原子释放 14 个 A 并占用 14 个 C。
  const lotA = s.lots.get("lot-mooncake-A");
  const lotC = s.lots.get("lot-mooncake-C");
  // A：初始预留 45，gb 装配消耗 1（reserved-1/consumed+1），迁移释放 14 → reserved=30（摊位10+公益20）。
  assert.equal(lotA.reserved, 30);
  assert.equal(lotA.consumed, 1);
  assert.equal(lotC.reserved, 14);
  // 冻结组合仍持有旧组件占用，没有被“释放掉却无替代”。
  assert.equal(commitmentRemaining(s, "c-stall"), 10);
  assert.equal(s.commitments.get("c-stall").status, "frozen");
  assert.equal(s.commitments.get("c-charity").status, "frozen");
  assert.equal(s.commitments.get("c-gb").status, "promised");
  assert.equal(s.commitments.get("c-gb").assembly_id, "asm-v2b");
  assert.equal(s.commitments.get("c-gb").label_id, "label-v3");

  // 团购额度从 v1 迁到 v2b（v1 已因装配核销 1 份）。
  assert.equal(s.quotas.get("q-gb-v1").reserved, 0);
  assert.equal(s.quotas.get("q-gb-v2b").reserved, 14);

  // 公益保留量不被商业渠道挪用：商业重组前后公益 v2 额度可用量不变。
  assert.equal(quotaFreeQuantity(s, "q-ngo-v2"), charityV2FreeBefore);
  assert.equal(quotaFreeQuantity(s, "q-ngo-v2"), 30);
  // 公益自身的承诺仍锁在公益 v1 额度上。
  assert.equal(s.commitments.get("c-charity").quota_id, "q-ngo-v1");

  // 已领取礼盒：装配事实保持原样（仍是月饼 A + 标签 v1），只追加影响通知。
  const box = s.boxes.get("box-gb-1");
  assert.equal(box.assembly_id, "asm-v1");
  assert.equal(box.label_id, "label-v1");
  assert.deepEqual(box.packed.map((p) => p.lot_id), ["lot-mooncake-A", "lot-tea", "lot-box"]);
  assert.equal(box.claimed, true);
  assert.equal(box.notices.length, 1);
  assert.equal(box.notices[0].impact.claimed, true);
  assert.deepEqual(box.notices[0].impact.allergen_added, ["大豆"]);
  assert.equal(box.notices[0].impact.to_assembly_id, "asm-v2b");

  // 迁移后新装配的礼盒使用新组件与新标签；冻结承诺不能装配。
  svc.assembleBox({ at: T(10), box_id: "box-gb-2", commitment_id: "c-gb" });
  const box2 = svc.state().boxes.get("box-gb-2");
  assert.equal(box2.assembly_id, "asm-v2b");
  assert.equal(box2.label_id, "label-v3");
  assert.ok(box2.packed.some((p) => p.lot_id === "lot-mooncake-C"));
  assert.throws(() => svc.assembleBox({ at: T(10), box_id: "box-stall-x", commitment_id: "c-stall" }), /已冻结/);
});

test("目标装配仅公益渠道有额度时，商业承诺不可借道公益保留量", () => {
  const svc = scenario();
  // 使用一个全新的摊位渠道：它只登记了 v1 额度，v2 只有公益渠道登记。
  svc.openChannelQuota({ at: T(4), quota_id: "q-stall2-v1", channel_id: "stall-02", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-stall2", channel_id: "stall-02", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "缺货" });
  const planned = svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-p", reason: "替换",
    changes: [{ commitment_id: "c-stall2", to_assembly_id: "asm-v2" }],
  });
  assert.equal(planned[0].feasible, false);
  assert.ok(planned[0].blockers.some((b) => /未开放装配 asm-v2 的额度/.test(b)));

  svc.approveLabel({ at: T(8), plan_id: "plan-p", approver: "food-lead" });
  svc.approveQuota({ at: T(8), plan_id: "plan-p", approver: "channel-lead" });
  svc.partnerRespond({ at: T(8), plan_id: "plan-p", partner_id: "bakery-02", decision: "granted" });
  const r = svc.executePlan("plan-p", { at: T(9) });
  assert.deepEqual(r.migrated, []);
  assert.equal(r.frozen.length, 1);
  // 公益额度原封不动。
  assert.equal(quotaFreeQuantity(svc.state(), "q-ngo-v2"), 30);
});

test("执行时额度已被他用：渠道负责人确认环节即被拦下", () => {
  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "缺货" });
  svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-q", reason: "替换",
    changes: [{ commitment_id: "c-stall", to_assembly_id: "asm-v2" }],
  });
  svc.approveLabel({ at: T(8), plan_id: "plan-q", approver: "food-lead" });
  // 提案后，摊位 v2 额度被另一笔 30 份承诺占满。
  svc.promise({ at: T(8), commitment_id: "c-other", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v2", quantity: 30 });
  assert.throws(() => svc.approveQuota({ at: T(8), plan_id: "plan-q", approver: "channel-lead" }), /此刻不足/);
});

test("离线核销与装配回执按业务标识合并；同号异容扣留并暂停清算", async () => {
  const { svc } = await mainFlow();
  // 业务标识 gb-01 下，装配已产生回执 box-gb-1、box-gb-2（amount=1）。
  // 离线核销上传同一编号、相同内容：幂等去重。
  const hash1 = svc.state().clearances.get("gb-01").receipts.find((r) => r.receipt_id === "box-gb-1").content_hash;
  assert.equal(svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "box-gb-1", source: "offline", content_hash: hash1, amount: 1 }), "duplicate");

  // 相同编号但内容变化：扣留，清算暂停。
  assert.equal(svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "box-gb-1", source: "offline", content_hash: "hash-tampered", amount: 999 }), "held");
  assert.equal(svc.state().clearances.get("gb-01").status, "paused");
  assert.throws(() => svc.settleClearance({ at: T(12), business_key: "gb-01", total_amount: 1000 }), /暂停状态/);

  // 废弃异常回执后恢复，可正常清算。
  svc.resolveHeldReceipt({ at: T(12), business_key: "gb-01", receipt_id: "box-gb-1", decision: "discarded", by: "auditor-1", reason: "离线设备重复上传旧版" });
  assert.equal(svc.state().clearances.get("gb-01").status, "open");
  svc.settleClearance({ at: T(13), business_key: "gb-01", total_amount: 2800 });
  assert.equal(svc.state().clearances.get("gb-01").status, "settled");
  assert.throws(() => svc.settleClearance({ at: T(13), business_key: "gb-01", total_amount: 2800 }), /已?结算|settled/);
});

test("多张扣留同时存在时须全部处置才恢复清算；替换以新内容转正", async () => {
  const { svc } = await mainFlow();
  svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "r2", source: "offline", content_hash: "h2-a", amount: 100 });
  svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "r3", source: "offline", content_hash: "h3-a", amount: 200 });
  assert.equal(svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "r2", source: "offline", content_hash: "h2-b", amount: 100 }), "held");
  assert.equal(svc.acceptReceipt({ at: T(11), business_key: "gb-01", receipt_id: "r3", source: "offline", content_hash: "h3-b", amount: 200 }), "held");

  // 只处置一张：仍暂停，不能清算。
  svc.resolveHeldReceipt({ at: T(12), business_key: "gb-01", receipt_id: "r2", decision: "discarded", by: "auditor-1" });
  assert.equal(svc.state().clearances.get("gb-01").status, "paused");
  assert.throws(() => svc.settleClearance({ at: T(13), business_key: "gb-01", total_amount: 1 }), /暂停状态/);

  // 第二张判定替换：新内容转正，原记录仍留痕，清算恢复。
  svc.resolveHeldReceipt({ at: T(12), business_key: "gb-01", receipt_id: "r3", decision: "replaced", by: "auditor-1", amount: 210 });
  const clearance = svc.state().clearances.get("gb-01");
  assert.equal(clearance.status, "open");
  const r3Records = clearance.receipts.filter((x) => x.receipt_id === "r3");
  assert.deepEqual(r3Records.map((x) => x.content_hash), ["h3-a", "h3-b"]);
  assert.equal(r3Records[1].supersedes_hash, "h3-a");
  svc.settleClearance({ at: T(13), business_key: "gb-01", total_amount: 2810 });
  assert.equal(svc.state().clearances.get("gb-01").status, "settled");
});

test("活动结束后可解释每个礼盒：实物、标签版本、额度变化与补偿责任", async () => {
  const { svc } = await mainFlow();
  svc.assignLiability({
    at: T(14), liability_id: "lab-1", partner_id: "bakery-01", basis: "批次 lot-mooncake-A 检测异常导致替换与追加通知",
    plan_id: "plan-1", commitment_id: "c-gb", box_id: "box-gb-1", share: 0.6, amount: 1200,
  });
  svc.assignLiability({
    at: T(14), liability_id: "lab-2", partner_id: "park-co", basis: "线下通知物料补印",
    plan_id: "plan-1", commitment_id: "c-gb", box_id: "box-gb-1", share: 0.4, amount: 800,
  });
  svc.completeRemedy({ at: T(15), liability_id: "lab-1", note: "已向已领取顾客补发含花生/大豆提示的短信与换货券" });

  const report = svc.explainBox("box-gb-1");
  // 实际装入：莲蓉月饼 + 茶 + 外盒，各自合作方与数量可追溯。
  assert.deepEqual(report.box.packed.map((p) => [p.component, p.partner_id, p.qty]), [
    ["莲蓉月饼", "bakery-01", 1],
    ["桂花茶包", "park-co", 1],
    ["联名礼盒外包装", "park-co", 1],
  ]);
  // 采用的标签版本与过敏原快照。
  assert.equal(report.box.label.label_version, "2026秋-1");
  assert.deepEqual(report.box.label.allergens, ["麸质", "蛋"]);
  // 承诺轨迹：15 份 v1 → 剩 14 份迁移到 v2b。
  assert.deepEqual(report.commitment.history.map((h) => h.kind), ["promise", "migrate"]);
  assert.equal(report.commitment.history[1].to_assembly_id, "asm-v2b");
  // 额度台账：占用 15、装配核销 1、迁出 14、在新额度迁入 14，全部按业务标识留痕。
  const kinds = report.quota_changes.map((q) => q.kind);
  assert.deepEqual(kinds, ["promise", "assemble", "migrate_out", "migrate_in"]);
  assert.deepEqual(report.quota_changes.map((q) => q.delta), [15, -1, -14, 14]);
  assert.equal(report.quota_changes.at(-1).quota_id, "q-gb-v2b");
  // 影响通知与补偿承担方。
  assert.equal(report.impact_notices.length, 1);
  const liable = new Map(report.liabilities.map((l) => [l.partner_id, l]));
  assert.equal(liable.get("bakery-01").status, "remedied");
  assert.equal(liable.get("bakery-01").amount, 1200);
  assert.equal(liable.get("park-co").status, "open");
});

test("所有落库事件满足基础信封且不可原地改写", async () => {
  const { svc } = await mainFlow();
  const events = svc.store.stream();
  assert.ok(events.length > 30);
  for (const e of events) {
    assert.deepEqual(validateEvent(e), [], `事件校验失败：${e.event_id}`);
    assert.throws(() => { e.summary = "x"; }, /object is not extensible|Cannot assign to read only property/);
  }
  // 同一聚合版本必须连续，不能跳号。
  const versions = new Map();
  for (const e of events) {
    const v = (versions.get(e.aggregate_id) ?? 0) + 1;
    assert.equal(e.version, v, `聚合 ${e.aggregate_id} 版本不连续`);
    versions.set(e.aggregate_id, v);
  }
});

test("代码实际发出的事件类型与聚合类型都在领域契约枚举内", async () => {
  const { svc } = await mainFlow();
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  const eventTypes = new Set(schema.properties.event_type.enum);
  const aggregateTypes = new Set(schema.properties.aggregate_type.enum);
  for (const e of svc.store.stream()) {
    assert.ok(eventTypes.has(e.event_type), `契约缺少事件类型：${e.event_type}`);
    assert.ok(aggregateTypes.has(e.aggregate_type), `契约缺少聚合类型：${e.aggregate_type}`);
  }
});

test("事件批次提交是原子的：批次内校验失败则整批不落库", () => {
  const store = new EventStore();
  const b = eventBatch(store, T(1));
  b.add("DESIGN_CLEARED", "collaboration_design", "d1", { summary: "ok" });
  b.add("DESIGN_CLEARED", "collaboration_design", "d1", { summary: "bad version" });
  // 手工破坏版本号，模拟批内冲突。
  b.events[1].version = 1;
  assert.throws(() => b.commit(), /版本冲突/);
  assert.deepEqual(store.stream(), []);
  assert.equal(store.versionOf("d1"), 0);
});

test("批次解除冻结后可重新用于新承诺，检测恢复留有独立记录", () => {  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-gb", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 5 });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "临时待检", conclusion: "等待复检" });
  assert.throws(
    () => svc.promise({ at: T(6), commitment_id: "c-gb2", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 1 }),
    /已冻结/
  );
  svc.releaseLot({ at: T(7), lot_id: "lot-mooncake-A" });
  svc.promise({ at: T(7), commitment_id: "c-gb2", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 1 });
  const types = svc.store.stream().filter((e) => e.aggregate_id === "lot-mooncake-A").map((e) => e.event_type);
  assert.deepEqual(types, ["COMPONENT_ACCEPTED", "LOT_QUARANTINED", "LOT_RELEASED"]);
  assert.equal(svc.state().lots.get("lot-mooncake-A").status, "accepted");
});

test("被冻结组合在替代供应落地后可凭新方案恢复，且只影响自身", () => {
  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-charity", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 20 });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "抽检微生物超标" });

  // 第一轮：第二作坊拒绝，两项都冻结。
  svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-r1", reason: "替换月饼 A",
    changes: [
      { commitment_id: "c-stall", to_assembly_id: "asm-v2" },
      { commitment_id: "c-charity", to_assembly_id: "asm-v2" },
    ],
  });
  svc.approveLabel({ at: T(8), plan_id: "plan-r1", approver: "food-lead" });
  svc.approveQuota({ at: T(8), plan_id: "plan-r1", approver: "channel-lead" });
  svc.partnerRespond({ at: T(8), plan_id: "plan-r1", partner_id: "bakery-02", decision: "rejected", reason: "产能不足" });
  const r1 = svc.executePlan("plan-r1", { at: T(9) });
  assert.deepEqual(r1.migrated, []);
  assert.equal(r1.frozen.length, 2);

  // 第二轮：为第三作坊开通摊位 v2b 额度，仅对摊位提案；公益仍冻结。
  svc.openChannelQuota({ at: T(9), quota_id: "q-stall-v2b", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v2b", quantity: 10 });
  svc.proposeReconfiguration({
    at: T(10), plan_id: "plan-r2", reason: "改由第三作坊供应摊位",
    changes: [{ commitment_id: "c-stall", to_assembly_id: "asm-v2b" }],
  });
  svc.approveLabel({ at: T(10), plan_id: "plan-r2", approver: "food-lead" });
  svc.approveQuota({ at: T(10), plan_id: "plan-r2", approver: "channel-lead" });
  svc.partnerRespond({ at: T(10), plan_id: "plan-r2", partner_id: "bakery-03", decision: "granted" });
  const r2 = svc.executePlan("plan-r2", { at: T(11) });
  assert.deepEqual(r2.migrated.map((x) => x.commitment_id), ["c-stall"]);
  assert.deepEqual(r2.frozen, []);

  const s = svc.state();
  assert.equal(s.commitments.get("c-stall").status, "promised");
  assert.equal(s.commitments.get("c-stall").assembly_id, "asm-v2b");
  assert.equal(s.commitments.get("c-stall").frozen, null);
  assert.deepEqual(s.commitments.get("c-stall").history.map((h) => h.kind), ["promise", "freeze", "migrate"]);
  // 公益组合继续冻结，其旧组件占用不被动用。
  assert.equal(s.commitments.get("c-charity").status, "frozen");
  assert.equal(s.commitments.get("c-charity").assembly_id, "asm-v1");
  assert.equal(s.lots.get("lot-mooncake-A").reserved, 20);
  // 恢复后的摊位承诺可正常装配。
  svc.assembleBox({ at: T(12), box_id: "box-stall-1", commitment_id: "c-stall" });
  assert.equal(svc.state().boxes.get("box-stall-1").assembly_id, "asm-v2b");
});

// 主流程复用：三类渠道承诺、团购领取 1 盒、部分拒绝的重组、再装配 1 盒。
async function mainFlow() {  const svc = scenario();
  svc.promise({ at: T(5), commitment_id: "c-stall", channel_id: "stall-01", channel_kind: "stall", assembly_id: "asm-v1", quantity: 10 });
  svc.promise({ at: T(5), commitment_id: "c-gb", channel_id: "gb-01", channel_kind: "groupbuy", assembly_id: "asm-v1", quantity: 15 });
  svc.promise({ at: T(5), commitment_id: "c-charity", channel_id: "ngo-gift", channel_kind: "charity", assembly_id: "asm-v1", quantity: 20 });
  svc.assembleBox({ at: T(5), box_id: "box-gb-1", commitment_id: "c-gb" });
  svc.claimBox({ at: T(5), box_id: "box-gb-1" });
  svc.quarantineLot({ at: T(6), lot_id: "lot-mooncake-A", reason: "抽检微生物超标", conclusion: "该批不得用于装配" });
  svc.proposeReconfiguration({
    at: T(7), plan_id: "plan-1", reason: "月饼 A 批次检测异常，需替换",
    changes: [
      { commitment_id: "c-stall", to_assembly_id: "asm-v2" },
      { commitment_id: "c-charity", to_assembly_id: "asm-v2" },
      { commitment_id: "c-gb", to_assembly_id: "asm-v2b" },
    ],
  });
  svc.approveLabel({ at: T(8), plan_id: "plan-1", approver: "food-lead" });
  svc.approveQuota({ at: T(8), plan_id: "plan-1", approver: "channel-lead" });
  svc.partnerRespond({ at: T(8), plan_id: "plan-1", partner_id: "bakery-02", decision: "rejected", reason: "产能不足" });
  svc.partnerRespond({ at: T(8), plan_id: "plan-1", partner_id: "bakery-03", decision: "granted" });
  svc.executePlan("plan-1", { at: T(9) });
  svc.assembleBox({ at: T(10), box_id: "box-gb-2", commitment_id: "c-gb" });
  return { svc };
}
