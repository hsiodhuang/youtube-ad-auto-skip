# 开发验证

安装和使用扩展不需要 Node.js、Python 或编译步骤。以下命令仅用于开发验证。

## 自动测试

使用 Node.js 24 或更新版本，在仓库根目录运行：

```sh
node --test tests/page-hook.test.cjs tests/ad-audio.test.cjs tests/content-visibility.test.cjs
```

共 53 项测试：26 项页面事件兼容检查、23 项标签页静音及恢复检查，以及 4 项前后台回归检查。回归检查覆盖后台等待按钮后自动跳过、前后台真实点击失败的重试上限，以及后台广告结束后的声音恢复。测试使用 Node 内置模块，不需要安装 npm 依赖；浏览器 API 使用模拟对象。

## 浏览器模拟场景

安装 Python 3 后，在仓库根目录运行：

```sh
python3 tests/server.py
```

然后用 Chrome 打开 <http://127.0.0.1:8766/watch?v=fixture>。服务仅监听本机回环地址。

该页面用模拟广告与按钮检查 DOM 行为，不访问真实 YouTube，也不代表真实广告的实播结果。

后台场景打开 <http://127.0.0.1:8766/watch?v=background-fixture&fixture=background>，按页面说明切到其他标签页，稍后返回查看结果。该场景使用真实的页面可见性状态，检查后台按钮启用、兼容点击、广告状态变化和模拟静音恢复；声音接口及广告仍为本地模拟。
