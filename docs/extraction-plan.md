# Scene Engine 跨项目收口记录

状态：V2 extraction complete；本文记录所有权结果，不再作为分阶段迁移计划。

| 能力 | 最终 owner |
| --- | --- |
| fixed-step tick、fatal/catch-up、strict commit ports | Scene Engine Python |
| Bootstrap/Frame/control/cursor envelope/session | Scene Engine Python + JS |
| streaming archive、range reader、Replay timeline/composite | Scene Engine |
| display transaction、Three lifecycle mechanics | Scene Engine JS |
| WorldState、v5 authority/tape、visibility/exporter、MW cursor codec | python-game / MW adapters |
| FeatureOwner、资源、visual profile、business projection | Arts |
| 录像产品、store、HTTP/WebSocket、MW authority lane | Replay |

已从 production graph 删除的重复实现包括旧 V1 presentation control/transport、Replay 私有 sidecar
parser/session、Arts 私有 binary/control parser 与旧 Target7 presentation shim。experimental display slice
保留在显式命名空间用于机械回归，不是 fallback。

跨仓 numeric IDs/identities 由 workspace `mw-presentation-profile.json` 生成到 python-game、Arts 和 Replay；
禁止手写第二份常量表。发布与回滚由单一 release tuple 管理。
