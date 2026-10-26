# 参考与署名

本项目的生产源码围绕自动跳过广告、广告期间静音和声音状态保护实现。开发过程中查阅了以下开源项目，未将其整个项目或研究副本打包发布。

- **yt-ad-autoskipper**，作者 Shreya Dahal：网页点击事件兼容思路参考。核对版本为 `cc4fc71cadbddf1f27f00cbd8b92f31115c9083d`。[参考实现](https://github.com/squgeim/yt-ad-autoskipper/blob/cc4fc71cadbddf1f27f00cbd8b92f31115c9083d/src/contentScripts/youtube/overrideEvent.ts)，[GPL-3.0 许可证](https://github.com/squgeim/yt-ad-autoskipper/blob/cc4fc71cadbddf1f27f00cbd8b92f31115c9083d/LICENSE.md)。本项目重新实现了监听器身份及移除配对、委托点击兼容、事件缓存、原型及接收者处理，并加入广告状态、按钮标记、可见性、倒计时及遮挡检查。
- **AutoSkip**：用于了解可用跳过按钮检测与浏览器调试接口点击的方案。[核对版本](https://github.com/sakel4/AutoSkip/tree/fb628fb7d611654060455facf07caa62dcd9bd91)。正式版不采用其调试接口点击路径。
- **ad-mute**：用于对照自动跳过、广告静音和结束解除静音的功能组合。[核对实现](https://github.com/1polygon/ad-mute/blob/fe81b534e664043732d615bbdda21109f331254c/youtube.js)。本项目通过标签页临时静音处理广告，并保留用户原来的声音选择。

各参考项目及名称归其各自作者所有。本仓库以 GPL-3.0-only 发布，完整条款见 [LICENSE](LICENSE)。
