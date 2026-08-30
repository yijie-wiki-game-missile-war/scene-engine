# Agent Instructions

## 产品

`README.md` 是本仓库的产品文档，定义 Scene Engine 的功能、特色、适用范围、职责边界和发展方向。具体游戏玩法、产品状态、网络框架与美术内容不属于本仓库。

产品定位或方向发生变化时，同步更新 `README.md`。

## 文档

`docs/architecture.md` 定义总体架构、分层和所有权；合同与语法由 `README.md`“技术文档”中索引的现行专项文档定义。

修改前阅读 `README.md`、`docs/architecture.md` 和与变更相关的现行文档。实现、测试和现行文档必须保持一致；具体技术规则写入其所属文档，不在本文件重复维护。

## 测试

完成条件只有一个：Python 全量测试和 JavaScript 全量测试全部通过。局部测试可以用于开发过程，但不能代替交付前的全量测试。

```bash
uv run python -m pytest -q
npm test
```

测试方法与判定标准见 `docs/testing.md`；测试范围和测试项目见 `docs/tests/README.md`。
