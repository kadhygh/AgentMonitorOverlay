# Card 归档成本审计

2026-09-11。只读审计；用户希望 archived 表达“已经不期望继续关注”。本记录区分现状与建议，尚未实施归档生命周期优化。

## 当前两层语义

- **Session 归档**：之前的优化仍生效。`broker/lib/transcript-monitor.js` 的 `trackSession` 对 archived/dismissed 直接 untrack，退出定时 transcript stat/read。`overlay/src/hooks/useManagedWindowLiveness.ts` 排除 archived Session，停止其受管窗口探测。主窗口的 active/archive 查询与分页仍分开。真实 hook/event 可使 Session 恢复，纯 heartbeat 不自动恢复。
- **Card 归档**：`broker/lib/card-store.js` 的 archive 命令只设置 Card.archivedAt。不改 Session、不停止 CLI，不移除组件或备注，也不自动恢复 Card。默认来源索引保留，所以同一卡不会仅因归档就重复创建。

## Card 层剩余成本

1. `applyObservation` 遍历所有 Card，没有过滤 archivedAt。匹配源的归档 Card 仍消费新回复/阻塞，增加 attention generation，更新 revision/updatedAt；handled 还可能变 pending。卡片虽然隐藏，内部仍记录新注意力。
2. Session collection 的 set 继续发送观察，包括 heartbeat 更新。CardStore 合并批次后 clone 整库、逐事件扫描 Card、JSON 比较；有持久变化时整库校验并写 snapshot。没有变化不写盘，但计算成本仍在。无 Session 的归档 Card 也增加快照体积和扫描规模。
3. `overlay/src/api/focusPanelClient.ts` 固定查询 `includeArchived=1`，`useFocusCards` 在窗口可见时每4秒刷新。即使未打开列表，归档 Card 也会排序、投影、序列化及传输；这条新路径没有沿用旧 Session 层的归档按需加载优化。
4. `CardStore.attach` 启动时观察所有 Session；`applyObservation` 的默认 Card 导入没有排除归档 Session。历史已归档 Session 会获得一张未归档的默认 Card。取消“未分组”只能减少界面展示，不能消除这部分记录和后台计算。

只读生产核对时：142个 Session，其中10个 active、132个 archived；142张 Card，其中0张 Card 自身归档，132张引用归档 Session；分组注册表为空。这个数字说明此前的 Session 归档标记没有被新 Card 工作层理解为“不要自动导入关注对象”。不应据此批量删除或改写用户记录。

## 建议的下一轮边界

- Card 归档后退出该 Card 的注意力计算，不更新其待处理游标/版本，不自动恢复；数据保留以便主动找回。
- 默认 Focus 查询不携带归档 Card；用户主动查看归档内容时再按需读取，必要时分页。
- 已归档 Session 不自动创建新的默认关注 Card；显式人工接入保留独立路径。
- Card archive 不自动等同 Session archive。同一个 Session 可能被其他 Card、主窗口或运行管理引用；不能因归档一个工作对象就停止任务。
- 恢复 Card 时的源版本基线需要明确：应避免把归档期间的历史回复重新累加成待办。可选择以最新源建立基线，或只提示一次归档期间有更新，先与用户讨论再落地。

显示修正与这些建议分开：本次已移除自动“未分组”；未擅自实施 Card/Session 归档联动或归档恢复规则。
