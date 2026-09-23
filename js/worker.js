/*
 * CSV <-> JSON 转换引擎（Web Worker 内运行，主线程不阻塞）
 * 同时在 Node 环境下导出核心函数便于测试。
 */
(function (global) {
  'use strict';

  // ---------- 类型推断 ----------
  var NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  function inferValue(raw) {
    if (raw === '') return '';
    if (NUMBER_RE.test(raw)) {
      var n = Number(raw);
      if (Number.isFinite(n)) return n;
      return raw;
    }
    var lower = raw.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return raw;
  }

  // ---------- 增量 CSV 解析器（状态机，支持分块喂入） ----------
  // 正确处理引号包裹字段内的分隔符 / 双引号转义("") / 换行 / \r\n
  function CsvParser(options) {
    this.delimiter = options.delimiter || ',';
    this.rows = [];
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.afterQuote = false;   // 引号字段刚闭合，等待分隔符或换行
    this.lineTouched = false;  // 当前物理行是否消费过任何字符（空行判断）
    this.started = false;      // 是否已处理 BOM
    this.pendingQuote = false; // 块尾恰好是引号字段内的 '"'，需等下一块判断是否为转义
  }

  CsvParser.prototype.push = function (text) {
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // 去 BOM
    }
    if (this.pendingQuote) {
      text = '"' + text; // 上一块末尾的引号，与本次首字符一起判断
      this.pendingQuote = false;
    }
    var d = this.delimiter;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (this.inQuotes) {
        this.lineTouched = true;
        if (c === '"') {
          if (i + 1 >= text.length) { this.pendingQuote = true; } // 块尾，等待下一块
          else if (text[i + 1] === '"') { this.field += '"'; i++; }
          else { this.inQuotes = false; this.afterQuote = true; }
        } else {
          this.field += c;
        }
        continue;
      }
      if (this.afterQuote) {
        if (c === d) { this.endField(); }
        else if (c === '\r') { this.endRow(); if (text[i + 1] === '\n') i++; }
        else if (c === '\n') { this.endRow(); }
        else { this.field += c; this.afterQuote = false; this.lineTouched = true; } // 容错：引号后杂散字符并入字段
        continue;
      }
      if (c === '"' && this.field === '') {
        this.inQuotes = true; this.lineTouched = true;
      } else if (c === d) {
        this.endField();
      } else if (c === '\r') {
        this.endRow(); if (text[i + 1] === '\n') i++;
      } else if (c === '\n') {
        this.endRow();
      } else {
        this.field += c; this.lineTouched = true;
      }
    }
  };

  CsvParser.prototype.endField = function () {
    this.row.push(this.field);
    this.field = '';
    this.afterQuote = false;
  };

  CsvParser.prototype.endRow = function () {
    // 空行规则：整行未消费任何字符则跳过；"," 这类行保留
    if (this.lineTouched) {
      this.endField();
      this.rows.push(this.row);
    }
    this.row = [];
    this.field = '';
    this.lineTouched = false;
  };

  CsvParser.prototype.finish = function () {
    if (this.pendingQuote) { // 文件以引号字段结尾：视为字段闭合
      this.pendingQuote = false;
      this.inQuotes = false;
      this.afterQuote = true;
    }
    // 文件尾：若还有残留内容则收尾（文件末尾无换行也能收到最后一行）
    if (this.lineTouched || this.row.length > 0 || this.field !== '' || this.inQuotes || this.afterQuote) {
      this.endField();
      this.rows.push(this.row);
      this.row = [];
      this.field = '';
      this.lineTouched = false;
    }
    return this.rows;
  };

  // ---------- CSV 行 -> JSON ----------
  function rowsToJson(rows, options, warnings) {
    if (rows.length === 0) return { data: [], headers: [] };
    var hasHeader = options.hasHeader;
    var infer = options.inferTypes;
    var headers;
    var dataStart;
    if (hasHeader) {
      headers = dedupeHeaders(rows[0], warnings);
      dataStart = 1;
    } else {
      var cols = 0;
      for (var r = 0; r < rows.length; r++) cols = Math.max(cols, rows[r].length);
      headers = [];
      for (var h = 0; h < cols; h++) headers.push('column_' + (h + 1));
      dataStart = 0;
    }
    var expected = headers.length;
    var mismatchCount = 0;
    var mismatchSamples = [];
    var data = [];
    for (var i = dataStart; i < rows.length; i++) {
      var row = rows[i];
      if (row.length !== expected) {
        mismatchCount++;
        if (mismatchSamples.length < 5) {
          mismatchSamples.push({ row: i + 1, expected: expected, actual: row.length });
        }
      }
      var obj = {};
      for (var j = 0; j < expected; j++) {
        var v = j < row.length ? row[j] : '';
        obj[headers[j]] = infer ? inferValue(v) : v;
      }
      data.push(obj);
    }
    if (mismatchCount > 0) {
      warnings.push({
        type: 'column_mismatch',
        message: '发现 ' + mismatchCount + ' 行列数与表头(' + expected + ' 列)不一致，缺失列已补空、多余列已忽略。',
        samples: mismatchSamples
      });
    }
    return { data: data, headers: headers };
  }

  function dedupeHeaders(headerRow, warnings) {
    var seen = {};
    var dups = [];
    var headers = headerRow.map(function (h, idx) {
      var name = h === '' ? 'column_' + (idx + 1) : h;
      if (seen[name]) {
        seen[name]++;
        dups.push(name);
        return name + '_' + seen[name];
      }
      seen[name] = 1;
      return name;
    });
    if (dups.length) {
      var uniq = [];
      dups.forEach(function (d) { if (uniq.indexOf(d) === -1) uniq.push(d); });
      warnings.push({
        type: 'duplicate_header',
        message: '发现重复表头：' + uniq.join('、') + '，已自动追加序号区分。'
      });
    }
    return headers;
  }

  // ---------- JSON -> CSV ----------
  function escapeCsvField(value, delimiter) {
    if (value === null || value === undefined) return '';
    var s;
    if (typeof value === 'object') s = JSON.stringify(value);
    else s = String(value);
    if (s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1 || s.indexOf(delimiter) !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function jsonToCsv(parsed, options) {
    var delimiter = options.delimiter || ',';
    var includeHeader = options.includeHeader !== false;
    var headers = [];
    var rows = [];

    if (!Array.isArray(parsed)) {
      if (parsed !== null && typeof parsed === 'object') parsed = [parsed];
      else throw new Error('JSON 顶层必须是对象或数组');
    }
    if (parsed.length === 0) return { csv: '', headers: [], rows: 0 };

    var allObjects = parsed.every(function (x) { return x !== null && typeof x === 'object' && !Array.isArray(x); });
    var allArrays = parsed.every(function (x) { return Array.isArray(x); });

    if (allObjects) {
      var seen = {};
      parsed.forEach(function (obj) {
        Object.keys(obj).forEach(function (k) {
          if (!seen[k]) { seen[k] = true; headers.push(k); }
        });
      });
      rows = parsed.map(function (obj) {
        return headers.map(function (h) { return escapeCsvField(obj[h], delimiter); }).join(delimiter);
      });
    } else if (allArrays) {
      var cols = 0;
      parsed.forEach(function (a) { cols = Math.max(cols, a.length); });
      for (var c = 0; c < cols; c++) headers.push('column_' + (c + 1));
      rows = parsed.map(function (a) {
        var cells = [];
        for (var i = 0; i < cols; i++) cells.push(escapeCsvField(a[i], delimiter));
        return cells.join(delimiter);
      });
    } else {
      headers = ['value'];
      rows = parsed.map(function (x) { return escapeCsvField(x, delimiter); });
    }

    var lines = [];
    if (includeHeader && headers.length) {
      lines.push(headers.map(function (h) { return escapeCsvField(h, delimiter); }).join(delimiter));
    }
    lines = lines.concat(rows);
    return { csv: lines.join('\r\n'), headers: headers, rows: rows.length };
  }

  // ---------- 导出 ----------
  var core = {
    CsvParser: CsvParser,
    rowsToJson: rowsToJson,
    jsonToCsv: jsonToCsv,
    inferValue: inferValue,
    escapeCsvField: escapeCsvField
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = core;
    return;
  }

  // ---------- Worker 消息协议 ----------
  var session = null;

  global.onmessage = function (e) {
    var msg = e.data;
    try {
      if (msg.type === 'csv2json:start') {
        session = {
          parser: new CsvParser(msg.options),
          options: msg.options,
          t0: Date.now()
        };
        global.postMessage({ type: 'started' });
      } else if (msg.type === 'csv2json:chunk') {
        session.parser.push(msg.text);
        global.postMessage({ type: 'progress', rows: session.parser.rows.length });
      } else if (msg.type === 'csv2json:end') {
        var rows = session.parser.finish();
        var warnings = [];
        var result = rowsToJson(rows, session.options, warnings);
        var text = JSON.stringify(result.data, null, session.options.pretty === false ? 0 : 2);
        global.postMessage({
          type: 'done',
          direction: 'csv2json',
          text: text,
          warnings: warnings,
          stats: { rows: result.data.length, cols: result.headers.length, durationMs: Date.now() - session.t0 }
        });
        session = null;
      } else if (msg.type === 'json2csv') {
        var t0 = Date.now();
        var parsed;
        try {
          parsed = JSON.parse(msg.text);
        } catch (err) {
          global.postMessage({ type: 'error', message: '非法 JSON：' + err.message });
          return;
        }
        var out = jsonToCsv(parsed, msg.options);
        global.postMessage({
          type: 'done',
          direction: 'json2csv',
          text: out.csv,
          warnings: [],
          stats: { rows: out.rows, cols: out.headers.length, durationMs: Date.now() - t0 }
        });
      }
    } catch (err) {
      global.postMessage({ type: 'error', message: err.message || String(err) });
      session = null;
    }
  };
})(typeof self !== 'undefined' ? self : this);
