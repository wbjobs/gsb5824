/* Node 验收测试：直接复用 worker.js 核心逻辑 */
const core = require('./js/worker.js');
const { CsvParser, rowsToJson, jsonToCsv, inferValue } = core;

let passed = 0, failed = 0;
function assert(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}

function parseCsv(text, options) {
  const p = new CsvParser(options || {});
  p.push(text);
  return p.finish();
}
function csv2json(text, options) {
  const p = new CsvParser(options || {});
  p.push(text);
  const warnings = [];
  const r = rowsToJson(p.finish(), options || {}, warnings);
  return { ...r, warnings };
}

console.log('1. 基础 CSV -> JSON（含表头 + 类型推断）');
{
  const { data, headers } = csv2json('name,age,active\n张三,25,true\n李四,3.14,false', { hasHeader: true, inferTypes: true });
  assert(headers.join(',') === 'name,age,active', '表头解析');
  assert(data.length === 2, '行数');
  assert(data[0].name === '张三' && data[0].age === 25 && data[0].active === true, '类型推断 number/boolean/中文', data[0]);
  assert(data[1].age === 3.14 && data[1].active === false, '浮点/false');
}

console.log('2. 特殊字符字段（逗号/引号/换行）');
{
  const csv = 'id,note\n1,"含,逗号"\n2,"含""引号"""\n3,"第一行\n第二行"\n4,"混合, ""字符""\n换行"';
  const { data } = csv2json(csv, { hasHeader: true });
  assert(data[0].note === '含,逗号', '字段内逗号', data[0]);
  assert(data[1].note === '含"引号"', '双引号转义', data[1]);
  assert(data[2].note === '第一行\n第二行', '字段内换行', data[2]);
  assert(data[3].note === '混合, "字符"\n换行', '混合特殊字符', data[3]);
}

console.log('3. BOM 头处理');
{
  const { data, headers } = csv2json('﻿name,age\n张三,25', { hasHeader: true, inferTypes: true });
  assert(headers[0] === 'name', 'BOM 已去除', headers);
  assert(data[0].name === '张三', '中文内容正确');
}

console.log('4. 列数不一致提示');
{
  const { data, warnings } = csv2json('a,b,c\n1,2,3\n4,5\n6,7,8,9', { hasHeader: true });
  const w = warnings.find(x => x.type === 'column_mismatch');
  assert(!!w, '产生列数不一致警告');
  assert(w && w.message.includes('2 行'), '警告含行数统计', w);
  assert(data[1].c === '', '缺失列补空', data[1]);
  assert(Object.keys(data[2]).length === 3, '多余列忽略', data[2]);
}

console.log('5. 空行处理一致');
{
  const rows = parseCsv('a,b\n\n1,2\n   \n3,4\n\n');
  // "   " 行有内容（空格），纯空行跳过
  assert(rows.length === 4, '纯空行被跳过、空格行保留', rows.map(r => r.join('|')));
}

console.log('6. 重复表头处理');
{
  const { headers, warnings, data } = csv2json('id,name,id\n1,张三,2', { hasHeader: true });
  assert(headers.join(',') === 'id,name,id_2', '重复表头追加序号', headers);
  assert(warnings.some(w => w.type === 'duplicate_header'), '产生重复表头警告');
  assert(data[0].id === '1' && data[0].id_2 === '2', '重复列数据都保留');
}

console.log('7. 自定义分隔符');
{
  const { data } = csv2json('a;b\n1;"x;y"', { hasHeader: true, delimiter: ';' });
  assert(data[0].b === 'x;y', '分号分隔 + 字段内分号', data[0]);
  const t = csv2json('a\tb\n1\t2', { hasHeader: true, delimiter: '\t' });
  assert(t.data[0].b === '2', 'Tab 分隔');
}

console.log('8. JSON -> CSV');
{
  const arr = [
    { name: '张三', age: 25, active: true, note: '含,逗号' },
    { name: '李四', age: null, active: false, note: '含"引号"\n换行' }
  ];
  const { csv, headers } = jsonToCsv(arr, { delimiter: ',' });
  assert(headers.join(',') === 'name,age,active,note', '表头为键合集');
  assert(csv.includes('"含,逗号"'), '逗号字段加引号');
  assert(csv.includes('"含""引号""\n换行"'), '引号转义 + 换行字段加引号');
  // 往返：CSV 再解析回来应一致
  const back = csv2json(csv, { hasHeader: true });
  assert(back.data[0].name === '张三' && back.data[1].note === '含"引号"\n换行', 'JSON->CSV->JSON 往返一致');
}

console.log('9. 非法 JSON 报错');
{
  let err = null;
  try { JSON.parse('{invalid json'); } catch (e) { err = e; }
  assert(!!err, 'JSON.parse 抛出异常（Worker 中转为友好提示）');
  let err2 = null;
  try { jsonToCsv(42, {}); } catch (e) { err2 = e; }
  assert(!!err2 && err2.message.includes('对象或数组'), '顶层标量被拒绝', err2 && err2.message);
}

console.log('10. 分块解析（块边界切开引号字段）');
{
  const csv = 'id,note\n1,"跨块\n字段,含""引号"""';
  const p = new CsvParser({ hasHeader: true });
  // 按 1 字符分块喂入，模拟任意块边界
  for (let i = 0; i < csv.length; i++) p.push(csv[i]);
  const rows = p.finish();
  const warnings = [];
  const { data } = rowsToJson(rows, { hasHeader: true }, warnings);
  assert(data[0].note === '跨块\n字段,含"引号"', '1 字符分块解析正确', data[0]);
}

console.log('11. 无表头模式');
{
  const { data, headers } = csv2json('1,2\n3,4', { hasHeader: false });
  assert(headers.join(',') === 'column_1,column_2', '自动生成列名');
  assert(data.length === 2 && data[1].column_2 === '4', '所有行当数据');
}

console.log('12. 1 万行性能（< 2 秒）');
{
  const lines = ['id,name,score,active,备注'];
  for (let i = 0; i < 10000; i++) {
    lines.push(`${i},"用户,${i} ""测试""",${(i * 1.5).toFixed(2)},${i % 2 === 0},"第${i}行\n换行"`);
  }
  const csv = lines.join('\n');
  console.log('  数据量: ' + (csv.length / 1024).toFixed(0) + ' KB, 10000 行');
  const t0 = Date.now();
  const { data } = csv2json(csv, { hasHeader: true, inferTypes: true });
  const jsonText = JSON.stringify(data);
  const dt = Date.now() - t0;
  assert(data.length === 10000, '解析 10000 行');
  assert(data[9999].name === '用户,9999 "测试"', '末行特殊字符正确', data[9999].name);
  assert(typeof data[5].score === 'number' && data[4].active === true, '类型推断正确');
  assert(dt < 2000, `总耗时 ${dt}ms < 2000ms`);
  console.log('  耗时: ' + dt + ' ms, JSON 输出 ' + (jsonText.length / 1024 / 1024).toFixed(2) + ' MB');
}

console.log('13. 1 万行 JSON -> CSV 性能');
{
  const arr = [];
  for (let i = 0; i < 10000; i++) arr.push({ id: i, name: `用户${i}`, ok: i % 2 === 0, note: i % 100 === 0 ? '含,逗号' : null });
  const t0 = Date.now();
  const { csv, rows } = jsonToCsv(arr, { delimiter: ',' });
  const dt = Date.now() - t0;
  assert(rows === 10000, '生成 10000 行');
  assert(dt < 2000, `耗时 ${dt}ms < 2000ms`);
  console.log('  耗时: ' + dt + ' ms');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
