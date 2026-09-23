# CSV ⇄ JSON 转换器

纯前端工具：Web Worker 解析、大文件分块、Blob 导出、IndexedDB 历史记录。

## 运行

Web Worker 需通过 HTTP 访问（`file://` 无法加载）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- CSV → JSON / JSON → CSV 双向转换
- 自定义分隔符（逗号/分号/Tab/竖线/任意字符）
- 可选表头、字段类型推断（数字/布尔/字符串）
- 正确处理含逗号、引号、换行的字段，支持中文与 BOM 头
- 列数不一致警告（缺列补空、多列忽略）、空行跳过、重复表头自动加序号
- 非法 JSON 友好报错
- 超大文件按 1MB 分块流式解析，主线程不卡
- 导出 CSV 自动加 BOM（Excel 打开中文不乱码）
- 转换历史存 IndexedDB，可回看/载入/删除

## 测试

```bash
node test.js   # 35 项验收测试
```
