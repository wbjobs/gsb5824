/* 主线程：DOM 交互、Web Worker 调度、Blob 导出、IndexedDB 历史记录 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const els = {
    direction: $('direction'),
    delimiter: $('delimiter'),
    customDelimiter: $('customDelimiter'),
    hasHeader: $('hasHeader'),
    inferTypes: $('inferTypes'),
    inferTypesRow: $('inferTypesRow'),
    input: $('input'),
    output: $('output'),
    fileInput: $('fileInput'),
    fileInfo: $('fileInfo'),
    convertBtn: $('convertBtn'),
    swapBtn: $('swapBtn'),
    downloadBtn: $('downloadBtn'),
    copyBtn: $('copyBtn'),
    clearBtn: $('clearBtn'),
    progress: $('progress'),
    progressBar: $('progressBar'),
    status: $('status'),
    warnings: $('warnings'),
    historyList: $('historyList'),
    clearHistoryBtn: $('clearHistoryBtn')
  };

  const MAX_TEXTAREA_CHARS = 5 * 1024 * 1024; // 超过 5MB 不回显到输入框，避免卡顿
  const MAX_STORE_CHARS = 512 * 1024;         // 历史记录中完整保存的上限
  let inputText = '';                          // 完整输入内容（可能未回显）
  let lastOutput = null;                       // { text, filename, mime }
  let worker = null;

  /* ---------- 分隔符 ---------- */
  function getDelimiter() {
    const v = els.delimiter.value;
    if (v === 'custom') return els.customDelimiter.value;
    if (v === 'tab') return '\t';
    return v;
  }

  els.delimiter.addEventListener('change', () => {
    els.customDelimiter.style.display = els.delimiter.value === 'custom' ? '' : 'none';
  });

  els.direction.addEventListener('change', () => {
    const isCsv2Json = els.direction.value === 'csv2json';
    els.inferTypesRow.style.display = isCsv2Json ? '' : 'none';
    els.input.placeholder = isCsv2Json
      ? '粘贴 CSV 文本，或点击"选择文件"导入 .csv …'
      : '粘贴 JSON 文本（对象数组 / 数组的数组 / NDJSON）…';
    setStatus('');
  });

  /* ---------- 文件导入 ---------- */
  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files[0];
    if (!file) return;
    els.fileInfo.textContent = `读取中：${file.name}（${formatSize(file.size)}）…`;
    try {
      inputText = await file.text(); // 浏览器自动处理 UTF-8 BOM
      if (inputText.length > MAX_TEXTAREA_CHARS) {
        els.input.value = '';
        els.input.placeholder = `已载入 ${formatSize(inputText.length)}，内容过大不回显（防止卡顿），可直接点击"开始转换"`;
      } else {
        els.input.value = inputText;
      }
      els.fileInfo.textContent = `已载入：${file.name}（${formatSize(file.size)}）`;
    } catch (err) {
      els.fileInfo.textContent = '文件读取失败：' + err.message;
    }
  });

  els.input.addEventListener('input', () => { inputText = els.input.value; });

  /* ---------- 转换（Web Worker） ---------- */
  els.convertBtn.addEventListener('click', () => {
    const text = inputText || els.input.value;
    if (!text.trim()) { setStatus('请先输入或导入内容', true); return; }

    const options = {
      delimiter: getDelimiter(),
      hasHeader: els.hasHeader.checked,
      inferTypes: els.inferTypes.checked
    };
    if (!options.delimiter || options.delimiter.length !== 1) {
      setStatus('自定义分隔符必须是单个字符', true); return;
    }

    if (worker) worker.terminate();
    worker = new Worker('js/worker.js');

    const startedAt = performance.now();
    setBusy(true);
    setProgress(0);
    setStatus('转换中…');
    els.warnings.innerHTML = '';
    els.output.value = '';

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.ratio);
      } else if (msg.type === 'result') {
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
        finishConvert(msg, elapsed, options);
      } else if (msg.type === 'error') {
        setBusy(false);
        setProgress(0);
        setStatus('转换失败：' + msg.message, true);
      }
    };
    worker.onerror = (err) => {
      setBusy(false);
      setStatus('Worker 错误：' + err.message, true);
    };

    worker.postMessage({
      direction: els.direction.value,
      text: text,
      options: options
    });
  });

  function finishConvert(msg, elapsed, options) {
    setBusy(false);
    setProgress(1);
    const isCsv2Json = els.direction.value === 'csv2json';
    els.output.value = msg.output;
    lastOutput = {
      text: msg.output,
      filename: 'export_' + timestamp() + (isCsv2Json ? '.json' : '.csv'),
      mime: isCsv2Json ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    };
    els.downloadBtn.disabled = false;
    els.copyBtn.disabled = false;

    const s = msg.stats;
    setStatus(`完成：${s.rows} 行 × ${s.cols} 列，耗时 ${elapsed}s` +
      (s.emptyLines ? `，跳过空行 ${s.emptyLines} 个` : '') +
      (s.mismatchRows ? `，列数不一致 ${s.mismatchRows} 行` : ''));
    renderWarnings(msg.warnings);
    saveHistory({
      time: Date.now(),
      direction: els.direction.value,
      options: options,
      rows: s.rows,
      cols: s.cols,
      duration: elapsed,
      warningCount: msg.warnings.length,
      input: inputText || els.input.value,
      output: msg.output
    });
  }

  function renderWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
      els.warnings.innerHTML = '';
      return;
    }
    const ul = document.createElement('ul');
    warnings.forEach((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      ul.appendChild(li);
    });
    els.warnings.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'warnings-title';
    title.textContent = `⚠ ${warnings.length} 条提示`;
    els.warnings.appendChild(title);
    els.warnings.appendChild(ul);
  }

  /* ---------- 导出 / 复制 ---------- */
  els.downloadBtn.addEventListener('click', () => {
    if (!lastOutput) return;
    // 加 BOM，保证 Excel 打开 CSV 中文不乱码
    const blob = new Blob(['﻿' + lastOutput.text], { type: lastOutput.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = lastOutput.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  els.copyBtn.addEventListener('click', async () => {
    if (!lastOutput) return;
    try {
      await navigator.clipboard.writeText(lastOutput.text);
      setStatus('已复制到剪贴板');
    } catch {
      els.output.select();
      document.execCommand('copy');
      setStatus('已复制到剪贴板');
    }
  });

  els.swapBtn.addEventListener('click', () => {
    if (!lastOutput) return;
    els.direction.value = els.direction.value === 'csv2json' ? 'json2csv' : 'csv2json';
    els.direction.dispatchEvent(new Event('change'));
    els.input.value = lastOutput.text;
    inputText = lastOutput.text;
    setStatus('已将输出填入输入框并切换方向，可直接再次转换');
  });

  els.clearBtn.addEventListener('click', () => {
    els.input.value = ''; els.output.value = ''; inputText = ''; lastOutput = null;
    els.fileInput.value = ''; els.fileInfo.textContent = '';
    els.warnings.innerHTML = '';
    els.downloadBtn.disabled = true; els.copyBtn.disabled = true;
    setProgress(0); setStatus('');
  });

  /* ---------- IndexedDB 历史记录 ---------- */
  const dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('csv-json-converter', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  function store(mode, fn) {
    return dbPromise.then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction('history', mode);
      const result = fn(tx.objectStore('history'));
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
    }));
  }

  async function saveHistory(record) {
    const trim = (s) => s.length > MAX_STORE_CHARS
      ? { text: s.slice(0, MAX_STORE_CHARS), truncated: true, fullLength: s.length }
      : { text: s, truncated: false };
    try {
      await store('readwrite', (os) => os.add({
        time: record.time,
        direction: record.direction,
        options: record.options,
        rows: record.rows,
        cols: record.cols,
        duration: record.duration,
        warningCount: record.warningCount,
        input: trim(record.input),
        output: trim(record.output)
      }));
      loadHistory();
    } catch (err) {
      console.warn('历史保存失败', err);
    }
  }

  async function loadHistory() {
    try {
      const items = await store('readonly', (os) => os.getAll());
      renderHistory(items.sort((a, b) => b.time - a.time).slice(0, 20));
    } catch (err) {
      console.warn('历史读取失败', err);
    }
  }

  function renderHistory(items) {
    els.historyList.innerHTML = '';
    if (items.length === 0) {
      els.historyList.innerHTML = '<li class="empty">暂无历史记录</li>';
      return;
    }
    items.forEach((item) => {
      const li = document.createElement('li');
      const dirLabel = item.direction === 'csv2json' ? 'CSV→JSON' : 'JSON→CSV';
      const info = document.createElement('span');
      info.className = 'history-info';
      info.textContent = `${new Date(item.time).toLocaleString()} · ${dirLabel} · ${item.rows}行×${item.cols}列 · ${item.duration}s` +
        (item.warningCount ? ` · ${item.warningCount}条提示` : '');
      const restore = document.createElement('button');
      restore.textContent = '恢复';
      restore.addEventListener('click', () => restoreHistory(item));
      const del = document.createElement('button');
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        await store('readwrite', (os) => os.delete(item.id));
        loadHistory();
      });
      li.appendChild(info);
      li.appendChild(restore);
      li.appendChild(del);
      els.historyList.appendChild(li);
    });
  }

  function restoreHistory(item) {
    els.direction.value = item.direction;
    els.direction.dispatchEvent(new Event('change'));
    els.hasHeader.checked = item.options.hasHeader;
    els.inferTypes.checked = item.options.inferTypes;
    inputText = item.input.text;
    els.input.value = item.input.truncated ? '' : item.input.text;
    if (item.input.truncated) {
      els.input.placeholder = `历史内容过大（${formatSize(item.input.fullLength)}），仅恢复前 ${formatSize(MAX_STORE_CHARS)}`;
      els.input.value = item.input.text;
    }
    els.output.value = item.output.text;
    lastOutput = {
      text: item.output.text,
      filename: 'export_' + timestamp() + (item.direction === 'csv2json' ? '.json' : '.csv'),
      mime: item.direction === 'csv2json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8'
    };
    els.downloadBtn.disabled = false;
    els.copyBtn.disabled = false;
    setStatus('已恢复历史记录' + (item.input.truncated || item.output.truncated ? '（内容已截断）' : ''));
  }

  els.clearHistoryBtn.addEventListener('click', async () => {
    await store('readwrite', (os) => os.clear());
    loadHistory();
  });

  /* ---------- 工具 ---------- */
  function setBusy(busy) {
    els.convertBtn.disabled = busy;
    els.convertBtn.textContent = busy ? '转换中…' : '开始转换';
  }
  function setProgress(ratio) {
    els.progress.style.display = ratio > 0 && ratio < 1 ? '' : 'none';
    els.progressBar.style.width = Math.round(ratio * 100) + '%';
  }
  function setStatus(msg, isError) {
    els.status.textContent = msg;
    els.status.className = isError ? 'error' : '';
  }
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }
  function timestamp() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  els.direction.dispatchEvent(new Event('change'));
  loadHistory();
})();
