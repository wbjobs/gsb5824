# CSV ⇄ JSON 转换工具

纯前端实现：DOM + Web Worker（解析）+ Blob（导出）+ IndexedDB（历史记录），无构建步骤。

## 运行

Web Worker 不能从 `file://` 加载，需启动本地服务：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- CSV → JSON、JSON → CSV 双向转换（JSON 支持对象数组 / 数组的数组 / NDJSON 兜底）
- 自定义分隔符（逗号/分号/Tab/竖线/任意单字符）、表头开关、字段类型推断（数字/布尔/字符串，前导零保留为字符串）
- 正确处理含逗号、引号（`""` 转义）、换行的字段，中文与 UTF-8 BOM
- 列数不一致：逐行提示行号，短行补空、长行生成 `extra_N` 列；空行自动跳过并计数；重复表头自动重命名 `name_2`
- 大文件在 Worker 中分块解析并显示进度条，主线程不卡；超过 5MB 的输入不回显到文本框
- 导出文件带 BOM（Excel 打开中文不乱码）；历史记录存 IndexedDB，保留最近 20 条，可恢复/删除

## 测试

```bash
node test/test.js   # 15 项用例：正确性 + 特殊字符 + 1 万行性能（< 2s）
```
