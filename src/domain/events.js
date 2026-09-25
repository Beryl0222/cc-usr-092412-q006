// 领域事件类型常量。
// 事件一旦被接收，其标识、发生时间和版本不原地改写；业务更正产生后继记录。

export const EVENT_TYPES = Object.freeze([
  // 既有基线事件
  "DESIGN_CLEARED",
  "COMPONENT_ACCEPTED",
  "BUNDLE_RELEASED",
  "ORDER_RESERVED",
  "REMEDY_COMPLETED",
  // 组件批次台账
  "COMPONENT_INSPECTION_RECORDED",
  "COMPONENT_SHORTAGE_DECLARED",
  "COMPONENT_RESERVATION_ACQUIRED",
  "COMPONENT_RESERVATION_RELEASED",
  "COMPONENT_RESERVATION_CONSUMED",
  // 标签快照与装配版本
  "LABEL_SNAPSHOT_PUBLISHED",
  "ASSEMBLY_VERSION_PUBLISHED",
  // 渠道额度台账
  "CHANNEL_QUOTA_CONFIGURED",
  "CHANNEL_QUOTA_RESERVED",
  "CHANNEL_QUOTA_RELEASED",
  "CHANNEL_QUOTA_CONSUMED",
  "CHANNEL_QUOTA_TRANSFERRED",
  // 组合承诺
  "COMMITMENT_FULFILLED",
  "COMMITMENT_FROZEN",
  "COMMITMENT_MIGRATED",
  // 礼盒实物事实
  "BOX_ASSEMBLED",
  "BOX_REDEEMED",
  // 重组流程
  "REORGANIZATION_PROPOSED",
  "REORGANIZATION_LABEL_CONFIRMED",
  "REORGANIZATION_QUOTA_CONFIRMED",
  "REORGANIZATION_PARTNER_REFUSED",
  "REORGANIZATION_ITEM_EXECUTED",
  // 影响通知与合作方责任
  "IMPACT_NOTIFICATION_APPENDED",
  "LIABILITY_ASSIGNED",
  // 离线回执与清算
  "RECEIPT_SUBMITTED",
  "RECEIPT_MERGED",
  "RECEIPT_CONFLICT_DETECTED",
  "SETTLEMENT_PAUSED",
  "SETTLEMENT_CLEARED",
]);

export const AGGREGATE_TYPES = Object.freeze([
  "collaboration_design",
  "component_lot",
  "bundle_batch",
  "customer_order",
  "label_snapshot",
  "assembly_version",
  "channel_quota",
  "reorganization_plan",
  "fulfillment_receipt",
  "bundle_unit",
  "partner_liability",
]);
