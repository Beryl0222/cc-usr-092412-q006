import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import { AGGREGATE_TYPES, EVENT_TYPES } from "../src/domain/events.js";
import { buildBaseService, fulfillStallBoxes, proposeStandard } from "./helpers.js";

async function loadSchema() {
  return JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
}

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("重组样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample-reorganization.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("事件与聚合类型常量同契约枚举保持一致", async () => {
  const schema = await loadSchema();
  assert.deepEqual([...EVENT_TYPES].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...AGGREGATE_TYPES].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("服务在完整重组流程中产生的每条事件都符合信封约定与契约枚举", async () => {
  const schema = await loadSchema();
  const service = buildBaseService();
  fulfillStallBoxes(service, 3);
  service.redeemBox({ box_id: "box-1" });
  service.declareShortage({ lot_id: "lot-cookie-a", remaining: 0 });
  proposeStandard(service);
  service.partnerRefuse({ plan_id: "plan-1", partner_id: "partner-farm", reason: "燕麦批次无法追加" });
  service.confirmLabel({ plan_id: "plan-1", confirmed_by: "食品负责人-王敏" });
  service.confirmQuota({ plan_id: "plan-1", confirmed_by: "渠道负责人-李强" });
  service.executeReorganization({ plan_id: "plan-1" });
  service.recordRemedy({ commitment_id: "cmt-welfare", detail: "公益机构改发等值礼包" });
  service.submitReceipt({ business_id: "rcpt-box-1", source: "stall-device", content: { box_id: "box-1" } });
  service.submitReceipt({ business_id: "rcpt-box-1", source: "redeem-terminal", content: { box_id: "box-1", note: "内容改变" } });
  service.clearSettlement({ business_id: "rcpt-box-1", note: "人工核对完成" });

  assert.ok(service.events.length > 40, "流程应产生丰富的事件流");
  for (const event of service.events) {
    assert.deepEqual(validateEvent(event), [], `事件 ${event.event_id} 缺少信封字段`);
    assert.ok(schema.properties.event_type.enum.includes(event.event_type), `未知事件类型 ${event.event_type}`);
    assert.ok(schema.properties.aggregate_type.enum.includes(event.aggregate_type), `未知聚合类型 ${event.aggregate_type}`);
  }

  // 同一聚合内版本号严格递增（不原地改写，只追加后继记录）。
  const seen = new Map();
  for (const event of service.events) {
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    const next = (seen.get(key) ?? 0) + 1;
    assert.equal(event.version, next, `聚合 ${key} 的版本应连续递增`);
    seen.set(key, next);
  }
});
