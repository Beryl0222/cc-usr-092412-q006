import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/domain/index.js";
import { buildBaseService } from "./helpers.js";

test("承诺即同时占用渠道额度与组件批次，超配额承诺被拒绝且不留事件", () => {
  const service = buildBaseService();
  const before = service.events.length;
  assert.throws(
    () => service.reserveCommitment({ commitment_id: "cmt-x", channel_id: "ch-stall", assembly_id: "gb-spring", assembly_version: 1, quantity: 99 }),
    (e) => e instanceof DomainError && e.code === "QUOTA_EXCEEDED",
  );
  assert.equal(service.events.length, before, "被拒绝的承诺不应产生任何事件");

  const quota = service.state.quotas["ch-stall"];
  assert.equal(quota.reserved, 20);
  const cookieA = service.state.lots["lot-cookie-a"];
  // 三条承诺共 45 份，每份 2 块饼干。
  assert.equal(cookieA.reserved, 90);
  assert.equal(cookieA.available, 30);
});

test("装配一份礼盒消耗对应预留并核销一份渠道额度", () => {
  const service = buildBaseService();
  service.assembleBox({ box_id: "box-1", commitment_id: "cmt-stall" });

  const cookieA = service.state.lots["lot-cookie-a"];
  assert.deepEqual({ reserved: cookieA.reserved, consumed: cookieA.consumed, available: cookieA.available }, { reserved: 88, consumed: 2, available: 30 });
  const quota = service.state.quotas["ch-stall"];
  assert.deepEqual({ reserved: quota.reserved, consumed: quota.consumed }, { reserved: 19, consumed: 1 });
});

test("已冻结承诺不能继续装配", () => {
  const service = buildBaseService();
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  service.proposeReorganization({
    plan_id: "plan-x",
    trigger: { type: "shortage", lot_id: "lot-cookie-a" },
    alternatives: [{ assembly_id: "gb-spring-b", assembly_version: 1 }],
  });
  service.partnerRefuse({ plan_id: "plan-x", partner_id: "partner-park", reason: "拒绝替换合作" });
  assert.equal(service.state.commitments["cmt-stall"].status, "frozen");
  assert.throws(
    () => service.assembleBox({ box_id: "box-9", commitment_id: "cmt-stall" }),
    (e) => e.code === "COMMITMENT_FROZEN",
  );
});
