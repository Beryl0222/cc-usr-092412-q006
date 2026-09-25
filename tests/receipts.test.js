import assert from "node:assert/strict";
import test from "node:test";

import { DomainError } from "../src/domain/index.js";
import { buildBaseService, fulfillStallBoxes } from "./helpers.js";

test("离线核销与装配回执按业务标识合并，一致即进入可清算", () => {
  const service = buildBaseService();
  fulfillStallBoxes(service, 1);
  service.redeemBox({ box_id: "box-1", at: "2026-09-25T10:00:00+08:00" });

  const content = { box_id: "box-1", assembly_key: "gb-spring@1", label_key: "label-gb@1", redeemed: true };
  // 摊位设备先交装配回执。
  let receipt = service.submitReceipt({ business_id: "rcpt-box-1", source: "stall-device", content });
  assert.equal(receipt.status, "ready");
  // 核销终端后交同号回执，内容一致：合并两个来源。
  receipt = service.submitReceipt({ business_id: "rcpt-box-1", source: "redeem-terminal", content });
  assert.equal(receipt.status, "ready");
  assert.deepEqual(receipt.sources, ["stall-device", "redeem-terminal"]);

  const merged = service.events.filter((e) => e.event_type === "RECEIPT_MERGED");
  assert.equal(merged.length, 2);
});

test("编号相同而内容改变：检测冲突并暂停清算，暂停期间拒绝继续提交", () => {
  const service = buildBaseService();
  fulfillStallBoxes(service, 1);
  service.submitReceipt({
    business_id: "rcpt-box-1",
    source: "stall-device",
    content: { box_id: "box-1", assembly_key: "gb-spring@1", label_key: "label-gb@1" },
  });
  const receipt = service.submitReceipt({
    business_id: "rcpt-box-1",
    source: "redeem-terminal",
    content: { box_id: "box-1", assembly_key: "gb-spring@1", label_key: "label-gb-b@1" },
  });
  assert.equal(receipt.status, "paused");
  assert.deepEqual(receipt.conflict.differing_fields, ["label_key"]);

  const conflict = service.events.find((e) => e.event_type === "RECEIPT_CONFLICT_DETECTED");
  assert.ok(conflict);
  const paused = service.events.find((e) => e.event_type === "SETTLEMENT_PAUSED");
  assert.ok(paused);

  assert.throws(
    () =>
      service.submitReceipt({
        business_id: "rcpt-box-1",
        source: "late-device",
        content: { box_id: "box-1", assembly_key: "gb-spring@1", label_key: "label-gb@1" },
      }),
    (e) => e instanceof DomainError && e.code === "RECEIPT_PAUSED",
  );

  // 人工核对后才能恢复清算。
  service.clearSettlement({ business_id: "rcpt-box-1", note: "核实为终端误用历史标签版本，以装配回执为准" });
  assert.equal(service.state.receipts["rcpt-box-1"].status, "cleared");
});

test("未暂停的回执不能直接解除暂停", () => {
  const service = buildBaseService();
  service.submitReceipt({ business_id: "rcpt-x", source: "s", content: { ok: true } });
  assert.throws(() => service.clearSettlement({ business_id: "rcpt-x" }), (e) => e.code === "SETTLEMENT_NOT_PAUSED");
});
