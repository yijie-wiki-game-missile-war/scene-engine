# Scene Engine V2 跨项目 composition

状态：implemented release candidate，2026-08-22。

## Live

```text
python-game immediate v5 input facade
  -> SceneEngineRuntime (60 TPS, strict authority/presentation)
       -> byte-identical v5 authority/raw record admission
       -> MW exporter emits one complete frame/correlation per committed tick
       -> OrderedPresentationSession applies ready/credit/ACK/reset
       -> PresentationArchiveWriter appends exact Bootstrap/frame/correlation bytes
```

业务 tick、projection、wire/raw record 与 presentation 只处理一次。Archive 在 raw tape 最终 SHA 可用后
seal manifest；每次 new epoch 使用新 checkpoint/segment，不能跨 presentation gap。

## Browser display

```text
V2 Bootstrap + MW visual profile
  -> static scene install
  -> correlation joins ordered complete frames
  -> SceneDisplayEngineCore prepare
  -> business store + renderer commit barrier
  -> ThreePresentationBackend + Arts FeatureOwner factories
```

prepare 期间不得修改 live tree；业务与 renderer commit 同属原子 barrier。binary lane 是动态 render handle
唯一写入者，v5 lane 只更新 business projection。资源与 FeatureOwner 归 Arts，通用 lifecycle 归 Engine。

## Replay

```text
raw v5 tape -> MwV5AuthorityLane ----\
                                      > CompositeReplaySession -> bounded WebSocket
Archive V2 -> PresentationArchiveInput/
```

Engine Replay Core 拥有 tick timeline、pause/resume/speed/seek、双 lane checkpoint gate、presentation session
和 outbound plan。Replay 只拥有产品存储/API、MW-specific tape validator/binding 和 socket composition。
Archive reader 使用 byte-range/random access，不把完整 frame 文件常驻内存。

## Release gates

1. Python/JS Engine conformance、golden/malformed、Archive corruption 和 multi-epoch 测试全绿；
2. python-game v5/raw tape parity、60Hz strict export、断线重连和 live recording 全绿；
3. Arts architecture/protocol/unit/build/performance 门禁全绿；
4. Replay ingest/play/seek/pause/speed/backpressure/timeout/corruption 门禁全绿；
5. shared profile generator `--check` 无漂移；
6. release manifest 锁定四仓 commit、所有 vendored package SHA、profile/artifact/resource identity；
7. 故障回滚完整上一 tuple，不保留 production dual implementation。
