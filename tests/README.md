# 开发验证

安装和使用扩展不需要 Node.js、Python 或编译步骤。以下命令仅用于开发验证。

## 自动测试

使用 Node.js 24 或更新版本，在仓库根目录运行：

```sh
node --test tests/page-hook.test.cjs tests/ad-audio.test.cjs
```

共 49 项测试：26 项页面事件兼容检查和 23 项标签页静音及恢复检查。测试使用 Node 内置模块，不需要安装 npm 依赖；浏览器 API 使用模拟对象。

## 浏览器模拟场景

安装 Python 3 后，在仓库根目录运行：

```sh
python3 tests/server.py
```

然后用 Chrome 打开 <http://127.0.0.1:8766/watch?v=fixture>。服务仅监听本机回环地址。

该页面用模拟广告与按钮检查 DOM 行为，不访问真实 YouTube，也不代表真实广告的实播结果。
