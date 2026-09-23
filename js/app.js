/* 主线程：DOM 交互、文件分块读取、Worker 调度、Blob 导出、历史记录 */
(function () {
  'use strict';

  var CHUNK_SIZE = 1024 * 1024;      // 1MB 分块读取大文件
  var PREVIEW_LIMIT = 100 * 1024;    // 输出区最多渲染 100KB，防止大结果卡 UI

  function $(id) { return document.getElementById(id); }

  var els = {
    direction: $('direction'),
    delimiter: $('delimiter'),
    customDelimiter: $('customDelimiter'),
    hasHeader: $('hasHeader'),
    inferTypes: $('inferTypes'),
    includeHeader: $('includeHeader'),
    optCsv2json: $('optCsv2json'),
    optJson2csv: $('optJson2csv'),
    input: $('input'),
    output: $('output'),
    fileInput: $('fileInput'),
    pickFileBtn: $('pickFileBtn'),
    convertBtn: $('convertBtn'),
    exportBtn: $('exportBtn'),
    copyBtn: $('copyBtn'),
    clearBtn: $('clearBtn'),
    status: $('status'),
    warnings: $('warnings'),
    progress: $('progress'),
    progressBar: $('progressBar'),
    historyList: $('historyList'),
    clearHistoryBtn: $('clearHistoryBtn'),
    outputNote: $('outputNote')
  };

  var state = {
    worker: null,
    resultText: '',
    resultExt: 'json',
    inputText: ''
  };

  // ---------- 选项 ----------
  function getDirection() { return els.direction.value; }

  function getDelimiter() {
    var v = els.delimiter.value;
    if (v === 'custom') return els.customDelimiter.value || ',';
    if (v === '\\t') return '\t';
    return v;
  }

  function getOptions() {
    return {
      delimiter: getDelimiter(),
      hasHeader: els.hasHeader.checked,
      inferTypes: els.inferTypes.checked,
      includeHeader: els.includeHeader.checked
    };
  }

  function syncOptionVisibility() {
    var csv2json = getDirection() === 'csv2json';
    els.optCsv2json.style.display = csv2json ? '' : 'none';
    els.optJson2csv.style.display = csv2json ? 'none' : '';
    els.input.placeholder = csv2json
      ? '在此粘贴 CSV，或拖入 / 选择 .csv 文件…'
      : '在此粘贴 JSON（对象数组），或拖入 / 选择 .json 文件…';
  }

  els.direction.addEventListener('change', syncOptionVisibility);
  els.delimiter.addEventListener('change', function () {
    els.customDelimiter.style.display = els.delimiter.value === 'custom' ? '' : 'none';
  });

  // ---------- 状态/提示 ----------
  function setStatus(msg, kind) {
    els.status.textContent = msg;
    els.status.className = 'status ' + (kind || '');
  }

  function showWarnings(list) {
    els.warnings.innerHTML = '';
    if (!list || !list.length) { els.warnings.style.display = 'none'; return; }
    els.warnings.style.display = '';
    list.forEach(function (w) {
      var div = document.createElement('div');
      div.className = 'warning-item';
      div.textContent = '⚠ ' + w.message;
      if (w.samples && w.samples.length) {
        var ul = document.createElement('ul');
        w.samples.forEach(function (s) {
          var li = document.createElement('li');
          li.textContent = '第 ' + s.row + ' 行：期望 ' + s.expected + ' 列，实际 ' + s.actual + ' 列';
          ul.appendChild(li);
        });
        div.appendChild(ul);
      }
      els.warnings.appendChild(div);
    });
  }

  function setProgress(ratio, label) {
    if (ratio === null) { els.progress.style.display = 'none'; return; }
    els.progress.style.display = '';
    els.progressBar.style.width = Math.round(ratio * 100) + '%';
    els.progress.title = label || '';
  }

  // ---------- Worker ----------
  function ensureWorker() {
    if (state.worker) state.worker.terminate();
    state.worker = new Worker('js/worker.js');
    return state.worker;
  }

  function renderResult(text, ext) {
    state.resultText = text;
    state.resultExt = ext;
    if (text.length > PREVIEW_LIMIT) {
      els.output.value = text.slice(0, PREVIEW_LIMIT);
      els.outputNote.textContent = '结果共 ' + formatSize(text.length) + '，仅预览前 100KB，完整内容请导出或复制。';
    } else {
      els.output.value = text;
      els.outputNote.textContent = '';
    }
    els.exportBtn.disabled = !text;
    els.copyBtn.disabled = !text;
  }

  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function runConversion(inputText, file) {
    var direction = getDirection();
    var options = getOptions();
    var worker = ensureWorker();
    var t0 = performance.now();

    setStatus('转换中…', 'busy');
    showWarnings([]);
    els.convertBtn.disabled = true;

    worker.onmessage = function (e) {
      var msg = e.data;
      if (msg.type === 'progress') {
        setStatus('解析中… 已处理 ' + msg.rows.toLocaleString() + ' 行', 'busy');
        if (file && file.size) {
          setProgress(Math.min(0.99, bytesSent / file.size));
        }
      } else if (msg.type === 'done') {
        var total = Math.round(performance.now() - t0);
        setProgress(null);
        els.convertBtn.disabled = false;
        renderResult(msg.text, msg.direction === 'csv2json' ? 'json' : 'csv');
        showWarnings(msg.warnings);
        setStatus(
          '完成：' + msg.stats.rows.toLocaleString() + ' 行 × ' + msg.stats.cols + ' 列，' +
          '耗时 ' + total + ' ms（Worker 内 ' + msg.stats.durationMs + ' ms）',
          'ok'
        );
        HistoryDB.add({
          direction: msg.direction,
          options: options,
          rows: msg.stats.rows,
          cols: msg.stats.cols,
          durationMs: total,
          warnings: msg.warnings,
          input: inputText,
          result: msg.text
        }).then(refreshHistory).catch(function () {});
      } else if (msg.type === 'error') {
        setProgress(null);
        els.convertBtn.disabled = false;
        setStatus(msg.message, 'error');
      }
    };

    worker.onerror = function (err) {
      setProgress(null);
      els.convertBtn.disabled = false;
      setStatus('Worker 错误：' + err.message, 'error');
    };

    var bytesSent = 0;

    if (direction === 'json2csv') {
      worker.postMessage({ type: 'json2csv', text: inputText, options: options });
      return;
    }

    // csv2json：分块发送（大文件不一次性读入内存解析）
    worker.postMessage({ type: 'csv2json:start', options: options });

    function sendChunks(text) {
      for (var pos = 0; pos < text.length; pos += CHUNK_SIZE) {
        worker.postMessage({ type: 'csv2json:chunk', text: text.slice(pos, pos + CHUNK_SIZE) });
        bytesSent = Math.min(text.length, pos + CHUNK_SIZE);
      }
      worker.postMessage({ type: 'csv2json:end' });
    }

    if (file) {
      // 超大文件：按 1MB slice 异步读取，逐块喂给 Worker
      var offset = 0;
      setProgress(0);
      (function readNext() {
        var slice = file.slice(offset, offset + CHUNK_SIZE);
        slice.text().then(function (text) {
          worker.postMessage({ type: 'csv2json:chunk', text: text });
          offset += slice.size;
          bytesSent = offset;
          setProgress(Math.min(0.99, offset / file.size));
          if (offset < file.size) readNext();
          else worker.postMessage({ type: 'csv2json:end' });
        }).catch(function (err) {
          setProgress(null);
          els.convertBtn.disabled = false;
          setStatus('文件读取失败：' + err.message, 'error');
        });
      })();
    } else {
      sendChunks(inputText);
    }
  }

  // ---------- 事件 ----------
  els.convertBtn.addEventListener('click', function () {
    var text = els.input.value;
    if (!text.trim()) { setStatus('请先输入或导入内容', 'error'); return; }
    state.inputText = text;
    runConversion(text, null);
  });

  els.pickFileBtn.addEventListener('click', function () { els.fileInput.click(); });

  els.fileInput.addEventListener('change', function () {
    if (els.fileInput.files[0]) handleFile(els.fileInput.files[0]);
    els.fileInput.value = '';
  });

  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  function handleFile(file) {
    setStatus('已选择文件：' + file.name + '（' + formatSize(file.size) + '）', '');
    if (getDirection() === 'csv2json') {
      // 直接分块流式处理，不把整个文件塞进输入框
      state.inputText = '[文件] ' + file.name;
      els.input.value = '';
      runConversion(null, file);
    } else {
      file.text().then(function (text) {
        els.input.value = text;
        setStatus('文件已载入输入框，点击“开始转换”', 'ok');
      });
    }
  }

  els.exportBtn.addEventListener('click', function () {
    if (!state.resultText) return;
    // CSV 导出加 BOM，保证 Excel 打开中文不乱码
    var bom = state.resultExt === 'csv' ? '\uFEFF' : '';
    var mime = state.resultExt === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    var blob = new Blob([bom + state.resultText], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'export-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + state.resultExt;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  els.copyBtn.addEventListener('click', function () {
    if (!state.resultText) return;
    navigator.clipboard.writeText(state.resultText).then(function () {
      setStatus('已复制到剪贴板', 'ok');
    });
  });

  els.clearBtn.addEventListener('click', function () {
    els.input.value = '';
    els.output.value = '';
    els.outputNote.textContent = '';
    state.resultText = '';
    els.exportBtn.disabled = true;
    els.copyBtn.disabled = true;
    showWarnings([]);
    setStatus('就绪', '');
  });

  // ---------- 历史记录 ----------
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function refreshHistory() {
    return HistoryDB.list(50).then(function (items) {
      els.historyList.innerHTML = '';
      if (!items.length) {
        els.historyList.innerHTML = '<li class="empty">暂无历史记录</li>';
        return;
      }
      items.forEach(function (item) {
        var li = document.createElement('li');
        var dirLabel = item.direction === 'csv2json' ? 'CSV→JSON' : 'JSON→CSV';
        var warn = item.warnings && item.warnings.length ? ' ⚠' : '';
        var main = document.createElement('button');
        main.className = 'history-load';
        main.textContent = fmtTime(item.ts) + ' · ' + dirLabel + ' · ' +
          item.rows.toLocaleString() + ' 行 · ' + item.durationMs + 'ms' + warn +
          (item.hasFullResult ? '' : '（仅预览）');
        main.title = '点击载入结果';
        main.addEventListener('click', function () {
          HistoryDB.get(item.id).then(function (rec) {
            if (!rec) return;
            var text = rec.resultText !== null ? rec.resultText : rec.resultPreview;
            renderResult(text, rec.direction === 'csv2json' ? 'json' : 'csv');
            showWarnings(rec.warnings);
            setStatus('已载入历史记录（' + fmtTime(rec.ts) + '）', 'ok');
          });
        });
        var del = document.createElement('button');
        del.className = 'history-del';
        del.textContent = '删除';
        del.addEventListener('click', function () {
          HistoryDB.remove(item.id).then(refreshHistory);
        });
        li.appendChild(main);
        li.appendChild(del);
        els.historyList.appendChild(li);
      });
    }).catch(function () {
      els.historyList.innerHTML = '<li class="empty">历史记录不可用（IndexedDB 被禁用）</li>';
    });
  }

  els.clearHistoryBtn.addEventListener('click', function () {
    HistoryDB.clear().then(refreshHistory);
  });

  // ---------- 初始化 ----------
  syncOptionVisibility();
  els.exportBtn.disabled = true;
  els.copyBtn.disabled = true;
  setStatus('就绪', '');
  refreshHistory();
})();
