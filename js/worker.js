/*
 * CSV <-> JSON 转换引擎（运行在 Web Worker 中，主线程不阻塞）。
 * 支持：自定义分隔符、表头开关、类型推断、BOM、引号/逗号/换行字段、
 *       列数不一致提示、空行跳过、重复表头重命名、分块解析 + 进度上报。
 */
'use strict';

const CHUNK_SIZE = 1 << 20; // 每 1MB 字符上报一次进度
const MAX_WARNINGS = 200;   // 警告条数上限，避免超大文件撑爆消息

function stripBOM(text) {
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

function inferValue(raw) {
  if (raw === '') return '';
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true';
  // 整数/小数/科学计数法；保留前导零（如 "007"）为字符串
  if (/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return raw;
}

function makeUniqueHeaders(headers, warnings) {
  const seen = new Map();
  return headers.map((h, idx) => {
    let name = h === '' ? 'column_' + (idx + 1) : h;
    if (seen.has(name)) {
      const count = seen.get(name) + 1;
      seen.set(name, count);
      const renamed = name + '_' + count;
      warnings.push('重复表头 "' + name + '"（第 ' + (idx + 1) + ' 列）已重命名为 "' + renamed + '"');
      return renamed;
    }
    seen.set(name, 1);
    return name;
  });
}

/**
 * 解析 CSV 文本 -> { data, headers, warnings, stats }
 * hasHeader=true  -> data 为对象数组
 * hasHeader=false -> data 为数组的数组
 */
function parseCSV(input, options, onProgress) {
  const startedAt = Date.now();
  const text = stripBOM(input);
  const d = options.delimiter;
  if (!d || d.length !== 1) throw new Error('分隔符必须是单个字符');

  const rows = [];
  const rowLines = [];
  const warnings = [];
  let emptyLines = 0;

  let field = '';
  let row = [];
  let rowChars = 0;      // 当前行是否出现过任何字符（含引号/分隔符）
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;

  const n = text.length;
  let i = 0;
  let nextReport = CHUNK_SIZE;

  function endRow() {
    if (rowChars === 0) {
      emptyLines++; // 纯空行，跳过
    } else {
      rowLines.push(rowLine);
      rows.push(row);
    }
    row = [];
    rowChars = 0;
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else {
        field += c; i++;
      }
    } else if (c === '"') {
      inQuotes = true; rowChars++; i++;
    } else if (c === d) {
      row.push(field); field = ''; rowChars++; i++;
    } else if (c === '\n') {
      row.push(field); field = '';
      endRow(); line++; rowLine = line; i++;
    } else if (c === '\r') {
      row.push(field); field = '';
      endRow(); line++;
      if (text[i + 1] === '\n') i++; // \r\n 只算一行
      rowLine = line; i++;
    } else {
      field += c; rowChars++; i++;
    }
    if (i >= nextReport) {
      if (onProgress) onProgress(i / n);
      nextReport = i + CHUNK_SIZE;
    }
  }
  if (inQuotes) warnings.push('警告：存在未闭合的引号，文件可能被截断');
  if (field !== '' || row.length > 0 || rowChars > 0) {
    row.push(field);
    endRow();
  }

  if (rows.length === 0) throw new Error('CSV 内容为空（' + emptyLines + ' 个空行已跳过）');

  // 列数一致性检查：以首行为基准，短行补空、长行保留多余值并提示
  const expected = rows[0].length;
  let mismatchCount = 0;
  let maxCols = expected;
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length > maxCols) maxCols = rows[r].length;
  }
  const dataStart = options.hasHeader ? 1 : 0;
  for (let r = dataStart; r < rows.length; r++) {
    const actual = rows[r].length;
    if (actual !== expected) {
      mismatchCount++;
      if (warnings.length < MAX_WARNINGS) {
        warnings.push('第 ' + rowLines[r] + ' 行列数不一致：期望 ' + expected + ' 列，实际 ' + actual + ' 列');
      }
    }
    if (actual < maxCols) {
      while (rows[r].length < maxCols) rows[r].push('');
    }
  }
  if (mismatchCount > MAX_WARNINGS) {
    warnings.push('……共 ' + mismatchCount + ' 行列数不一致（仅显示前 ' + MAX_WARNINGS + ' 条）');
  }

  let headers;
  let dataRows;
  if (options.hasHeader) {
    headers = rows[0].map(String);
    // 长行多出的列生成额外表头
    while (headers.length < maxCols) headers.push('extra_' + (headers.length - expected + 1));
    headers = makeUniqueHeaders(headers, warnings);
    dataRows = rows.slice(1);
  } else {
    headers = null;
    dataRows = rows;
  }

  const infer = options.inferTypes;
  let data;
  if (headers) {
    data = new Array(dataRows.length);
    for (let r = 0; r < dataRows.length; r++) {
      const obj = {};
      const rowVals = dataRows[r];
      for (let c = 0; c < headers.length; c++) {
        const v = rowVals[c];
        obj[headers[c]] = infer ? inferValue(v) : v;
      }
      data[r] = obj;
    }
  } else {
    data = new Array(dataRows.length);
    for (let r = 0; r < dataRows.length; r++) {
      data[r] = infer ? dataRows[r].map(inferValue) : dataRows[r];
    }
  }

  return {
    data: data,
    headers: headers,
    warnings: warnings,
    stats: {
      rows: dataRows.length,
      cols: headers ? headers.length : maxCols,
      emptyLines: emptyLines,
      mismatchRows: mismatchCount,
      durationMs: Date.now() - startedAt
    }
  };
}

function csvEscape(value, delimiter) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (s.indexOf(delimiter) !== -1 || s.indexOf('"') !== -1 ||
      s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * JSON 文本 -> CSV 文本。支持对象数组、数组的数组、NDJSON（按行解析兜底）。
 */
function jsonToCSV(input, options, onProgress) {
  const startedAt = Date.now();
  const text = stripBOM(input);
  const d = options.delimiter;
  if (!d || d.length !== 1) throw new Error('分隔符必须是单个字符');

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    // 兜底：尝试 NDJSON（每行一个 JSON 对象）
    const lines = text.split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    try {
      data = lines.map(function (l) { return JSON.parse(l); });
    } catch (e2) {
      throw new Error('非法 JSON：' + e.message);
    }
  }
  if (!Array.isArray(data)) data = [data];
  if (data.length === 0) throw new Error('JSON 数组为空，没有可转换的数据');

  const isObjectRow = data.every(function (v) { return v !== null && typeof v === 'object' && !Array.isArray(v); });
  const isArrayRow = data.every(function (v) { return Array.isArray(v); });

  let headers = null;
  if (isObjectRow) {
    headers = [];
    const seen = new Set();
    for (let r = 0; r < data.length; r++) {
      const keys = Object.keys(data[r]);
      for (let k = 0; k < keys.length; k++) {
        if (!seen.has(keys[k])) { seen.add(keys[k]); headers.push(keys[k]); }
      }
    }
  } else if (!isArrayRow) {
    // 标量或混合：统一包装成 {value: x}
    data = data.map(function (v) { return { value: v }; });
    headers = ['value'];
  }

  const lines = [];
  if (options.hasHeader && headers) {
    lines.push(headers.map(function (h) { return csvEscape(h, d); }).join(d));
  }

  const total = data.length;
  let nextReport = Math.max(1, Math.floor(total / 50));
  for (let r = 0; r < total; r++) {
    let line;
    if (headers) {
      const obj = data[r];
      const cells = new Array(headers.length);
      for (let c = 0; c < headers.length; c++) cells[c] = csvEscape(obj[headers[c]], d);
      line = cells.join(d);
    } else {
      line = data[r].map(function (v) { return csvEscape(v, d); }).join(d);
    }
    lines.push(line);
    if (r >= nextReport) {
      if (onProgress) onProgress(r / total);
      nextReport = r + Math.max(1, Math.floor(total / 50));
    }
  }

  return {
    csv: lines.join('\r\n'),
    warnings: [],
    stats: {
      rows: data.length,
      cols: headers ? headers.length : (isArrayRow ? Math.max.apply(null, data.map(function (a) { return a.length; })) : 1),
      emptyLines: 0,
      mismatchRows: 0,
      durationMs: Date.now() - startedAt
    }
  };
}

function convert(request, onProgress) {
  if (request.direction === 'csv2json') {
    const result = parseCSV(request.text, request.options, onProgress);
    return {
      output: JSON.stringify(result.data, null, 2),
      warnings: result.warnings,
      stats: result.stats
    };
  }
  const result = jsonToCSV(request.text, request.options, onProgress);
  return { output: result.csv, warnings: result.warnings, stats: result.stats };
}

/* ---- Web Worker 入口 ---- */
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof module === 'undefined') {
  self.onmessage = function (e) {
    const req = e.data;
    try {
      const result = convert(req, function (ratio) {
        self.postMessage({ type: 'progress', ratio: ratio });
      });
      self.postMessage({
        type: 'result',
        output: result.output,
        warnings: result.warnings,
        stats: result.stats
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: err.message || String(err) });
    }
  };
}

/* ---- Node 测试导出 ---- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseCSV: parseCSV, jsonToCSV: jsonToCSV, convert: convert, inferValue: inferValue };
}
