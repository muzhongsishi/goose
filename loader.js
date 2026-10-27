// 微信小游戏 AMD loader(CommonJS-wrapper 风格)的浏览器实现
// 三个 game.js(主包/main 分包/miniGame 分包)都用 define(name, factory) 注册模块,
// 用 require(path) 加载。这里提供等价实现。
(function (global) {
  var modules = {}; // name -> factory
  var cache = {};   // name -> module

  // 解析 require 的相对路径:基于当前模块名
  function resolvePath(base, req) {
    if (req.charAt(0) !== '.') {
      // 绝对路径:去掉可能的前导 '/' 即可
      return req.replace(/^\/+/, '');
    }
    var segs = base.split('/');
    segs.pop(); // 去掉当前模块的文件名
    var parts = req.split('/');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p === '' || p === '.') continue;
      if (p === '..') segs.pop();
      else segs.push(p);
    }
    return segs.join('/');
  }

  var loadDepth = 0;
  var loadCount = {}; // 模块加载次数统计(用于发现死循环)
  function load(name) {
    if (cache[name]) return cache[name].exports;
    loadDepth++;
    loadCount[name] = (loadCount[name] || 0) + 1;
    if (loadCount[name] > 100000) {
      throw new Error('[loader] 疑似死循环,模块 ' + name + ' 加载 ' + loadCount[name] + ' 次');
    }
    if (loadDepth > 3000) {
      throw new Error('[loader] require 深度超限 ' + loadDepth + ',当前模块 ' + name);
    }
    var factory = modules[name];
    if (factory === undefined && modules[name + '.js'] !== undefined) {
      var r = load(name + '.js');
      loadDepth--;
      return r;
    }
    if (factory === undefined) {
      loadDepth--;
      throw new Error("Cannot find module '" + name + "'");
    }
    var module = { exports: {} };
    cache[name] = module;
    var localRequire = function (req) {
      return load(resolvePath(name, req));
    };
    // CommonJS wrapper: factory(require, module, exports)
    factory(localRequire, module, module.exports);
    loadDepth--;
    return module.exports;
  }

  global.define = function (name, deps, factory) {
    if (typeof deps === 'function') { factory = deps; deps = null; }
    modules[name] = factory;
  };
  // 兼容 require.ensure 等 RequireJS 残留调用
  global.require = function (name) {
    return load(name.replace(/^\/+/, ''));
  };
  // 暴露给调试
  global.__amd = { modules: modules, cache: cache, resolvePath: resolvePath };

  // 台湾/海外账号绑定调试模块桩(非开发/真实包中不存在此模块)
  global.define("debug/TwAccountBindingDebug", function (require, module, exports) {
    module.exports = {
      getTwAccountBindingDebug: function () {
        return null;
      }
    };
  });
})(typeof window !== 'undefined' ? window : this);
