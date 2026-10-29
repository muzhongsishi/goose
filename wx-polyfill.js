// 微信小游戏 wx API 的浏览器 polyfill
// 让 Cocos 微信小游戏构建能在浏览器里跑起来
(function (global) {
  var wx = global.wx = {};
  // 保存原生 document 引用:adapter(game.js) 之后会替换 window.document 为模拟对象,
  // 这里必须始终用原生 DOM 创建真实的 canvas/img 元素,否则会递归/拿到模拟元素
  var nativeDoc = global.document;
  global.__nativeDoc = nativeDoc;
  var nativeCreateElement = nativeDoc.createElement.bind(nativeDoc);
  var nativeAddEventListener = global.addEventListener.bind(global);
  var nativeRemoveEventListener = global.removeEventListener.bind(global);
  // 同样保存原生 localStorage:adapter 会把 window.localStorage 换成它自己的模块,
  // 而它的 setItem 又回调 wx.setStorageSync,若不保存原生引用会无限递归
  var nativeLocalStorage = global.localStorage;
  // 原生 <img>.src 的 setter(用于拦截 wxfile:// 路径转换;此刻 HTMLImageElement 尚未被 adapter 污染)
  var nativeImgSrcDesc = global.HTMLImageElement && Object.getOwnPropertyDescriptor(global.HTMLImageElement.prototype, 'src');
  // 原生 XHR:资源下载必须用它。曾经用 fetch,真机偶发 res.text()/arrayBuffer() 永久挂起
  //(响应 200 已到、body 永不 resolve、catch 也不触发),登录前预加载卡死 98%。
  // XHR 走另一条浏览器管线,且此刻 adapter 未运行,拿到的必是原生构造器
  var nativeXHR = global.XMLHttpRequest;
  // 资源加载追踪:默认静音(每次刷新上千条,淹没真问题),URL 带 ?debug 恢复输出
  function tr() { if (global.__DEBUG__) console.warn.apply(console, arguments); }

  // ---- 系统信息 ----
  var sysInfo = null;
  wx.getSystemInfoSync = function () {
    if (sysInfo) return sysInfo;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    sysInfo = {
      model: 'Browser',
      brand: 'devtools',
      pixelRatio: dpr,
      devicePixelRatio: dpr,
      windowWidth: global.innerWidth,
      windowHeight: global.innerHeight,
      screenWidth: global.innerWidth,
      screenHeight: global.innerHeight,
      system: 'Web',
      language: (navigator.language || 'zh_CN').replace('-', '_'),
      version: '0',
      SDKVersion: '3.0.0',
      fontSizeSetting: 16,
      platform: 'devtools',
      environment: 'browser',
      benchmarkLevel: -1,
      statusBarHeight: 0,
      safeArea: { left: 0, right: global.innerWidth, top: 0, bottom: global.innerHeight, width: global.innerWidth, height: global.innerHeight }
    };
    return sysInfo;
  };
  wx.getDeviceInfo = function () { return { platform: 'devtools', system: 'Web', model: 'Browser' }; };
  wx.getAppBaseInfo = function () { return { SDKVersion: '3.0.0', language: sysInfo && sysInfo.language, version: '0' }; };
  wx.getLaunchOptionsSync = function () { return { scene: 1001, query: {} }; };
  wx.getEnterOptionsSync = function () { return { scene: 1001, query: {} }; };
  wx.env = { USER_DATA_PATH: 'wxfile://usr' };

  // ---- 画布 / 图片 ----
  var mainCanvas = null;
  wx.createCanvas = function () {
    // 每次返回新 canvas:微信语义下首个是上屏主 canvas,后续是离屏 canvas。
    // 若复用同一对象,weapp-adapter 的 Canvas 类会多次 Object.defineProperty(clientWidth),
    // 第一次成功后第二次即报 "Cannot redefine property"(非 configurable)。
    var c = nativeCreateElement('canvas');
    if (!mainCanvas) {
      mainCanvas = c;
      var s = wx.getSystemInfoSync();
      c.width = s.windowWidth * s.pixelRatio;
      c.height = s.windowHeight * s.pixelRatio;
      c.style.position = 'fixed';
      c.style.inset = '0';
      c.style.width = '100%';
      c.style.height = '100%';
      c.style.display = 'block';
      c.style.margin = '0';
      c.style.touchAction = 'none';
      c.style.zIndex = '1';
      c._isMainCanvas = true;
      var nativeGetBoundingClientRect = Element.prototype.getBoundingClientRect;
      var getCanvasRect = function () {
        var r = nativeGetBoundingClientRect.call(c);
        if (!r || (r.width === 0 && r.height === 0)) {
          var w = global.innerWidth || 390;
          var h = global.innerHeight || 844;
          return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
        }
        return r;
      };
      try {
        Object.defineProperty(c, 'getBoundingClientRect', {
          configurable: true,
          get: function () { return getCanvasRect; },
          set: function () { /* 保护真实 DOM 物理包围盒，防止被 adapter 覆盖 */ }
        });
      } catch (e) { tr('getBoundingClientRect 代理安装失败:', e && e.message); }
      if (nativeDoc.body) nativeDoc.body.appendChild(c);
      else nativeDoc.addEventListener('DOMContentLoaded', function () { nativeDoc.body.appendChild(c); });
    }
    return c;
  };
  wx.createImage = function () {
    // 用原生 DOM 创建 img,避免 adapter 覆盖 document/Image 后造成递归
    var img = nativeCreateElement('img');
    // 拦截 src:优先从内存 fsStore 读取转 Blob URL，杜绝 /tmp/dl_ 请求 404
    if (nativeImgSrcDesc) {
      Object.defineProperty(img, 'src', {
        configurable: true,
        get: function () { return nativeImgSrcDesc.get.call(img); },
        set: function (v) {
          if (typeof v === 'string') {
            var key = typeof fsPath === 'function' ? fsPath(v) : v.replace(/^wxfile:\/\/usr\//, '');
            if (typeof fsStore !== 'undefined' && fsStore[key] !== undefined) {
              try {
                var blob = new Blob([fsStore[key]], { type: 'image/png' });
                v = URL.createObjectURL(blob);
              } catch (e) {}
            } else if (v.indexOf('wxfile://usr/') === 0) {
              v = '/' + v.slice('wxfile://usr/'.length);
            }
          }
          nativeImgSrcDesc.set.call(img, v);
        }
      });
    }
    img.addEventListener('load', function () {
      if (img.onload) img.onload();
    });
    img.addEventListener('error', function () {
      if (img.onerror) img.onerror();
    });
    return img;
  };

  // ---- 字体 ----
  // weapp-adapter 会 cloneMethod(wx, "loadFont") 到 __globalAdapter.loadFont,
  // 而 Cocos 的 assetManager 字体加载器会同步调用 __globalAdapter.loadFont(url) 拿 font-family。
  // 这里同时兼容两种调用:
  //   1) 同步:loadFont(".../xxx.ttf") -> 返回字体名(仿 font-loader 的 _getFontFamily)
  //   2) 异步:loadFont({family, source, success}) -> 回调 success
  function _getFontFamily(t) {
    var e = t.lastIndexOf('.ttf');
    if (e === -1) return t;
    var n = t.lastIndexOf('/');
    var name = n === -1 ? t.substring(0, e) + '_LABEL' : t.substring(n + 1, e) + '_LABEL';
    return name;
  }
  wx.loadFont = function (opt) {
    var source = typeof opt === 'string' ? opt : (opt && opt.source);
    var family = typeof opt === 'string' ? _getFontFamily(opt) : (opt && opt.family || _getFontFamily(source || ''));
    if (source && typeof FontFace !== 'undefined') {
      var url = source;
      if (url.indexOf('wxfile://usr/') === 0) url = '/' + url.slice('wxfile://usr/'.length);
      try {
        var ff = new FontFace(family, 'url(' + url + ')');
        ff.load().then(function (loaded) {
          document.fonts.add(loaded);
        }).catch(function () {});
      } catch (e) {}
    }
    if (typeof opt === 'string') return family;
    if (opt && typeof opt === 'object') {
      setTimeout(function () { opt.success && opt.success({ family: family }); }, 0);
      opt.complete && setTimeout(function () { opt.complete && opt.complete({ family: family }); }, 0);
    }
  };

  // ---- 触摸 & 鼠标统一输入事件系统 ----
  var touchHandlers = {
    onTouchStart: [],
    onTouchMove: [],
    onTouchEnd: [],
    onTouchCancel: []
  };

  wx.onTouchStart = function (h) { if (typeof h === 'function') touchHandlers.onTouchStart.push(h); };
  wx.onTouchMove = function (h) { if (typeof h === 'function') touchHandlers.onTouchMove.push(h); };
  wx.onTouchEnd = function (h) { if (typeof h === 'function') touchHandlers.onTouchEnd.push(h); };
  wx.onTouchCancel = function (h) { if (typeof h === 'function') touchHandlers.onTouchCancel.push(h); };
  wx.onKeyDown = function () {};
  wx.onKeyUp = function () {};

  function dispatchTouch(type, touches, changedTouches) {
    var list = touchHandlers[type];
    if (!list || list.length === 0) return;
    var evt = {
      touches: touches,
      changedTouches: changedTouches,
      timeStamp: Date.now()
    };
    for (var i = 0; i < list.length; i++) {
      try { list[i](evt); } catch (err) { console.error('[touchHandler err]', err); }
    }
  }

  var activeTouches = new Map();

  function toTouchItem(e) {
    return {
      identifier: e.pointerId !== undefined ? e.pointerId : (e.identifier !== undefined ? e.identifier : 0),
      clientX: e.clientX,
      clientY: e.clientY,
      pageX: e.pageX,
      pageY: e.pageY,
      force: e.pressure || 1
    };
  }

  function getActiveTouchesList() {
    var arr = [];
    activeTouches.forEach(function (t) { arr.push(t); });
    return arr;
  }

  // 高性能触控批处理调度器 (支持 120Hz/240Hz 采样硬件与 WebKit 手势防死锁)
  var pendingMoveTouches = null;
  var pendingChangedTouches = null;
  var moveRafId = null;

  function flushPendingTouchMove() {
    if (moveRafId) {
      cancelAnimationFrame(moveRafId);
      moveRafId = null;
    }
    if (pendingMoveTouches && pendingChangedTouches) {
      dispatchTouch('onTouchMove', pendingMoveTouches, pendingChangedTouches);
      pendingMoveTouches = null;
      pendingChangedTouches = null;
    }
  }

  // 阻止移动端页面橡皮筋滚动与多指手势争抢
  nativeAddEventListener('touchmove', function (e) {
    if (e.cancelable && (!e.target || !e.target.closest || !e.target.closest('#gm-toolbar'))) {
      e.preventDefault();
    }
  }, { passive: false });

  // 使用原生 window/document 监听 PointerEvent (完美兼容电脑鼠标拖拽、手机触摸、手写笔)
  nativeAddEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    // 如果点击的是开发者调试工具浮层,不透传给游戏画布
    if (e.target && e.target.closest && e.target.closest('#gm-toolbar')) return;
    if (e.cancelable) e.preventDefault();
    flushPendingTouchMove();
    var t = toTouchItem(e);
    activeTouches.set(t.identifier, t);
    dispatchTouch('onTouchStart', getActiveTouchesList(), [t]);
  }, { capture: true, passive: false });

  nativeAddEventListener('pointermove', function (e) {
    var id = e.pointerId !== undefined ? e.pointerId : 0;
    if (!activeTouches.has(id)) return;
    if (e.cancelable) e.preventDefault();
    var t = toTouchItem(e);
    activeTouches.set(id, t);
    pendingMoveTouches = getActiveTouchesList();
    pendingChangedTouches = [t];
    if (!moveRafId) {
      moveRafId = requestAnimationFrame(function () {
        moveRafId = null;
        if (pendingMoveTouches && pendingChangedTouches) {
          dispatchTouch('onTouchMove', pendingMoveTouches, pendingChangedTouches);
          pendingMoveTouches = null;
          pendingChangedTouches = null;
        }
      });
    }
  }, { capture: true, passive: false });

  function handlePointerEnd(e, isCancel) {
    var id = e.pointerId !== undefined ? e.pointerId : 0;
    if (!activeTouches.has(id)) return;
    if (e.cancelable) e.preventDefault();
    flushPendingTouchMove();
    var t = toTouchItem(e);
    activeTouches.delete(id);
    dispatchTouch(isCancel ? 'onTouchCancel' : 'onTouchEnd', getActiveTouchesList(), [t]);
  }

  nativeAddEventListener('pointerup', function (e) { handlePointerEnd(e, false); }, { capture: true, passive: false });
  nativeAddEventListener('pointercancel', function (e) { handlePointerEnd(e, true); }, { capture: true, passive: false });

  global.addEventListener('blur', function () {
    flushPendingTouchMove();
    if (activeTouches.size > 0) {
      var remaining = getActiveTouchesList();
      activeTouches.clear();
      dispatchTouch('onTouchCancel', [], remaining);
    }
  });

  // ---- 窗口/方向 ----
  wx.onWindowResize = function (h) {
    global.addEventListener('resize', function () {
      if (h) h({ windowWidth: global.innerWidth, windowHeight: global.innerHeight });
    });
  };
  wx.onDeviceOrientationChange = function (h) {};
  wx.setKeepScreenOn = function (o) {};

  // ---- 存储(localStorage) ----
  wx.setStorageSync = function (k, v) { try { nativeLocalStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  wx.getStorageSync = function (k) { try { var v = nativeLocalStorage.getItem(k); return v == null ? '' : JSON.parse(v); } catch (e) { return ''; } };
  wx.removeStorageSync = function (k) { try { nativeLocalStorage.removeItem(k); } catch (e) {} };
  wx.clearStorageSync = function () { try { nativeLocalStorage.clear(); } catch (e) {} };
  wx.getStorageInfoSync = function () { try { return { keys: Object.keys(nativeLocalStorage), currentSize: 0, limitSize: 10240 }; } catch (e) { return { keys: [], currentSize: 0, limitSize: 10240 }; } };

  // ---- 文件系统(内存 + HTTP 双通道) ----
  // 内存 fsStore:预加载的 config(供同步 readFileSync 使用);其余资源走 HTTP fetch
  var fsStore = {}; // 路径 -> 内容(String / ArrayBuffer / Uint8Array)
  function fsPath(p) { return (p || '').replace(/^wxfile:\/\/usr\//, ''); }
  global.__fsPreload = function (path, content) { fsStore[fsPath(path)] = content; };
  global.__fsStore = fsStore;

  // 全局拦截 HTMLImageElement.prototype.src: 确保 new Image() 也能优先从内存 fsStore 读取转 Blob URL
  if (nativeImgSrcDesc && global.HTMLImageElement) {
    Object.defineProperty(global.HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: true,
      get: function () { return nativeImgSrcDesc.get.call(this); },
      set: function (v) {
        if (typeof v === 'string') {
          var key = fsPath(v);
          if (fsStore && fsStore[key] !== undefined) {
            try {
              var blob = new Blob([fsStore[key]], { type: 'image/png' });
              v = URL.createObjectURL(blob);
            } catch (e) {}
          } else if (v.indexOf('wxfile://usr/') === 0) {
            v = '/' + v.slice('wxfile://usr/'.length);
          }
        }
        nativeImgSrcDesc.set.call(this, v);
      }
    });
  }
  var fs = {
    readFileSync: function (p, enc) {
      var c = fsStore[fsPath(p)];
      if (c === undefined) throw new Error('no such file: ' + p);
      if (enc === 'utf8') return typeof c === 'string' ? c : new TextDecoder().decode(c);
      return c;
    },
    readFile: function (opts) {
      tr("[wx.fs.readFile ENTER]", opts && opts.filePath, "enc=", opts && opts.encoding);
      var key = fsPath(opts.filePath || opts.path || '');
      // 1) 内存优先
      if (fsStore[key] !== undefined) {
        var mc = fsStore[key];
        var mdata = opts.encoding === 'utf8' ? (typeof mc === 'string' ? mc : new TextDecoder().decode(mc)) : (mc instanceof Uint8Array ? mc.buffer.slice(mc.byteOffset, mc.byteOffset + mc.byteLength) : mc);
        tr('[fs.readFile mem OK]', key, 'enc=', opts.encoding, 'len=', mdata ? (mdata.byteLength || mdata.length) : null);
        try { opts.success && opts.success({ data: mdata }); } catch (e) { console.error('[fs.readFile cb err]', e); opts.fail && opts.fail(e); }
        return;
      }
      // 2) HTTP 兜底:原生 XHR + 超时 + 重试(见文件头 nativeXHR 注释,fetch 方案已废弃)
      var fetchUrl = /^https?:\/\//i.test(key) ? key : ('/' + key.replace(/^\//, ''));
      tr("[wx.fs.readFile CALLING HTTP]", fetchUrl, "tries=1");
      var tries = 0;
      (function attempt() {
        tries++;
        var xhr = new nativeXHR();
        xhr.open('GET', fetchUrl, true);
        xhr.responseType = opts.encoding === 'utf8' ? 'text' : 'arraybuffer';
        xhr.timeout = 8000;
        var done = false;
        xhr.onload = function () {
          if (done) return; done = true;
          if (xhr.status >= 200 && xhr.status < 300) {
            tr("[wx.fs.readFile HTTP RES]", fetchUrl, xhr.status);
            tr('[fs.readFile OK]', key, 'bytes=', xhr.response ? (xhr.response.byteLength || xhr.response.length) : null);
            opts.success && opts.success({ data: xhr.response });
          } else if (tries < 3) {
            tr('[fs.readFile retry]', key, 'http', xhr.status, 'tries=', tries);
            setTimeout(attempt, 300);
          } else {
            console.error('[fs.readFile ERR]', key, 'http ' + xhr.status);
            opts.fail && opts.fail({ errMsg: 'http ' + xhr.status + ' ' + key });
          }
        };
        xhr.onerror = xhr.ontimeout = function () {
          if (done) return; done = true;
          if (tries < 3) { tr('[fs.readFile retry]', key, 'net', 'tries=', tries); setTimeout(attempt, 300); }
          else {
            console.error('[fs.readFile ERR]', key, 'xhr fail');
            opts.fail && opts.fail({ errMsg: 'xhr fail ' + key });
          }
        };
        xhr.send();
      })();
    },
    writeFileSync: function (p, data, enc) {
      if (typeof data === 'string' && enc !== 'utf8') data = new TextEncoder().encode(data);
      fsStore[fsPath(p)] = data;
    },
    writeFile: function (opts) { fs.writeFileSync(opts.filePath, opts.data, opts.encoding); opts.success && opts.success(); },
    mkdirSync: function () {}, mkdir: function (o) { o.success && o.success(); },
    rmdirSync: function () {}, rmdir: function (o) { o.success && o.success(); },
    unlinkSync: function (p) { delete fsStore[fsPath(p)]; },
    unlink: function (o) { fs.unlinkSync(o.filePath); o.success && o.success(); },
    accessSync: function (p) { if (fsStore[fsPath(p)] === undefined) throw new Error('no access'); },
    access: function (o) { o.success && o.success(); },
    readdirSync: function (p) { return Object.keys(fsStore).filter(function (k) { return k.indexOf(fsPath(p)) === 0; }); },
    readdir: function (o) { o.success && o.success(fs.readdirSync(o.dirPath)); },
    statSync: function (p) { var c = fsStore[fsPath(p)]; return { size: c ? c.length : 0, isFile: function () { return c !== undefined; }, isDirectory: function () { return false; } }; },
    stat: function (o) { try { o.success && o.success(fs.statSync(o.path)); } catch (e) { o.fail && o.fail(e); } },
    appendFileSync: function () {},
    copyFileSync: function (s, d) { fsStore[fsPath(d)] = fsStore[fsPath(s)]; },
    copyFile: function (o) { fs.copyFileSync(o.srcPath, o.destPath); o.success && o.success(); },
    saveFileSync: function (p) { return p; },
    saveFile: function (o) { o.success && o.success({ savedFilePath: o.tempFilePath }); },
    getSavedFileList: function (o) { o.success && o.success([]); },
    readFileSyncNoThrow: function (p) { return fsStore[fsPath(p)]; }
  };
  wx.getFileSystemManager = function () { return fs; };

  // ---- 网络 ----
  function toWxResponse(res, body, header) {
    return { statusCode: res.status, data: body, header: header || {}, errMsg: 'request:ok' };
  }
  wx.request = function (opts) {
    fetch(opts.url, { method: (opts.method || 'GET').toUpperCase(), body: opts.data, headers: opts.header })
      .then(function (res) {
        // dataType 语义:微信默认 "json"(解析为对象);"other"/"text" 返回原始文本,由调用方自行解析。
        // weapp-adapter 的 XMLHttpRequest 会传 dataType:"other" 且自己 JSON.parse,
        // 若这里提前把响应解析成对象,adapter 再 JSON.parse(对象) 会抛错 → response=null → bundle config 为 null。
        var dataType = opts.dataType || 'json';
        var wantRaw = dataType === 'other' || dataType === 'text';
        var wantArrayBuffer = opts.responseType === 'arraybuffer';
        var p = wantArrayBuffer ? res.arrayBuffer() : res.text();
        return p.then(function (body) {
          if (!wantRaw && !wantArrayBuffer && typeof body === 'string') {
            var ct = res.headers.get('content-type') || '';
            if (ct.indexOf('application/json') >= 0 || ct.indexOf('text/') >= 0) { try { body = JSON.parse(body); } catch (e) {} }
          }
          var header = {}; res.headers.forEach(function (v, k) { header[k] = v; });
          opts.success && opts.success(toWxResponse(res, body, header));
          opts.complete && opts.complete();
        });
      })
      .catch(function (e) {
        opts.fail && opts.fail({ errMsg: 'request:fail ' + (e && e.message) });
        opts.complete && opts.complete();
      });
    return { abort: function () {} };
  };
  wx.downloadFile = function (opts) {
    tr('[wx.downloadFile]', opts.url);
    fetch(opts.url).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + opts.url);
      return res.arrayBuffer().then(function (buf) {
        var tmp = 'wxfile://usr/tmp/dl_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        fs.writeFileSync(tmp, new Uint8Array(buf));
        tr('[wx.downloadFile OK]', opts.url, '->', tmp, 'bytes=', buf.byteLength);
        opts.success && opts.success({ tempFilePath: tmp, statusCode: res.status });
        opts.complete && opts.complete();
      });
    }).catch(function (e) {
      console.error('[wx.downloadFile FAIL]', opts.url, e && e.message);
      opts.fail && opts.fail({ errMsg: 'downloadFile:fail ' + (e && e.message) });
      opts.complete && opts.complete();
    });
    return { abort: function () {} };
  };
  wx.connectSocket = function () { return { onOpen: function () {}, send: function () {}, close: function () {} }; };
  wx.createTCPSocket = function () { return { connect: function () {}, onMessage: function () {}, onConnect: function () {}, send: function () {}, close: function () {} }; };

  // ---- 音频 ----
  wx.createInnerAudioContext = function () {
    var audio = nativeCreateElement('audio');
    var listeners = {};
    function addL(evt, fn) {
      if (!listeners[evt]) listeners[evt] = [];
      listeners[evt].push(fn);
    }
    function removeL(evt, fn) {
      if (listeners[evt]) {
        listeners[evt] = listeners[evt].filter(function (f) { return f !== fn; });
      }
    }
    function emit(evt, arg) {
      if (listeners[evt]) {
        listeners[evt].forEach(function (f) { try { f(arg); } catch (e) {} });
      }
    }

    audio.addEventListener('canplay', function () { emit('canplay'); });
    audio.addEventListener('play', function () { emit('play'); });
    audio.addEventListener('pause', function () { emit('pause'); });
    audio.addEventListener('ended', function () { emit('ended'); });
    audio.addEventListener('error', function (e) { emit('error', e); });
    audio.addEventListener('timeupdate', function () { emit('timeupdate'); });
    audio.addEventListener('waiting', function () { emit('waiting'); });
    audio.addEventListener('seeking', function () { emit('seeking'); });
    audio.addEventListener('seeked', function () { emit('seeked'); });

    var ctx = {
      set src(v) {
        var key = typeof v === 'string' ? v.replace(/^wxfile:\/\/usr\//, '') : '';
        if (key && fsStore[key]) {
          var buf = fsStore[key];
          var blob = new Blob([buf], { type: 'audio/mpeg' });
          audio.src = URL.createObjectURL(blob);
          return;
        }
        if (typeof v === 'string' && v.indexOf('wxfile://usr/') === 0) {
          v = '/' + v.slice('wxfile://usr/'.length);
        }
        audio.src = v;
      },
      get src() { return audio.src; },
      set loop(v) { audio.loop = !!v; },
      get loop() { return audio.loop; },
      set volume(v) { audio.volume = v; },
      get volume() { return audio.volume; },
      set autoplay(v) { audio.autoplay = !!v; },
      get autoplay() { return audio.autoplay; },
      get duration() { return audio.duration || 0; },
      get currentTime() { return audio.currentTime || 0; },
      get paused() { return audio.paused; },
      get buffered() { return audio.buffered ? (audio.buffered.length > 0 ? audio.buffered.end(0) : 0) : 0; },
      play: function () {
        var p = audio.play();
        if (p && p.catch) {
          p.catch(function (e) {
            console.warn('[InnerAudio play error]', e && e.message, audio.src);
          });
        }
      },
      pause: function () { audio.pause(); },
      stop: function () { audio.pause(); audio.currentTime = 0; emit('stop'); },
      seek: function (t) { audio.currentTime = t; },
      destroy: function () {
        audio.pause();
        if (audio.src && audio.src.indexOf('blob:') === 0) {
          try { URL.revokeObjectURL(audio.src); } catch (e) {}
        }
        audio.src = '';
        listeners = {};
      },

      onCanplay: function (fn) { addL('canplay', fn); },
      offCanplay: function (fn) { removeL('canplay', fn); },
      onPlay: function (fn) { addL('play', fn); },
      offPlay: function (fn) { removeL('play', fn); },
      onPause: function (fn) { addL('pause', fn); },
      offPause: function (fn) { removeL('pause', fn); },
      onStop: function (fn) { addL('stop', fn); },
      offStop: function (fn) { removeL('stop', fn); },
      onEnded: function (fn) { addL('ended', fn); },
      offEnded: function (fn) { removeL('ended', fn); },
      onError: function (fn) { addL('error', fn); },
      offError: function (fn) { removeL('error', fn); },
      onTimeUpdate: function (fn) { addL('timeupdate', fn); },
      offTimeUpdate: function (fn) { removeL('timeupdate', fn); },
      onWaiting: function (fn) { addL('waiting', fn); },
      offWaiting: function (fn) { removeL('waiting', fn); },
      onSeeking: function (fn) { addL('seeking', fn); },
      offSeeking: function (fn) { removeL('seeking', fn); },
      onSeeked: function (fn) { addL('seeked', fn); },
      offSeeked: function (fn) { removeL('seeked', fn); }
    };
    return ctx;
  };
  wx.onAudioInterruptionBegin = function () {};
  wx.onAudioInterruptionEnd = function () {};

  // ---- 开放数据域 / 分享 / 其他 ----
  wx.getOpenDataContext = function () {
    return { postMessage: function () {}, canvas: nativeCreateElement('canvas'), createImage: wx.createImage, getSharedCanvas: function () { return nativeCreateElement('canvas'); } };
  };
  wx.getSharedCanvas = function () { return nativeCreateElement('canvas'); };
  wx.shareAppMessage = function (o) { o && o.success && o.success(); };
  wx.onShareAppMessage = function () { return {}; };
  wx.onShareTimeline = function () { return {}; };
  wx.onAddToFavorites = function () { return {}; };
  wx.setClipboardData = function (o) { o && o.success && o.success(); };
  wx.showToast = function (o) { console.log('[toast]', o && o.title); o && o.success && o.success(); };
  wx.showModal = function (o) { console.log('[modal]', o && o.title, o && o.content); if (o) { (o.success || function () {})({ confirm: true, cancel: false }); } };
  wx.setUserCloudStorage = function () {};
  wx.setFriendUserStorage = function () {};
  wx.saveImageToPhotosAlbum = function (o) { o && o.fail && o.fail(); };
  wx.previewImage = function (o) {};
  wx.openSetting = function (o) { o && o.fail && o.fail(); };
  wx.getSetting = function (o) { o && o.success && o.success({ authSetting: {} }); };
  wx.exitMiniProgram = function () {};
  wx.restartMiniProgram = function () {};
  wx.markScene = function () {};
  wx.getRealtimeLogManager = function () { return { info: function () {}, warn: function () {}, error: function () {} }; };
  wx.getUpdateManager = function () { return { onCheckForUpdate: function () {}, onUpdateReady: function () {}, onUpdateFailed: function () {}, applyUpdate: function () {} }; };
  wx.createPageManager = function () { return {}; };

  // ---- 传感器 ----
  wx.startAccelerometer = function (o) { o && o.fail && o.fail(); };
  wx.stopAccelerometer = function (o) { o && o.success && o.success(); };
  wx.onAccelerometerChange = function () {};

  // ---- 生命周期 / 错误 ----
  wx.onShow = function () {}; wx.onHide = function () {};
  wx.onError = function (h) { global.addEventListener('error', function (e) { h && h(e.message || 'error'); }); };
  wx.offError = function () {};
  wx.onMemoryWarning = function () {}; wx.triggerGC = function () {};
  wx.onNetworkStatusChange = function () {};

  // ---- 广告 / 直玩(降级) ----
  wx.onDirectAdStatusChange = function () {};
  wx.getDirectAdStatusSync = function () { return false; };
  wx.notifyMiniProgramPlayableStatus = function () {};
  wx.requestMidasPaymentGameItem = function (o) { o && o.fail && o.fail({ errMsg: 'payment not available' }); };
  wx.requestMerchantTransfer = function (o) { o && o.fail && o.fail({ errMsg: 'not available' }); };

  // ---- 分包加载 ----
  // 分包代码是 define 模块,需 fetch + eval 注册;subpackageUrls 动态读取(晚于本文件设置)
  var loadedSubs = {};
  wx.loadSubpackage = function (opts) {
    var name = opts.name;
    if (loadedSubs[name]) { opts.success && opts.success(); return; }
    var urls = global.__SUBPACKAGE_URLS__ || {};
    var url = urls[name];
    if (!url) { opts.fail && opts.fail({ errMsg: 'no subpackage ' + name }); return; }
    fetch(url).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (src) {
        // 修正 debug 模式的 bundle 下载器:它只把 spineAsset/gameAsset/remoteAsset 的 config.json
        // 路由到 localhost:3002,而 zh/en/jp/kr/zh-tw/miniGameRes 走相对路径 fetch(会 404)。
        // 这里把语言包 zh 也一并路由到 localhost:3002(该服务器已映射 zh config)。
        src = src.replace('["spineAsset","gameAsset","remoteAsset"].some(function(e){return t.includes(e);})',
          '["spineAsset","gameAsset","remoteAsset","zh","en","jp","kr","zh-tw","miniGameRes"].some(function(e){return t.includes(e);})');

        // 修复小房间(HouseScreen)建造修缮实物图层被遮挡(缺少 sortDepths 导致未分配高 zIndex):
        // 1. Prefab 挂载瞬间立即进行深度重排
        src = src.replace('this.refreshLockBubbleLayer(),this.adornViewY=this.adornView.y',
          'this.refreshLockBubbleLayer(),(this.map&&this.map.sortDepths(!0,!0)),this.adornViewY=this.adornView.y');
        // 2. 建造特效/烟花完成回调时对房间进行深度重排 (对齐 HomeScreen 标准逻辑)
        src = src.replace('this.mapView.updateBuildBubbles(!0);},i.instance=null,i.needRefreshBoardData=!0',
          'this.mapView.updateBuildBubbles(!0),this.mapView.sortDepths(!0,!0);},i.instance=null,i.needRefreshBoardData=!0');
        // 3. 根因修复: buildAdornAsync 结束时必须调用 checkUnlock() 将装扮加入排序器组, 并立即执行全房深度重排
        src = src.replace('case 7:return console.timeEnd("建造:"+i),[2];',
          'case 7:s&&(s.checkUnlock&&s.checkUnlock(),s.map&&s.map.sortDepths&&s.map.sortDepths(!0,!0));return console.timeEnd("建造:"+i),[2];');

        // 修复做菜钻石加速不扣减钻石: 确认花钻加速时同步扣除本地钻石
        src = src.replace('this.requestSpeedUp(),l.order.endTime=d3.serverTime',
          'this.requestSpeedUp(),(d3.role.diamond=Math.max(0,d3.role.diamond-o)),(w.emit&&w.emit(g.DiamondCost)),l.order.endTime=d3.serverTime');

        // 彻底修复储物箱/背包存入道具丢失、无图标及卡顿 (精准透传 elementId，严禁零值废对象污染背包，防止遮罩锁死)
        // 1. 网络请求参数直接透传真实 elementId，确保服务端 100% 获得道具 ID
        src = src.replace('Dk.instance.send(Od.cellToBag,{boardId:o3.Data.id,index:e[0].serverIdx,isMp:!1,isPassNew:!1,timestamp:d3.serverTime}',
          'Dk.instance.send(Od.cellToBag,{boardId:o3.Data.id,index:e[0].serverIdx,elementId:u,isMp:!1,isPassNew:!1,timestamp:d3.serverTime}');
        src = src.replace('Dk.instance.send(Od.cellToBag,{boardId:o3.Data.id,index:t[0].serverIdx,isMp:!1,isPassNew:!1,timestamp:d3.serverTime}',
          'Dk.instance.send(Od.cellToBag,{boardId:o3.Data.id,index:t[0].serverIdx,elementId:s,isMp:!1,isPassNew:!1,timestamp:d3.serverTime}');

        // 2. MergeBagView.onPutIn 与 BagElement.onPutInto 存入时兜底构造完整 cell 并强制锁定 elementId
        src = src.replace('var u=e[0].mergeCellData.config.id,h=o3.BoardCells.get(e[0].serverIdx);h._speedUpStartTime=0,h.recovery.forEach(function(e,t){e instanceof x2&&h.recovery.set(t,e.toData());}),h.index=-1;var p=fG.GetMergeIncreaseId();l?o3.BagProduct.set(p,h):o3.Data.bag.items.set(p,h)',
          'var u=e[0].mergeCellData.config.id,h=o3.BoardCells.get(e[0].serverIdx)||(d?Object.assign({},d):{elementId:u,recovery:new Map()});h.elementId=u,h.recovery=h.recovery||new Map(),h._speedUpStartTime=0,h.recovery.forEach(function(e,t){e instanceof x2&&h.recovery.set(t,e.toData());}),h.index=-1;var p=fG.GetMergeIncreaseId();h.elementId=u;l?o3.BagProduct.set(p,h):o3.Data.bag.items.set(p,h)');
        src = src.replace('(u=o3.BoardCells.get(t[0].serverIdx))._speedUpStartTime=0,u.recovery.forEach(function(e,t){e instanceof x2&&u.recovery.set(t,e.toData());})',
          '(u=o3.BoardCells.get(t[0].serverIdx)||(d?Object.assign({},d):{elementId:s,recovery:new Map()})),u.elementId=s,u.recovery=u.recovery||new Map(),u._speedUpStartTime=0,u.recovery.forEach(function(e,t){e instanceof x2&&u.recovery.set(t,e.toData());})');
        src = src.replace('l||(u.index=-1,f=fG.GetMergeIncreaseId(),o3.Data.bag.items.set(f,u))',
          'u.elementId=(s||(t[0]&&t[0].elementId)||u.elementId),l||(u.index=-1,f=fG.GetMergeIncreaseId(),o3.Data.bag.items.set(f,u))');

        // 3. ClosetWindow.showNormal 排序容错，保留道具原有真实 elementId
        src = src.replace('for(o3.Bag.forEach(function(n,o){var r;t.push({idx:i,cell:o3.Bag.get(o)',
          'for(o3.Bag.forEach(function(n,o){var r,c=o3.Bag.get(o);if(c&&!c.elementId&&n&&n.elementId){c.elementId=n.elementId;}t.push({idx:i,cell:c');
        src = src.replace('t.sort(function(e,t){return e.cell.elementId-t.cell.elementId;})',
          't.sort(function(e,t){return ((e.cell&&e.cell.elementId)||0)-((t.cell&&t.cell.elementId)||0);})');

        // 4. ClosetItem.onClickInfo 点击详情严格防卡死保护 (缺失 elementId 时坚决不弹窗，杜绝模态遮罩锁死)
        src = src.replace('.onClickInfo=function(){lp.isRunning()||fG.ShowElementDetail(this.data.cell.elementId);}',
          '.onClickInfo=function(){if(!this.data||!this.data.cell||!this.data.cell.elementId)return;lp.isRunning()||fG.ShowElementDetail(this.data.cell.elementId);}');

        // 5. 彻底隐藏设置/邮件旁的“小游戏”、“订阅”、“录屏”外挂入口，保持界面清爽纯净
        src = src.replace('ah.setOpen(th.DyMinigame,e&&($t()||Xt()||CC_DEV))', 'ah.setOpen(th.DyMinigame,!1)');
        src = src.replace('ah.setOpen(th.Subscribe,e&&dB.isUnlockSubscribeWindow())', 'ah.setOpen(th.Subscribe,!1)');
        src = src.replace('ah.setOpen(th.DyRecord,e&&$t()&&!su.isDouyinMiniGameHongMeng)', 'ah.setOpen(th.DyRecord,!1)');

        // 6. 全局奖励演出防空安全保护 (杜绝 rewards 为 undefined 时报 Cannot read properties of undefined (reading 'length'))
        src = src.replace('e.ShowRewards=function(e,t){var n;', 'e.ShowRewards=function(e,t){if(!e||!e.length)return Promise.resolve();var n;');

        (0, eval)(src);
        loadedSubs[name] = true;
        opts.success && opts.success();
      })
      .catch(function (e) { opts.fail && opts.fail({ errMsg: 'load subpackage fail ' + name + ': ' + e.message }); });
  };
  // 微信还有全局 require 分包的场景
  wx.min = function (a, b) { return a < b ? a : b; };

  // 微信原生 UI 按钮 polyfill (修复 SettingWindow 游戏圈/意见反馈/用户信息按钮)
  function createFakeWxButton(opts) {
    opts = opts || {};
    var callbacks = [];
    return {
      type: opts.type || 'image',
      image: opts.image || '',
      style: opts.style || { left: 0, top: 0, width: 0, height: 0 },
      show: function () {},
      hide: function () {},
      destroy: function () {},
      onTap: function (fn) { if (typeof fn === 'function') callbacks.push(fn); },
      offTap: function (fn) {
        var idx = callbacks.indexOf(fn);
        if (idx !== -1) callbacks.splice(idx, 1);
      }
    };
  }

  wx.createGameClubButton = createFakeWxButton;
  wx.createFeedbackButton = createFakeWxButton;
  wx.createUserInfoButton = createFakeWxButton;

  global.__wx = wx;
  console.log('[wx-polyfill] ready, platform=devtools');
})(typeof window !== 'undefined' ? window : this);
