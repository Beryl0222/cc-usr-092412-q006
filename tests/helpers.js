// 测试共用的场景搭建：一款节令礼盒由公园文创、食品作坊、公益机构共同供应，
// 三个渠道（线下摊位、团购、公益赠送）分别承诺数量与标签版本。

import { FulfillmentService } from "../src/domain/index.js";

export function makeClock(start = Date.UTC(2026, 8, 25, 9, 0, 0)) {
  let tick = 0;
  return () => new Date(start + tick++ * 1000).toISOString();
}

export function buildBaseService() {
  const service = new FulfillmentService({ clock: makeClock() });

  // 组件批次：公园文创 + 两家食品作坊 + 公益机构茶包。
  service.acceptComponentLot({ lot_id: "lot-badge", partner_id: "partner-park", kind: "文创", name: "公园徽章", quantity: 200, allergens: [] });
  service.acceptComponentLot({ lot_id: "lot-cookie-a", partner_id: "partner-bakery", kind: "饼干", name: "黄油饼干", quantity: 120, allergens: ["麸质", "鸡蛋"] });
  service.acceptComponentLot({ lot_id: "lot-cookie-b", partner_id: "partner-bakery", kind: "饼干", name: "芝麻饼干", quantity: 80, allergens: ["麸质", "鸡蛋", "芝麻"] });
  service.acceptComponentLot({ lot_id: "lot-cookie-c", partner_id: "partner-farm", kind: "饼干", name: "燕麦饼干", quantity: 100, allergens: ["麸质", "燕麦"] });
  service.acceptComponentLot({ lot_id: "lot-tea", partner_id: "partner-charity-org", kind: "茶包", name: "桂花茶", quantity: 200, allergens: [] });
  for (const lot_id of ["lot-badge", "lot-cookie-a", "lot-cookie-b", "lot-cookie-c", "lot-tea"]) {
    service.recordInspection({ lot_id, status: "passed", note: "入场抽检合格" });
  }

  // 标签快照：原配方与两个替代配方各一版。
  service.publishLabel({ label_id: "label-gb", version: 1, allergens: ["麸质", "鸡蛋"], lines: ["节令联名礼盒", "过敏原：麸质、鸡蛋"] });
  service.publishLabel({ label_id: "label-gb-b", version: 1, allergens: ["麸质", "鸡蛋", "芝麻"], lines: ["节令联名礼盒（芝麻配方）", "过敏原：麸质、鸡蛋、芝麻"] });
  service.publishLabel({ label_id: "label-gb-c", version: 1, allergens: ["麸质", "燕麦"], lines: ["节令联名礼盒（燕麦配方）", "过敏原：麸质、燕麦"] });

  // 装配版本：原装配 gb-spring@1，两个替代装配。
  const items = (cookieLot) => [
    { lot_id: "lot-badge", quantity: 1 },
    { lot_id: cookieLot, quantity: 2 },
    { lot_id: "lot-tea", quantity: 1 },
  ];
  service.publishAssembly({ assembly_id: "gb-spring", version: 1, items: items("lot-cookie-a"), label_id: "label-gb", label_version: 1 });
  service.publishAssembly({ assembly_id: "gb-spring-b", version: 1, items: items("lot-cookie-b"), label_id: "label-gb-b", label_version: 1 });
  service.publishAssembly({ assembly_id: "gb-spring-c", version: 1, items: items("lot-cookie-c"), label_id: "label-gb-c", label_version: 1 });

  // 渠道额度：两个商业渠道 + 一个公益渠道。
  service.configureChannelQuota({ channel_id: "ch-stall", kind: "commercial", total: 50 });
  service.configureChannelQuota({ channel_id: "ch-group", kind: "commercial", total: 40 });
  service.configureChannelQuota({ channel_id: "ch-welfare", kind: "public_welfare", total: 30 });

  // 组合承诺：三个渠道分别按 gb-spring@1 / label-gb@1 承诺。
  service.reserveCommitment({ commitment_id: "cmt-stall", channel_id: "ch-stall", assembly_id: "gb-spring", assembly_version: 1, quantity: 20 });
  service.reserveCommitment({ commitment_id: "cmt-group", channel_id: "ch-group", assembly_id: "gb-spring", assembly_version: 1, quantity: 15 });
  service.reserveCommitment({ commitment_id: "cmt-welfare", channel_id: "ch-welfare", assembly_id: "gb-spring", assembly_version: 1, quantity: 10 });
  return service;
}

/** 摊位渠道先领取 5 盒（box-1 .. box-5）。 */
export function fulfillStallBoxes(service, count = 5) {
  for (let i = 1; i <= count; i += 1) {
    service.assembleBox({ box_id: `box-${i}`, commitment_id: "cmt-stall" });
  }
}

/** 标准重组方案：商业渠道走芝麻配方，公益渠道路由到燕麦配方。 */
export function proposeStandard(service, plan_id = "plan-1") {
  return service.proposeReorganization({
    plan_id,
    trigger: { type: "shortage", lot_id: "lot-cookie-a" },
    alternatives: [
      { assembly_id: "gb-spring-b", assembly_version: 1 },
      { assembly_id: "gb-spring-c", assembly_version: 1 },
    ],
    routes: [{ channel_ids: ["ch-welfare"], assembly_id: "gb-spring-c", assembly_version: 1 }],
  });
}
