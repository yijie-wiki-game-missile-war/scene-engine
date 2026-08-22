# Missile War v5 与 Scene Engine V3 边界

状态：V3 production composition boundary。

Scene Engine 只拥有通用 mechanics：fixed-step runtime、opaque cursor envelope、Bootstrap/Frame/control、
ordered session、Archive、display transaction 与 Replay composite session。

以下内容不进入 Scene Engine：

- `mw-authority-state-v5@1`、`mw-display-command-v5@1` 字段和业务验证；
- v5 raw tape 的权威语义与 byte-for-byte 保存；
- WorldState、规则坐标、visibility、owner 映射和 command causation；
- Arts FeatureOwner、资源目录与 interaction→v5 参数转换；
- Replay 元数据、HTTP/API、存储策略和旧 tape 迁移。

MW 用版本化 codec 把 v5 cursor 编码为 opaque canonical bytes。Bootstrap、correlation、ACK、Archive
checkpoint 和 Replay join 必须匹配相同 codec identity 与 bytes，通用 Engine 不解析其中字段。

production route 固定为：

```text
python-game MW adapter
  -> SceneEngineRuntime + V3 presentation/session/archive
  -> Arts Engine display core + MW visual profile

raw v5 tape + V3 presentation archive
  -> Replay MW authority lane + Engine CompositeReplaySession
```

DisplayFrame V1、latest-only mailbox、gap-tolerant consumer、旧 host 与 experimental import 已删除，
不能作为 MW StateSource、录像或验收依据。发布必须锁定四个仓库 commit、Engine 包哈希、共享 generated
profile 哈希和 Arts artifact identity；回滚使用完整上一 tuple，不保留运行时双读或 fallback。
