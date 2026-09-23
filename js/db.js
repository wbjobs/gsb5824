/* IndexedDB 历史记录存储 */
(function (global) {
  'use strict';

  var DB_NAME = 'csvjson-converter';
  var DB_VERSION = 1;
  var STORE = 'history';
  var MAX_STORED_RESULT = 500 * 1024; // 超过 500KB 的结果只存预览

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var store = t.objectStore(STORE);
      var result = fn(store);
      t.oncomplete = function () { resolve(result && result._value); };
      t.onerror = function () { reject(t.error); };
      if (result && result.request) {
        result.request.onsuccess = function () { result._value = result.request.result; };
      }
    });
  }

  var HistoryDB = {
    add: function (entry) {
      var record = {
        ts: Date.now(),
        direction: entry.direction,
        options: entry.options,
        rows: entry.rows,
        cols: entry.cols,
        durationMs: entry.durationMs,
        warnings: entry.warnings || [],
        inputPreview: (entry.input || '').slice(0, 2048),
        resultPreview: (entry.result || '').slice(0, 5120),
        resultText: (entry.result || '').length <= MAX_STORED_RESULT ? entry.result : null
      };
      return open().then(function (db) {
        return tx(db, 'readwrite', function (store) {
          var out = { request: store.add(record) };
          return out;
        });
      });
    },

    list: function (limit) {
      return open().then(function (db) {
        return new Promise(function (resolve, reject) {
          var items = [];
          var t = db.transaction(STORE, 'readonly');
          var req = t.objectStore(STORE).index('ts').openCursor(null, 'prev');
          req.onsuccess = function () {
            var cursor = req.result;
            if (cursor && items.length < (limit || 50)) {
              var v = cursor.value;
              items.push({
                id: v.id, ts: v.ts, direction: v.direction, options: v.options,
                rows: v.rows, cols: v.cols, durationMs: v.durationMs,
                warnings: v.warnings, inputPreview: v.inputPreview,
                resultPreview: v.resultPreview, hasFullResult: v.resultText !== null
              });
              cursor.continue();
            } else {
              resolve(items);
            }
          };
          req.onerror = function () { reject(req.error); };
        });
      });
    },

    get: function (id) {
      return open().then(function (db) {
        return tx(db, 'readonly', function (store) {
          return { request: store.get(id) };
        });
      });
    },

    remove: function (id) {
      return open().then(function (db) {
        return tx(db, 'readwrite', function (store) { store.delete(id); });
      });
    },

    clear: function () {
      return open().then(function (db) {
        return tx(db, 'readwrite', function (store) { store.clear(); });
      });
    }
  };

  global.HistoryDB = HistoryDB;
})(typeof self !== 'undefined' ? self : this);
