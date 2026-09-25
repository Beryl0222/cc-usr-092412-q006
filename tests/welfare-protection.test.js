import assert from "node:assert/strict";
import test from "node:test";

import { buildBaseService, proposeStandard } from "./helpers.js";

test("公益保留量不能被商业渠道挪用", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);

  // 公益 → 商业的划转直接拒绝，不落任何划转事件。
  const before = service.events.length;
  assert.throws(
    () =>
      service.confirmQuota({
        plan_id: "plan-1",
        confirmed_by: "渠道负责人-李强",
        transfers: [{ from_channel_id: "ch-welfare", to_channel_id: "ch-stall", quantity: 5 }],
      }),
    (e) => e.code === "WELFARE_PROTECTED",
  );
  assert.equal(service.events.length, before);

  // 划出后低于已承诺数量也被拒绝（商业渠道已预留 20 份，不能再向外划出）。
  assert.throws(
    () =>
      service.confirmQuota({
        plan_id: "plan-1",
        confirmed_by: "渠道负责人-李强",
        transfers: [{ from_channel_id: "ch-stall", to_channel_id: "ch-group", quantity: 31 }],
      }),
    (e) => e.code === "QUOTA_EXCEEDED",
  );

  // 商业渠道间余量划转允许，额度台账逐笔留痕。
  service.confirmQuota({
    plan_id: "plan-1",
    confirmed_by: "渠道负责人-李强",
    transfers: [{ from_channel_id: "ch-stall", to_channel_id: "ch-group", quantity: 5 }],
  });
  assert.equal(service.state.quotas["ch-stall"].total, 45);
  assert.equal(service.state.quotas["ch-group"].total, 45);
});

test("承诺冻结释放的渠道额度不会被划拨到商业渠道：公益侧拒绝时只退回公益池", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);
  // 公益替代配方供应方拒绝：仅公益组合冻结并释放公益预留。
  service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-farm", reason: "燕麦批次无法追加" });
  assert.equal(service.state.quotas["ch-welfare"].reserved, 0);
  // 公益渠道总额不变，释放的保留量仍留在公益渠道池内。
  assert.equal(service.state.quotas["ch-welfare"].total, 30);
  // 商业承诺完全不受影响。
  assert.equal(service.state.commitments["cmt-stall"].status, "reserved");
});
