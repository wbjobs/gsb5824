'use strict';
const assert = require('assert');
const { parseCSV, jsonToCSV, convert } = require('../js/worker.js');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('✓', name); }

/* 1. 基础 CSV -> JSON（表头 + 类型推断） */
t('基础转换 + 类型推断', () => {
  const r = parseCSV('name,age,active,score\n张三,25,true,98.5\n李四,abc,false,007',
    { delimiter: ',', hasHeader: true, inferTypes: true });
  assert.strictEqual(r.stats.rows, 2);
  assert.deepStrictEqual(r.data[0], { name: '张三', age: 25, active: true, score: 98.5 });
  assert.strictEqual(r.data[1].age, 'abc');   // 非数字保持字符串
  assert.strictEqual(r.data[1].score, '007'); // 前导零保持字符串
});

/* 2. 特殊字符：逗号/引号/换行/中文 */
t('含逗号/引号/换行的字段', () => {
  const csv = 'id,note\n1,"你好, 世界"\n2,"他说 ""你好"" 然后走了"\n3,"第一行\n第二行"';
  const r = parseCSV(csv, { delimiter: ',', hasHeader: true, inferTypes: false });
  assert.strictEqual(r.data[0].note, '你好, 世界');
  assert.strictEqual(r.data[1].note, '他说 "你好" 然后走了');
  assert.strictEqual(r.data[2].note, '第一行\n第二行');
  assert.strictEqual(r.stats.rows, 3); // 字段内换行不算新行
});

/* 3. BOM 头 */
t('BOM 头处理', () => {
  const r = parseCSV('﻿a,b\n1,2', { delimiter: ',', hasHeader: true, inferTypes: true });
  assert.deepStrictEqual(r.data[0], { a: 1, b: 2 });
});

/* 4. 自定义分隔符 */
t('自定义分隔符（分号/Tab）', () => {
  const r1 = parseCSV('a;b\n1;2', { delimiter: ';', hasHeader: true, inferTypes: true });
  assert.deepStrictEqual(r1.data[0], { a: 1, b: 2 });
  const r2 = parseCSV('a\tb\n1\t2', { delimiter: '\t', hasHeader: true, inferTypes: true });
  assert.deepStrictEqual(r2.data[0], { a: 1, b: 2 });
});

/* 5. 空行跳过（含 \r\n） */
t('空行跳过', () => {
  const r = parseCSV('a,b\r\n1,2\r\n\r\n\r\n3,4\r\n', { delimiter: ',', hasHeader: true, inferTypes: true });
  assert.strictEqual(r.stats.rows, 2);
  assert.strictEqual(r.stats.emptyLines, 2);
});

/* 6. 列数不一致：提示 + 补空 */
t('列数不一致提示', () => {
  const r = parseCSV('a,b,c\n1,2\n3,4,5,6', { delimiter: ',', hasHeader: true, inferTypes: false });
  assert.strictEqual(r.stats.mismatchRows, 2);
  assert.ok(r.warnings.some(w => w.includes('第 2 行') && w.includes('实际 2 列')));
  assert.ok(r.warnings.some(w => w.includes('第 3 行') && w.includes('实际 4 列')));
  assert.strictEqual(r.data[0].c, '');            // 短行补空
  assert.strictEqual(r.data[1].extra_1, '6');     // 长行生成额外表头
});

/* 7. 重复表头重命名 */
t('重复表头重命名', () => {
  const r = parseCSV('a,a,b,a\n1,2,3,4', { delimiter: ',', hasHeader: true, inferTypes: true });
  assert.deepStrictEqual(r.headers, ['a', 'a_2', 'b', 'a_3']);
  assert.strictEqual(r.warnings.filter(w => w.includes('重复表头')).length, 2);
});

/* 8. 无表头模式 */
t('无表头模式输出数组的数组', () => {
  const r = parseCSV('1,2\n3,4', { delimiter: ',', hasHeader: false, inferTypes: true });
  assert.deepStrictEqual(r.data, [[1, 2], [3, 4]]);
});

/* 9. JSON -> CSV 基础 + 特殊字符转义 */
t('JSON -> CSV 转义', () => {
  const r = jsonToCSV(JSON.stringify([
    { name: '张,三', note: '他说"hi"', multi: 'a\nb', n: 1, ok: true, nil: null }
  ]), { delimiter: ',', hasHeader: true });
  const lines = r.csv.split('\r\n');
  assert.strictEqual(lines[0], 'name,note,multi,n,ok,nil');
  assert.strictEqual(lines[1], '"张,三","他说""hi""","a\nb",1,true,');
});

/* 10. JSON -> CSV 键并集 */
t('JSON 键并集作为表头', () => {
  const r = jsonToCSV('[{"a":1},{"b":2}]', { delimiter: ',', hasHeader: true });
  assert.strictEqual(r.csv.split('\r\n')[0], 'a,b');
  assert.strictEqual(r.csv.split('\r\n')[1], '1,');
  assert.strictEqual(r.csv.split('\r\n')[2], ',2');
});

/* 11. 非法 JSON 报错 */
t('非法 JSON 报错', () => {
  assert.throws(() => jsonToCSV('{not valid json', { delimiter: ',', hasHeader: true }),
    /非法 JSON/);
});

/* 12. NDJSON 兜底 */
t('NDJSON 兜底解析', () => {
  const r = jsonToCSV('{"a":1}\n{"a":2}\n', { delimiter: ',', hasHeader: true });
  assert.strictEqual(r.stats.rows, 2);
});

/* 13. 互转往返一致 */
t('CSV->JSON->CSV 往返', () => {
  const csv = 'id,name,note\n1,"张,三","多\n行"\n2,"引""号",true';
  const j = convert({ direction: 'csv2json', text: csv,
    options: { delimiter: ',', hasHeader: true, inferTypes: false } });
  const back = convert({ direction: 'json2csv', text: j.output,
    options: { delimiter: ',', hasHeader: true } });
  const r2 = parseCSV(back.output, { delimiter: ',', hasHeader: true, inferTypes: false });
  assert.deepStrictEqual(r2.data, [
    { id: '1', name: '张,三', note: '多\n行' },
    { id: '2', name: '引"号', note: 'true' }
  ]);
});

/* 14. 1 万行性能 < 2s（含特殊字段与中文） */
t('1 万行 CSV 解析 < 2s', () => {
  const rows = ['id,name,city,amount,active,remark'];
  for (let i = 0; i < 10000; i++) {
    rows.push(`${i},"用户${i}, 备注""引号""","城市${i}\n第二行",${(i * 1.5).toFixed(2)},${i % 2 === 0},普通文本`);
  }
  const csv = '﻿' + rows.join('\n');
  const start = Date.now();
  const r = parseCSV(csv, { delimiter: ',', hasHeader: true, inferTypes: true });
  const elapsed = Date.now() - start;
  assert.strictEqual(r.stats.rows, 10000);
  assert.strictEqual(r.data[0].name, '用户0, 备注"引号"');
  assert.strictEqual(r.data[5].city, '城市5\n第二行');
  assert.strictEqual(typeof r.data[0].amount, 'number');
  assert.strictEqual(typeof r.data[0].active, 'boolean');
  console.log(`  解析耗时 ${elapsed}ms（含 JSON 序列化前）`);
  const s2 = Date.now();
  const out = JSON.stringify(r.data, null, 2);
  console.log(`  JSON 序列化 ${Date.now() - s2}ms，输出 ${(out.length / 1024 / 1024).toFixed(1)}MB`);
  assert.ok(elapsed < 2000, `解析超时：${elapsed}ms`);
});

/* 15. 1 万行 JSON -> CSV < 2s */
t('1 万行 JSON 转 CSV < 2s', () => {
  const arr = [];
  for (let i = 0; i < 10000; i++) {
    arr.push({ id: i, name: `用户${i},x`, note: `多\n行${i}`, ok: i % 2 === 0 });
  }
  const start = Date.now();
  const r = jsonToCSV(JSON.stringify(arr), { delimiter: ',', hasHeader: true });
  const elapsed = Date.now() - start;
  assert.strictEqual(r.stats.rows, 10000);
  console.log(`  转换耗时 ${elapsed}ms`);
  assert.ok(elapsed < 2000, `转换超时：${elapsed}ms`);
});

console.log(`\n全部 ${passed} 项测试通过`);
