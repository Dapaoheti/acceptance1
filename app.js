/**
 * JF费用验收 v6.0
 * 优化：变量可读性 / IndexedDB 连接缓存 / 错误处理 / 兼容性
 */
console.log("=== JF v6.0 ===");

/* ===================== 配置常量 ===================== */
var DB_NAME = "JFV53";
var DB_STORE = "ph";
var DB_INDEX_KEY = "***";
var IMG_MAX_SIZE = 1400;
var JPEG_QUALITY = 0.7;

/* ===================== 应用状态 ===================== */
var currentProject = null;
var currentIndex = -1;
var cameraStream = null;
var pendingImport = null;
var pdfBlob = null;
var viewerIndex = 0;
var viewerPhotos = [];
var isGalleryProcessing = false;
var deleteTargetKey = null;

/* ===================== 缓存的 IndexedDB 连接 ===================== */
var cachedDb = null;

/* ===================== 工具函数 ===================== */
function padZero(n) { return String(n).padStart(2, "0"); }

function escapeHtml(str) {
  var el = document.createElement("div");
  el.textContent = str;
  return el.innerHTML;
}

function escapeForPdf(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatTimestamp(str) {
  if (!str) return "";
  var m = str.match(/^\d{4}-(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return m ? m[1] + " " + m[2] : str;
}

function formatDate(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + "/" + d.getDate() + " " + padZero(d.getHours()) + ":" + padZero(d.getMinutes());
}

/* ===================== IndexedDB（缓存连接） ===================== */
function openDb() {
  return new Promise(function (resolve, reject) {
    if (cachedDb) { resolve(cachedDb); return; }
    var request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = function (e) {
      cachedDb = e.target.result;
      resolve(cachedDb);
    };
    request.onerror = function (e) { reject(e.target.error); };
  });
}

function dbPut(key, value, retries) {
  retries = retries || 2;
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function (e) { reject(e.target.error || tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  }).catch(function (err) {
    if (retries > 0) {
      return new Promise(function (r) { setTimeout(r, 300); }).then(function () {
        return dbPut(key, value, retries - 1);
      });
    }
    return Promise.reject(err);
  });
}

function dbGet(key) {
  return openDb().then(function (db) {
    return new Promise(function (resolve) {
      var tx = db.transaction(DB_STORE, "readonly");
      var req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
    });
  }).catch(function () { return null; });
}

function dbDel(key) {
  return openDb().then(function (db) {
    db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).delete(key);
  }).catch(function () {});
}

/* ===================== 项目索引管理 ===================== */
function getIndex() {
  return dbGet(DB_INDEX_KEY).then(function (raw) {
    if (!raw) return [];
    try { return JSON.parse(raw); } catch (e) { return []; }
  }).catch(function () { return []; });
}

function saveIndex(idx) { return dbPut(DB_INDEX_KEY, JSON.stringify(idx)); }

function updateProjectIndex() {
  if (!currentProject || !currentProject.key) return;
  getIndex().then(function (idx) {
    var found = false;
    var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
    for (var i = 0; i < idx.length; i++) {
      if (idx[i].key === currentProject.key) {
        idx[i].name = currentProject.name;
        idx[i].done = doneCount;
        idx[i].total = currentProject.items.length;
        idx[i].updatedAt = Date.now();
        found = true;
        break;
      }
    }
    if (!found) {
      idx.push({
        key: currentProject.key, name: currentProject.name,
        done: doneCount, total: currentProject.items.length, updatedAt: Date.now()
      });
    }
    saveIndex(idx);
  });
}

/* ===================== 项目数据持久化 ===================== */
function saveProject() {
  if (!currentProject || !currentProject.key) return;
  var data = {
    key: currentProject.key, name: currentProject.name, createdAt: currentProject.createdAt,
    items: currentProject.items.map(function (item) {
      return {
        sortKey: item.sortKey, displayNum: item.displayNum, displayName: item.displayName,
        origQty: item.origQty, origUnit: item.origUnit, origPrice: item.origPrice, origAmount: item.origAmount,
        quoteQty: item.quoteQty, quotePrice: item.quotePrice,
        acceptQty: item.acceptQty || "", acceptPrice: item.acceptPrice || "",
        acceptAmount: item.acceptAmount || "", remark: item.remark || "",
        photos: item.photos.map(function (p) { return { date: p.date, location: p.location }; }),
        accepted: item.accepted
      };
    })
  };
  dbPut(currentProject.key, JSON.stringify(data)).catch(function (e) { console.error("saveProject:", e); });
  updateProjectIndex();
}

function loadProjectData(key) {
  return dbGet(key).then(function (raw) {
    if (!raw) return null;
    var data = JSON.parse(raw);
    if (!data || !data.items) return null;
    return Promise.all(data.items.map(function (item) {
      return Promise.all((item.photos || []).map(function (photo, j) {
        return dbGet(photoDataKey(key, item.sortKey, j)).then(function (url) {
          if (url) photo.dataUrl = url;
        });
      })).then(function () { return item; });
    })).then(function () { return data; });
  }).catch(function () { return null; });
}

function deleteProject(key) {
  return loadProjectData(key).then(function (data) {
    if (data && data.items) {
      data.items.forEach(function (item) {
        for (var j = 0; j < (item.photos || []).length; j++) {
          dbDel(photoDataKey(key, item.sortKey, j));
        }
      });
    }
    dbDel(key);
    return getIndex().then(function (idx) {
      idx = idx.filter(function (e) { return e.key !== key; });
      return saveIndex(idx);
    });
  });
}

function photoDataKey(projectKey, itemSortKey, photoIndex) {
  return "pk_" + projectKey + "_" + itemSortKey + "_" + photoIndex;
}

/* ===================== 地理位置 ===================== */
function getLocation() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.geolocation) return resolve("");
      var done = false;
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          if (done) return; done = true;
          var lat = pos.coords.latitude, lng = pos.coords.longitude;
          resolve(
            Math.abs(lat).toFixed(4) + "\u00b0" + (lat >= 0 ? "N" : "S") + ", " +
            Math.abs(lng).toFixed(4) + "\u00b0" + (lng >= 0 ? "E" : "W")
          );
        },
        function () { if (!done) { done = true; resolve(""); } },
        { timeout: 3000, maximumAge: 60000 }
      );
      setTimeout(function () { if (!done) { done = true; resolve(""); } }, 4000);
    } catch (e) { resolve(""); }
  });
}

/* ===================== 水印 ===================== */
function applyWatermark(canvas, dateStr, location) {
  var ctx = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  if (!ctx) return;
  var lines = [dateStr];
  if (location) lines.push(location);
  var fontSize = Math.max(10, Math.floor(w / 28));
  ctx.font = '600 ' + fontSize + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  var lineHeight = fontSize * 1.5, padding = fontSize * 0.8;
  for (var i = 0; i < lines.length; i++) {
    var y = h - padding - (lines.length - 1 - i) * lineHeight + fontSize * 0.4, x = w - padding * 0.3;
    ctx.lineWidth = fontSize / 6; ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,.35)"; ctx.strokeText(lines[i], x, y);
    ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillText(lines[i], x, y);
  }
  var sm = Math.max(7, Math.floor(w / 45));
  ctx.font = '600 ' + sm + 'px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.textAlign = "right"; ctx.textBaseline = "top";
  ctx.lineWidth = sm / 6;
  ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.strokeText("\u9a8c\u6536", w - sm * 0.5, sm * 0.8);
  ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fillText("\u9a8c\u6536", w - sm * 0.5, sm * 0.8);
}

/* ===================== 文件转 Canvas ===================== */
function fileToCanvas(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          if (w <= 0 || h <= 0) { reject(new Error("Invalid image size")); return; }
          if (w > IMG_MAX_SIZE || h > IMG_MAX_SIZE) {
            var ratio = Math.min(IMG_MAX_SIZE / w, IMG_MAX_SIZE / h);
            w = Math.round(w * ratio); h = Math.round(h * ratio);
          }
          var c = document.createElement("canvas"); c.width = w; c.height = h;
          var ctx = c.getContext("2d");
          if (!ctx) { reject(new Error("Canvas not supported")); return; }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(c);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { reject(new Error("Image load failed")); };
      img.src = reader.result;
    };
    reader.onerror = function () { reject(new Error("File read failed")); };
    reader.readAsDataURL(file);
  });
}

/* ===================== 自动保存 ===================== */
function autoSave() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  saveProject();
}

/* ===================== 导入报价单 ===================== */
function pickFile() {
  if (typeof XLSX === "undefined") { showToast("Excel解析库加载中，请检查网络后刷新重试"); return; }
  try {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv";
    input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;z-index:99999;overflow:hidden;pointer-events:auto";
    input.addEventListener("change", function (e) { handleFileImport(e); setTimeout(function () { try { document.body.removeChild(input); } catch (x) {} }, 5000); });
    document.body.appendChild(input);
    input.click();
  } catch (err) { showToast("打开文件选择器失败: " + err.message); }
}

function handleFileImport(e) {
  if (typeof XLSX === "undefined") { showToast("Excel解析库未加载，请刷新页面重试"); return; }
  var file = e.target.files[0];
  if (!file) return;
  var ext = file.name.replace(/.*\./, "").toLowerCase();
  console.log("文件:", file.name, "大小:", file.size, "格式:", ext);

  if (ext === "csv") {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var wb = XLSX.read(ev.target.result, { type: "string" });
        parseWorkbook(wb, file.name);
      } catch (err) { showToast("CSV解析失败: " + err.message); }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsText(file, "utf-8");
  } else {
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        console.log("ArrayBuffer读取完成, 大小:", ev.target.result.byteLength);
        var wb = XLSX.read(ev.target.result, { type: "array" });
        parseWorkbook(wb, file.name);
      } catch (err1) {
        console.warn("ArrayBuffer解析失败:", err1.message);
        tryParseAsText(file, file.name);
      }
    };
    reader.onerror = function () { showToast("文件读取失败"); };
    reader.readAsArrayBuffer(file);
  }
}

function tryParseAsText(file, fileName) {
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var wb = XLSX.read(ev.target.result, { type: "string", codepage: 65001 });
      parseWorkbook(wb, fileName);
    } catch (err) {
      console.warn("string模式也失败:", err.message);
      tryParseAsBase64(file, fileName);
    }
  };
  reader.readAsText(file, "utf-8");
}

function tryParseAsBase64(file, fileName) {
  var reader = new FileReader();
  reader.onload = function (ev) {
    try {
      var b64 = ev.target.result.split(",")[1];
      var wb = XLSX.read(b64, { type: "base64" });
      parseWorkbook(wb, fileName);
    } catch (err) {
      console.error("所有解析方式均失败:", err.message);
      showToast("\u89e3\u6790\u5931\u8d25\uff0c\u8bf7\u5c1d\u8bd5\uff1a\n1. \u7528Excel/WPS\u6253\u5f00\u540e\u53e6\u5b58\u4e3a.xlsx\n2. \u6216\u5bfc\u51fa\u4e3aCSV\u683c\u5f0f\u91cd\u8bd5");
    }
  };
  reader.readAsDataURL(file);
}

function parseWorkbook(workbook, fileName) {
  var sheet = workbook.Sheets[workbook.SheetNames[0]];
  var rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  console.log("解析完成:", rows.length, "行");
  if (!rows.length || rows.length < 2) { showToast("Excel无数据或行数不足"); return; }

  var excelTitle = "";
  if (rows[0]) {
    var firstCell = String(rows[0][0] || "").trim();
    if (firstCell && firstCell !== "\u5e8f\u53f7" && !/^\d+$/.test(firstCell)) excelTitle = firstCell;
  }

  var items = [];
  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (!row || !row.length) continue;
    var seqNum = row[0];
    if (seqNum === undefined || seqNum === null || seqNum === "") continue;
    seqNum = String(seqNum).trim();
    if (!/^\d+$/.test(seqNum)) continue;
    var name = String(row[1] || "").trim();
    if (!name) continue;
    items.push({
      sortKey: items.length, displayNum: String(items.length + 1), displayName: name,
      origQty: String(row[2] || ""), origUnit: String(row[3] || ""),
      origPrice: String(row[4] || ""), origAmount: String(row[5] || ""),
      quoteQty: String(row[2] || ""), quotePrice: String(row[4] || ""),
      acceptQty: "", acceptPrice: "", acceptAmount: "", remark: "",
      photos: [], accepted: false
    });
  }
  if (!items.length) { showToast("\u672a\u627e\u5230\u6709\u6548\u6570\u636e\uff08\u9700\u8981\u5e8f\u53f7\u5217+\u540d\u79f0\u5217\uff09"); return; }

  var projName = excelTitle || fileName.replace(/\.[^.]+$/, "");
  pendingImport = { name: projName, items: items };
  doImport();
}

function doImport() {
  if (!pendingImport) return;
  if (currentProject && currentProject.key) { syncFormToItem(); saveProject(); }
  var key = "proj_" + Date.now();
  currentProject = { key: key, name: pendingImport.name, items: pendingImport.items, createdAt: Date.now() };
  pendingImport = null;
  saveProject();
  showList();
  showToast("\u5bfc\u5165\u6210\u529f\uff0c\u5171 " + currentProject.items.length + " \u9879");
}

/* ===================== 首页项目列表 ===================== */
function refreshHome() {
  getIndex().then(function (idx) {
    var area = document.getElementById("projListArea");
    if (!idx || !idx.length) {
      area.innerHTML = '<p style="color:#4a4535;font-size:.85rem;text-align:center;padding:10px 0;">暂无验收项目</p>';
      return;
    }
    idx.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    var html = '';
    for (var i = 0; i < idx.length; i++) {
      var entry = idx[i];
      var pct = entry.total ? Math.round(entry.done / entry.total * 100) : 0;
      html += '<div class="project-card" onclick="openProject(\'' + entry.key + '\')">' +
        '<div class="project-card-header">' +
          '<div class="project-card-name">' + escapeHtml(entry.name) + '</div>' +
          '<button class="project-card-delete" onclick="event.stopPropagation();confirmDelete(\'' + entry.key + '\',\'' + escapeHtml(entry.name).replace(/'/g, "\\'") + '\')">&#215;</button>' +
        '</div>' +
        '<div class="project-card-bar"><div class="project-card-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="project-card-footer"><span>' + entry.done + '/' + entry.total + ' 已验收</span>' +
        (entry.done >= entry.total ? '<span class="project-card-done">已完成</span>' : '<span>' + formatDate(entry.updatedAt) + '</span>') +
        '</div></div>';
    }
    area.innerHTML = html;
  });
}

function openProject(key) {
  showLoading("\u52a0\u8f7d...");
  loadProjectData(key).then(function (data) {
    hideLoading();
    if (data && data.items && data.items.length) {
      currentProject = data;
      showList();
    } else { showToast("\u52a0\u8f7d\u5931\u8d25"); }
  }).catch(function () { hideLoading(); showToast("\u52a0\u8f7d\u5931\u8d25"); });
}

function confirmDelete(key, name) {
  deleteTargetKey = key;
  document.getElementById("delProjName").textContent = name;
  document.getElementById("delModal").classList.add("active");
}

function cancelDelete() {
  document.getElementById("delModal").classList.remove("active");
  deleteTargetKey = null;
}

function executeDelete() {
  document.getElementById("delModal").classList.remove("active");
  if (!deleteTargetKey) return;
  var k = deleteTargetKey;
  deleteTargetKey = null;
  deleteProject(k).then(function () { refreshHome(); showToast("\u5df2\u5220\u9664"); });
}

/* ===================== 页面切换 ===================== */
function switchPage(pageId) {
  var pages = document.querySelectorAll(".page");
  for (var i = 0; i < pages.length; i++) pages[i].classList.remove("active");
  document.getElementById(pageId).classList.add("active");
}

function goHome() {
  stopCamera();
  if (currentIndex >= 0 && currentProject) {
    syncFormToItem();
    saveProject();
    currentIndex = -1;
    document.getElementById("detailPage").classList.remove("active");
    document.body.style.overflow = "";
  }
  closeViewer();
  currentProject = null;
  switchPage("pgHome");
  refreshHome();
  document.getElementById("btnBack").style.display = "none";
  document.getElementById("topTitle").textContent = "JF\u8d39\u7528\u9a8c\u6536";
}

function showList() {
  stopCamera();
  closeDetail();
  closeViewer();
  renderItemList();
  switchPage("pgList");
  document.getElementById("btnBack").style.display = "";
  document.getElementById("topTitle").textContent = currentProject.name;
}

function showDone() {
  stopCamera();
  closeViewer();
  if (currentIndex >= 0) {
    currentIndex = -1;
    document.getElementById("detailPage").classList.remove("active");
    document.body.style.overflow = "";
  }
  switchPage("pgDone");
  document.getElementById("btnBack").style.display = "";
  document.getElementById("topTitle").textContent = "\u9a8c\u6536\u5b8c\u6210";
}

/* ===================== 验收列表渲染 ===================== */
function renderItemList() {
  if (!currentProject || !currentProject.items) return;
  document.getElementById("projName").textContent = currentProject.name;

  var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
  var total = currentProject.items.length;
  document.getElementById("progVal").textContent = doneCount + "/" + total;
  document.getElementById("progFill").style.width = (total ? doneCount / total * 100 : 0) + "%";

  var listEl = document.getElementById("itemList");
  listEl.innerHTML = "";

  for (var i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    var status = item.accepted ? "done" : (item.photos.length ? "accepting" : "pending");
    var label = item.accepted ? "\u5df2\u5b8c\u6210" : (item.photos.length ? "\u9a8c\u6536\u4e2d" : "\u5f85\u9a8c\u6536");

    var div = document.createElement("div");
    div.className = "item-row";
    div.innerHTML =
      '<div class="item-num status-' + status + '">' + item.displayNum + '</div>' +
      '<div class="item-body">' +
        '<div class="item-name">' + escapeHtml(item.displayName) + '</div>' +
        '<div class="item-meta">\u62a5\u4ef7:' + item.origQty + (item.origUnit || '') + ' x \u00a5' + item.origPrice +
        (item.acceptAmount ? ' \u00b7 \u9a8c\u6536:\u00a5' + item.acceptAmount : '') +
        (item.photos.length ? ' \u00b7 \ud83d\udcf7' + item.photos.length : '') + '</div>' +
      '</div>' +
      '<span class="item-tag status-' + status + '">' + label + '</span>' +
      '<span class="item-arrow">\u203a</span>';

    (function (idx) { div.onclick = function () { openDetail(idx); }; })(i);
    listEl.appendChild(div);
  }

  var btn = document.getElementById("btnGen");
  btn.disabled = doneCount < total;
  btn.textContent = (total && doneCount === total) ?
    "\ud83d\udcc4 \u751f\u6210\u9a8c\u6536\u6587\u4ef6" :
    "\ud83d\udcc4 \u5168\u90e8\u9a8c\u6536\u540e\u53ef\u751f\u6210 (" + doneCount + "/" + total + ")";
  if (doneCount === total && total > 0) setTimeout(function () { showDone(); }, 300);
}

/* ===================== 验收详情 ===================== */
function openDetail(idx) {
  currentIndex = idx;
  var item = currentProject.items[idx];

  document.getElementById("dtlTitle").textContent = item.displayNum + ". " + item.displayName;
  document.getElementById("inpOQ").value = item.origQty + (item.origUnit ? " " + item.origUnit : "");
  document.getElementById("inpOP").value = "\u00a5" + item.origPrice;

  var origAmount = item.origAmount || "";
  if (!origAmount && item.origQty && item.origPrice) {
    var nq = parseFloat(item.origQty), np = parseFloat(item.origPrice);
    if (!isNaN(nq) && !isNaN(np)) origAmount = (nq * np).toFixed(2);
  }
  document.getElementById("inpOA").value = origAmount ? "\u00a5" + origAmount : "";
  document.getElementById("inpAQ").value = item.acceptQty || "";
  document.getElementById("inpAP").value = item.acceptPrice || "";
  document.getElementById("inpAA").value = item.acceptAmount || "";
  document.getElementById("inpR").value = item.remark || "";

  renderPhotoGrid();
  document.getElementById("detailPage").classList.add("active");
  document.body.style.overflow = "hidden";

  var fields = ["inpAQ", "inpAP", "inpR", "inpAA"];
  for (var i = 0; i < fields.length; i++) {
    var el = document.getElementById(fields[i]);
    el.removeEventListener("input", onFieldInput);
    el.addEventListener("input", onFieldInput);
  }
}

function onFieldInput() {
  var aq = parseFloat(document.getElementById("inpAQ").value) || 0;
  var ap = parseFloat(document.getElementById("inpAP").value) || 0;
  var aaField = document.getElementById("inpAA");

  if (this.id === "inpAQ" || this.id === "inpAP") {
    if (aq > 0 && ap > 0) aaField.value = (aq * ap).toFixed(2);
  }

  var aa = parseFloat(aaField.value) || 0;
  var calculated = aq * ap;
  var remarkField = document.getElementById("inpR");

  if (aq > 0 && ap > 0 && aa > 0 && Math.abs(aa - calculated) > 0.01) {
    remarkField.placeholder = "\u26a0 \u91d1\u989d\u4e0d\u4e00\u81f4\uff0c\u8bf7\u586b\u5907\u6ce8";
    remarkField.style.borderColor = "#c05050";
    remarkField.style.background = "rgba(192,80,80,.05)";
  } else {
    remarkField.placeholder = "\u8f93\u5165\u5907\u6ce8\u4fe1\u606f";
    remarkField.style.borderColor = "";
    remarkField.style.background = "";
  }
  autoSave();
}

function syncFormToItem() {
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  item.origQty = document.getElementById("inpOQ").value || item.origQty;
  item.origPrice = document.getElementById("inpOP").value || item.origPrice;
  item.acceptQty = document.getElementById("inpAQ").value;
  item.acceptPrice = document.getElementById("inpAP").value;
  item.acceptAmount = document.getElementById("inpAA").value;
  item.remark = document.getElementById("inpR").value;
}

function closeDetail() {
  syncFormToItem();
  if (currentIndex >= 0 && currentProject) saveProject();
  currentIndex = -1;
  document.getElementById("detailPage").classList.remove("active");
  document.body.style.overflow = "";
  if (currentProject) renderItemList();
}

function saveAccept() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  var item = currentProject.items[currentIndex];

  if (!item.acceptQty || !item.acceptPrice) {
    showToast("\u8bf7\u586b\u5199\u9a8c\u6536\u6570\u91cf\u548c\u9a8c\u6536\u5355\u4ef7");
    return;
  }
  if (!item.photos.length) {
    showToast("\u8bf7\u5148\u6dfb\u52a0\u9a8c\u6536\u7167\u7247");
    return;
  }
  if (!item.acceptAmount) {
    var nq = parseFloat(item.acceptQty), np = parseFloat(item.acceptPrice);
    if (!isNaN(nq) && !isNaN(np)) item.acceptAmount = (nq * np).toFixed(2);
  }

  var calculated = parseFloat(item.acceptQty) * parseFloat(item.acceptPrice);
  var aa = parseFloat(item.acceptAmount) || 0;
  if (Math.abs(aa - calculated) > 0.01) {
    if (!item.remark || !item.remark.trim()) {
      showToast("\u91d1\u989d\u4e0d\u4e00\u81f4\uff0c\u8bf7\u586b\u5907\u6ce8");
      document.getElementById("inpR").focus();
      document.getElementById("inpR").style.borderColor = "#c05050";
      return;
    }
  }

  item.accepted = true;
  saveProject();
  renderItemList();
  showToast("\u9a8c\u6536\u5df2\u4fdd\u5b58");
  closeDetail();
}

function saveOnly() {
  if (currentIndex < 0 || !currentProject) return;
  syncFormToItem();
  saveProject();
  renderItemList();
  showToast("\u5df2\u6682\u5b58");
}

/* ===================== 照片管理 ===================== */
function renderPhotoGrid() {
  if (currentIndex < 0) return;
  var item = currentProject.items[currentIndex];
  var grid = document.getElementById("phGrid");
  grid.innerHTML = "";
  document.getElementById("phCnt").textContent = item.photos.length + "\u5f20";

  for (var i = 0; i < item.photos.length; i++) {
    var photo = item.photos[i];
    var div = document.createElement("div");
    div.className = "photo-card";
    div.innerHTML =
      '<div class="photo-number">' + (i + 1) + '</div>' +
      '<img src="' + (photo.dataUrl || "") + '" onerror="this.style.opacity=0.3">' +
      '<button class="photo-delete" onclick="event.stopPropagation();deletePhoto(' + i + ')">\u2715</button>' +
      '<div class="photo-info">' + formatTimestamp(photo.date || "") + '</div>';
    (function (idx) { div.onclick = function () { openViewer(idx); }; })(i);
    grid.appendChild(div);
  }
}

function deletePhoto(idx) {
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  var sortKey = item.sortKey;
  item.photos.splice(idx, 1);
  if (!item.photos.length) item.accepted = false;

  var cleanups = [];
  for (var k = 0; k < 20; k++) cleanups.push(dbDel(photoDataKey(sortKey, k)));

  Promise.all(cleanups).then(function () {
    return Promise.all(item.photos.map(function (p, j) {
      if (p.dataUrl) return dbPut(photoDataKey(sortKey, j), p.dataUrl);
      return Promise.resolve();
    }));
  }).catch(function (e) { console.error("reindex:", e); });

  saveProject();
  renderPhotoGrid();
  renderItemList();
  showToast("\u5df2\u5220\u9664");
}

/* ===================== 照片查看器 ===================== */
function openViewer(idx) {
  if (currentIndex < 0) return;
  viewerPhotos = currentProject.items[currentIndex].photos;
  viewerIndex = idx;
  updateViewer();
  document.getElementById("viewerPage").classList.add("active");
}

function closeViewer() { document.getElementById("viewerPage").classList.remove("active"); }

function viewerNavigate(dir) {
  viewerIndex = (viewerIndex + dir + viewerPhotos.length) % viewerPhotos.length;
  updateViewer();
}

function updateViewer() {
  if (!viewerPhotos.length) return;
  document.getElementById("viewerImg").src = viewerPhotos[viewerIndex].dataUrl || "";
  document.getElementById("viewerCt").textContent = (viewerIndex + 1) + " / " + viewerPhotos.length;
}

/* ===================== 图片来源选择 ===================== */
function openSheet() {
  if (currentIndex < 0) { showToast("\u8bf7\u5148\u9009\u9879"); return; }
  document.getElementById("pickSheet").classList.add("active");
}

function closeSheet() { document.getElementById("pickSheet").classList.remove("active"); }

/* ===================== 相机 ===================== */
function openCamera() {
  closeSheet();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast("\u6b64\u8bbe\u5907\u4e0d\u652f\u6301\u62cd\u7167");
    return;
  }
  if (currentIndex < 0 || !currentProject) return;
  var item = currentProject.items[currentIndex];
  document.getElementById("camInfo").textContent = item.displayName + " (" + item.photos.length + "\u5f20)";
  document.getElementById("camPage").classList.add("active");

  navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  }).then(function (stream) {
    cameraStream = stream;
    var video = document.getElementById("camVid");
    video.srcObject = stream;
    video.play().catch(function () {});
  }).catch(function () {
    showToast("\u6444\u50cf\u5934\u4e0d\u53ef\u7528");
    stopCamera();
  });
}

function stopCamera() {
  if (cameraStream) {
    try { cameraStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    cameraStream = null;
  }
  var video = document.getElementById("camVid");
  if (video) video.srcObject = null;
  document.getElementById("camPage").classList.remove("active");
}

function takeSnapshot() {
  if (!cameraStream) { showToast("\u6444\u50cf\u5934\u672a\u6253\u5f00"); return; }
  var video = document.getElementById("camVid");
  var vw = video.videoWidth || 0, vh = video.videoHeight || 0;
  if (vw < 10 || vh < 10) { showToast("\u89c6\u9891\u672a\u5c31\u7eea"); return; }

  try {
    var canvas = document.createElement("canvas");
    canvas.width = vw; canvas.height = vh;
    canvas.getContext("2d").drawImage(video, 0, 0, vw, vh);
    document.getElementById("camFlash").classList.add("on");
    setTimeout(function () { document.getElementById("camFlash").classList.remove("on"); }, 150);

    addPhoto(canvas).then(function () {
      if (currentIndex >= 0 && currentProject && currentProject.items[currentIndex]) {
        document.getElementById("camInfo").textContent =
          currentProject.items[currentIndex].displayName + " (" + currentProject.items[currentIndex].photos.length + "\u5f20)";
      }
    }).catch(function () {});
  } catch (e) { showToast("\u62cd\u7167\u5931\u8d25"); }
}

/* ===================== 相册选择 ===================== */
function openGallery() {
  closeSheet();
  if (currentIndex < 0 || !currentProject) { showToast("\u8bf7\u5148\u6253\u5f00\u9879"); return; }
  if (isGalleryProcessing) { showToast("\u6b63\u5728\u5904\u7406"); return; }

  var inp = document.getElementById("galInput");
  inp.value = "";
  var newInp = inp.cloneNode(true);
  inp.parentNode.replaceChild(newInp, inp);
  newInp.addEventListener("change", onGallerySelect);
  requestAnimationFrame(function () { try { newInp.click(); } catch (e) { showToast("\u65e0\u6cd5\u6253\u5f00\u76f8\u518c"); } });
}

function onGallerySelect(e) {
  var files = e.target.files;
  if (!files || !files.length) return;
  isGalleryProcessing = true;
  var fileArray = [];
  for (var i = 0; i < files.length; i++) fileArray.push(files[i]);

  showToast("\u5904\u7406 " + fileArray.length + " \u5f20...");
  var addedCount = 0, errorCount = 0;

  function processNext(idx) {
    if (idx >= fileArray.length) {
      isGalleryProcessing = false;
      showToast(addedCount > 0 ? "\u5df2\u6dfb\u52a0 " + addedCount + " \u5f20" + (errorCount ? " (" + errorCount + "\u5931\u8d25)" : "") : "\u5904\u7406\u5931\u8d25");
      return;
    }
    fileToCanvas(fileArray[idx]).then(function (canvas) {
      return addPhoto(canvas);
    }).then(function () { addedCount++; })
      .catch(function () { errorCount++; })
      .then(function () { processNext(idx + 1); });
  }
  processNext(0);
}

/* ===================== 保存照片 ===================== */
function addPhoto(sourceCanvas) {
  return new Promise(function (resolve, reject) {
    if (currentIndex < 0 || !currentProject || !currentProject.items[currentIndex]) {
      showToast("\u672a\u6253\u5f00\u9879");
      reject(new Error("No item selected"));
      return;
    }
    try {
      var max = IMG_MAX_SIZE, w = sourceCanvas.width, h = sourceCanvas.height;
      if (w <= 0 || h <= 0) { reject(new Error("Invalid canvas")); return; }
      if (w > max || h > max) {
        var ratio = Math.min(max / w, max / h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      var canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas ctx failed")); return; }
      ctx.drawImage(sourceCanvas, 0, 0, w, h);

      var now = new Date();
      var dateStr = now.getFullYear() + "-" + padZero(now.getMonth() + 1) + "-" + padZero(now.getDate()) +
        " " + padZero(now.getHours()) + ":" + padZero(now.getMinutes()) + ":" + padZero(now.getSeconds());

      getLocation().then(function (loc) {
        savePhotoData(canvas, dateStr, loc, resolve, reject);
      }).catch(function () {
        savePhotoData(canvas, dateStr, "", resolve, reject);
      });
    } catch (e) { showToast("\u7167\u7247\u5931\u8d25"); reject(e); }
  });
}

function savePhotoData(canvas, dateStr, location, resolve, reject) {
  try {
    applyWatermark(canvas, formatTimestamp(dateStr), location);
    var dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    if (!dataUrl || dataUrl.indexOf("data:image/jpeg;base64,") !== 0 || dataUrl.length < 500) {
      showToast("\u7167\u7247\u751f\u6210\u5931\u8d25");
      reject(new Error("Invalid data URL"));
      return;
    }
    var item = currentProject.items[currentIndex];
    var photoIdx = item.photos.length;
    item.photos.push({ dataUrl: dataUrl, date: dateStr, location: location });
    renderPhotoGrid();
    renderItemList();

    dbPut(photoDataKey(currentProject.key, item.sortKey, photoIdx), dataUrl).then(function () {
      saveProject();
      resolve(true);
    }).catch(function (e) {
      console.error("IDB save failed:", e);
      saveProject();
      showToast("\u5df2\u6dfb\u52a0(\u4ec5\u5185\u5b58)");
      resolve(true);
    });
  } catch (e) { showToast("\u4fdd\u5b58\u5931\u8d25"); reject(e); }
}

/* ===================== 生成PDF ===================== */
function genPDF() {
  if (!currentProject) return;
  var doneCount = currentProject.items.filter(function (x) { return x.accepted; }).length;
  var total = currentProject.items.length;
  if (doneCount < total) {
    showToast("\u8bf7\u5148\u5b8c\u6210\u5168\u90e8\u9a8c\u6536 (" + doneCount + "/" + total + ")");
    return;
  }
  if (typeof html2canvas === "undefined") { showToast("\u6e32\u67d3\u5e93\u672a\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u5237\u65b0"); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { showToast("PDF\u5e93\u672a\u52a0\u8f7d\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u5237\u65b0"); return; }

  showLoading("\u6b63\u5728\u751f\u6210...");

  var cleanName = currentProject.name
    .replace(/\u6d3b\u52a8\u8d39\u7528\u62a5\u4ef7\u6e05\u5355/g, "")
    .replace(/\u6d3b\u52a8\u8d39\u7528\u9a8c\u6536\u6e05\u5355/g, "")
    .replace(/\u62a5\u4ef7\u6e05\u5355/g, "").replace(/\u9a8c\u6536\u6e05\u5355/g, "")
    .replace(/\u62a5\u4ef7\u5355/g, "").replace(/\u9a8c\u6536\u5355/g, "")
    .replace(/\s+/g, "").trim();
  if (!cleanName) cleanName = "\u9879\u76ee";

  var title = cleanName + "\u6d3b\u52a8\u8d39\u7528\u9a8c\u6536\u6e05\u5355";
  var fontCSS = 'font-family:SimSun,\u5b8b\u4f53,serif;';
  var border = '0.25px solid #666';
  var colWidth = '76px';

  var html = '<div style="padding:32px 40px;' + fontCSS + 'color:#000;">';
  html += '<div style="text-align:center;margin-bottom:20px;padding-bottom:10px;border-bottom:0.5pt solid #888;">' +
    '<div style="font-size:22px;font-weight:900;letter-spacing:3px;">' + escapeForPdf(title) + '</div></div>';
  html += '<table style="border-collapse:collapse;border-spacing:0;width:100%;font-size:12px;' + fontCSS + '">';

  var thStyle = 'border:' + border + ';padding:8px 6px;text-align:center;background:#dae4f0;font-weight:700;color:#000;';
  html += '<thead><tr>';
  html += '<th style="' + thStyle + 'width:36px;">\u5e8f\u53f7</th>';
  html += '<th style="' + thStyle + '">\u62a5\u4ef7\u540d\u79f0<br><span style="font-size:9px;font-weight:400;color:#555;">(\u5185\u5bb9/\u89c4\u683c/\u5de5\u827a/\u5c3a\u5bf8/\u7528\u9014\u63cf\u8ff0)</span></th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u6570\u91cf</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u5355\u4f4d</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u5355\u4ef7</th>';
  html += '<th style="' + thStyle + 'width:' + colWidth + ';">\u9a8c\u6536\u91d1\u989d</th>';
  html += '<th style="' + thStyle + 'min-width:200px;">\u9a8c\u6536\u7167\u7247</th>';
  html += '</tr></thead><tbody>';

  var totalAmount = 0;
  for (var i = 0; i < currentProject.items.length; i++) {
    var item = currentProject.items[i];
    totalAmount += parseFloat(item.acceptAmount) || 0;
    var photoHtml = '';
    for (var j = 0; j < item.photos.length; j++) {
      var p = item.photos[j];
      if (!p.dataUrl) continue;
      photoHtml += '<div style="display:inline-block;vertical-align:top;margin:2px;max-width:100px;text-align:center;">' +
        '<img src="' + p.dataUrl + '" style="display:block;max-width:100px;max-height:68px;object-fit:contain;border:0.25px solid #bbb;" />' +
        '<div style="font-size:7px;color:#555;margin-top:1px;line-height:1.2;max-width:100px;overflow:hidden;">' + escapeForPdf(formatTimestamp(p.date)) + '</div></div>';
    }
    var tdStyle = 'border:' + border + ';padding:6px 8px;text-align:center;color:#000;';
    html += '<tr>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + item.displayNum + '</td>' +
      '<td style="' + tdStyle + 'text-align:left;font-size:11.5px;line-height:1.4;">' + escapeForPdf(item.displayName) + '</td>' +
      '<td style="' + tdStyle + '">' + (item.acceptQty || '-') + '</td>' +
      '<td style="' + tdStyle + '">' + escapeForPdf(item.origUnit || '-') + '</td>' +
      '<td style="' + tdStyle + '">' + (item.acceptPrice ? Number(item.acceptPrice).toLocaleString('zh') : '-') + '</td>' +
      '<td style="' + tdStyle + 'font-weight:600;">' + (item.acceptAmount ? Number(item.acceptAmount).toLocaleString('zh', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-') + '</td>' +
      '<td style="border:' + border + ';padding:4px 6px;line-height:0;text-align:left;">' + (photoHtml || '<span style="font-size:11px;color:#aaa;line-height:1;">-</span>') + '</td></tr>';
  }

  var totalTdStyle = 'border:' + border + ';padding:8px 6px;text-align:center;background:#e2e2e2;font-weight:900;color:#000;';
  html += '<tr><td style="' + totalTdStyle + '">\u5408\u8ba1</td>';
  for (var k = 0; k < 4; k++) html += '<td style="border:' + border + ';padding:6px;background:#e2e2e2;"></td>';
  html += '<td style="' + totalTdStyle + 'font-size:13px;">' + totalAmount.toLocaleString('zh', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '</td>';
  html += '<td style="border:' + border + ';padding:6px;background:#e2e2e2;"></td></tr>';
  html += '</tbody></table>';

  var ulStyle = 'border-bottom:1px solid #000;display:inline-block;min-width:120px;height:1em;vertical-align:bottom;';
  html += '<div style="margin-top:32px;font-size:13px;' + fontCSS + 'display:flex;justify-content:space-between;align-items:flex-end;">';
  html += '<div>\u9a8c\u6536\u4eba\uff1a<span style="' + ulStyle + '">&nbsp;</span>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\u590d\u6838\u4eba\uff1a<span style="' + ulStyle + '">&nbsp;</span></div>';
  html += '<div>\u65e5\u671f\uff1a<span style="display:inline-block;border-bottom:1px solid #000;width:60px;height:1em;vertical-align:bottom;">&nbsp;</span>\u5e74<span style="display:inline-block;border-bottom:1px solid #000;width:36px;height:1em;vertical-align:bottom;">&nbsp;</span>\u6708<span style="display:inline-block;border-bottom:1px solid #000;width:36px;height:1em;vertical-align:bottom;">&nbsp;</span>\u65e5</div>';
  html += '</div></div>';

  var container = document.createElement("div");
  container.style.cssText = 'position:fixed;left:-9999px;top:0;background:#fff;width:1120px;';
  container.innerHTML = html;
  document.body.appendChild(container);

  var images = container.querySelectorAll("img");
  var loadPromises = [];
  for (var idx = 0; idx < images.length; idx++) {
    (function (img) {
      if (img.complete && img.naturalWidth > 0) return;
      loadPromises.push(new Promise(function (ok) {
        var done = false;
        img.onload = function () { if (!done) { done = true; ok(); } };
        img.onerror = function () { if (!done) { done = true; ok(); } };
        setTimeout(function () { if (!done) { done = true; ok(); } }, 10000);
      }));
    })(images[idx]);
  }

  Promise.all(loadPromises)
    .then(function () { return new Promise(function (ok) { setTimeout(ok, 500); }); })
    .then(function () {
      return html2canvas(container, { scale: 1.5, useCORS: true, logging: false, backgroundColor: "#fff", allowTaint: true });
    })
    .then(function (canvas) {
      document.body.removeChild(container);
      var jsPDF = window.jspdf.jsPDF;
      var imgData = canvas.toDataURL("image/jpeg", 0.92);
      var imgWidth = canvas.width, imgHeight = canvas.height;
      var pageWidth = 297, pageHeight = 210;
      var ratio = pageWidth / (imgWidth / 1.5);
      var totalHeight = imgHeight / 1.5 * ratio;

      var doc;
      if (totalHeight > pageHeight) {
        doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
        var remaining = totalHeight, yOffset = 0;
        while (remaining > 0) {
          if (yOffset > 0) doc.addPage();
          var srcY = yOffset / ratio * 1.5;
          var srcH = Math.min(pageHeight, remaining) / ratio * 1.5;
          var tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = imgWidth; tmpCanvas.height = Math.ceil(srcH);
          tmpCanvas.getContext("2d").drawImage(canvas, 0, Math.floor(srcY), imgWidth, Math.ceil(srcH), 0, 0, imgWidth, Math.ceil(srcH));
          doc.addImage(tmpCanvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pageWidth, tmpCanvas.height / 1.5 * ratio);
          remaining -= pageHeight; yOffset += pageHeight;
        }
      } else {
        doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
        doc.addImage(imgData, "JPEG", 0, 0, pageWidth, totalHeight);
      }

      pdfBlob = doc.output("blob");
      document.getElementById("pdfBody").innerHTML = html;
      document.getElementById("pdfPreview").classList.add("active");
      hideLoading();
      showToast("\u9a8c\u6536\u6587\u4ef6\u5df2\u751f\u6210");
    })
    .catch(function (e) {
      try { document.body.removeChild(container); } catch (x) {}
      hideLoading();
      showToast("\u751f\u6210\u5931\u8d25: " + (e.message || ""));
      console.error(e);
    });
}

/* ===================== PDF 下载 / 分享 ===================== */
function downloadPdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var url = URL.createObjectURL(pdfBlob);
  var ua = navigator.userAgent || "";

  if (/Android/i.test(ua)) {
    var win = null;
    try { win = window.open(url, "_blank"); } catch (e) {}
    if (!win) {
      var a = document.createElement("a");
      a.href = url; a.download = fileName;
      a.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;overflow:hidden";
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 5000);
    }
  } else {
    var a = document.createElement("a");
    a.href = url; a.download = fileName; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (e) {} }, 5000);
  }
  setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  showToast("\u5df2\u6253\u5f00/\u4e0b\u8f7d");
}

function sharePdf() {
  if (!pdfBlob) { showToast("\u8bf7\u5148\u751f\u6210"); return; }
  var fileName = "\u9a8c\u6536\u5355_" + (currentProject ? currentProject.name : "") + ".pdf";
  var file = new File([pdfBlob], fileName, { type: "application/pdf" });

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ title: fileName, files: [file] }).catch(function (e) {
      if (e.name !== "AbortError") downloadPdf();
    });
  } else if (navigator.share) {
    navigator.share({ title: fileName }).catch(function () {});
  } else {
    downloadPdf();
  }
}

function closePdfPreview() { document.getElementById("pdfPreview").classList.remove("active"); }

/* ===================== UI 辅助 ===================== */
function showLoading(text) {
  document.getElementById("loadingText").textContent = text || "\u6b63\u5728\u5904\u7406...";
  document.getElementById("loadingOverlay").classList.add("active");
}
function hideLoading() { document.getElementById("loadingOverlay").classList.remove("active"); }

var toastTimer = null;
function showToast(message) {
  var el = document.getElementById("toastBox");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("visible"); }, 2500);
}

/* ===================== 初始化 ===================== */
window.addEventListener("beforeunload", function () { autoSave(); });
document.addEventListener("visibilitychange", function () { if (document.hidden) autoSave(); });
refreshHome();
console.log("=== v6.0 done ===");
