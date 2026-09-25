# 公园节令联名履约

本仓库保存该服务的领域资料与事件约定，围绕节令联名礼盒的**组合承诺与重组流程**建设：
礼盒由公园文创、食品作坊、公益机构共同供应，线下摊位、团购、公益赠送分别承诺数量与标签版本；
食品批次缺货或检测结论变化时，系统给出可重组方案，经双确认后只迁移尚未履约的承诺，
已领取礼盒保持原装配事实并按影响追加通知。

## 目录

- `contracts/domain.schema.json`：领域事件信封、聚合类型与事件名称枚举。
- `data/`：可用于联调的中文样例记录。
- `src/validator.js`：基础事件信封校验。
- `src/domain/events.js`：事件与聚合类型常量（与契约枚举保持一致）。
- `src/domain/state.js`：事件溯源投影，维护组件批次、装配版本、渠道额度、标签快照、合作方责任五本独立台账。
- `src/domain/service.js`：`FulfillmentService`，承诺、重组、回执与清算命令。
- `src/domain/explain.js`：活动结束后的只读解释查询。
- `tests/`：配额、重组、公益保护、回执合并、解释查询与契约一致性测试。

## 五条独立留痕的事实线

| 台账 | 关键事件 | 说明 |
| --- | --- | --- |
| 组件批次 | `COMPONENT_ACCEPTED` / `COMPONENT_INSPECTION_RECORDED` / `COMPONENT_SHORTAGE_DECLARED` / `*_RESERVATION_*` | 批次实物量、检测结论、预留/释放/消耗各自留痕 |
| 装配版本 | `ASSEMBLY_VERSION_PUBLISHED` / `BUNDLE_RELEASED` | 配方不可变，变更只发布新版本 |
| 渠道额度 | `CHANNEL_QUOTA_CONFIGURED` / `*_RESERVED` / `*_CONSUMED` / `*_TRANSFERRED` | 商业与公益额度分账，逐笔带原因与关联单号 |
| 标签快照 | `LABEL_SNAPSHOT_PUBLISHED` | 过敏原说明按快照固化，已售礼盒的标签事实不被改写 |
| 合作方责任 | `LIABILITY_ASSIGNED` / `REMEDY_COMPLETED` | 冻结组合时按供货方挂接补偿责任 |

## 重组流程

1. **触发**：批次宣告缺货（`COMPONENT_SHORTAGE_DECLARED`）或检测结论变化（`COMPONENT_INSPECTION_RECORDED`）。
2. **提案**（`REORGANIZATION_PROPOSED`）：系统找出当前装配含受影响批次、且尚有未履约数量的承诺，
   按渠道路由在一个或多个替代装配中模拟「释放旧预留 → 占用新预留」的净效应，逐条标注可行性；
   已全部履约的承诺不迁移。
3. **双确认门**：食品负责人 `REORGANIZATION_LABEL_CONFIRMED` 确认替代标签过敏原说明，
   渠道负责人 `REORGANIZATION_QUOTA_CONFIRMED` 确认配额（可附带渠道间划转）。两者齐备前不得执行。
4. **执行**（`REORGANIZATION_ITEM_EXECUTED`）：每条组合在同一事件批次内原子释放旧组件、占用新组件，
   再写入 `COMMITMENT_MIGRATED`；预检不通过则整组不落任何事件。
5. **部分拒绝/不可行**：合作方 `REORGANIZATION_PARTNER_REFUSED` 或执行时余量不足，只冻结受影响组合
   （`COMMITMENT_FROZEN` + `LIABILITY_ASSIGNED`），释放的仅是该组合未履约部分的预留，其余组合照常迁移。
6. **通知**：未履约部分收到标签升级通知；已领取礼盒装配事实不变，只按过敏原影响追加
   `IMPACT_NOTIFICATION_APPENDED`。

硬规则：

- **公益保留量不可挪用**：禁止公益 → 商业渠道划转，任何划出不得使渠道低于已预留 + 已履约数量。
- **不允许私自替换组件**：装配前实物不足直接拒绝，必须走重组流程。

## 离线回执与清算

- 核销与装配回执按**业务标识**合并（`RECEIPT_SUBMITTED` / `RECEIPT_MERGED`），多个来源内容一致即进入可清算。
- 编号相同而内容改变：记录 `RECEIPT_CONFLICT_DETECTED` 并 `SETTLEMENT_PAUSED`，暂停期间拒绝继续提交，
  人工核对后 `SETTLEMENT_CLEARED` 恢复。

## 活动后解释

`src/domain/explain.js` 直接回放事件日志回答：

- `explainBox`：每个礼盒实际装入哪些批次、采用哪版标签、何时核销。
- `explainCommitment`：原始/当前装配版本、标签版本链、迁移与通知履历。
- `explainQuota`：渠道总额、预留、核销与逐笔变动余额。
- `explainLiabilities`：按合作方归集的补偿责任。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不被原地改写；业务更正产生后继记录。
涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。

## 本地检查

```bash
npm test     # node --test
npm run build
```

这些命令可在单个 Linux 应用容器内执行，不需要另行启动外部服务。
