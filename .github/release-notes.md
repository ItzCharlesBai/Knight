## 下载哪个

| 系统 | 文件 |
| --- | --- |
| Windows 10 / 11 | `Ondine-…-win-x64-setup.exe`（ARM 电脑选 `win-arm64-setup.exe`） |
| macOS · Apple 芯片 | `Ondine-…-mac-arm64.dmg` |
| macOS · Intel | `Ondine-…-mac-x64.dmg` |
| Linux | `Ondine-…-linux-x86_64.AppImage`；Debian / Ubuntu 也可以用 `linux-amd64.deb`（ARM 选带 `arm64` 的） |

安装包自带 mihomo 内核和 GEO 数据，打开后在「订阅」页粘贴订阅链接就能用。

## 第一次打开

- **Windows**：安装包没有代码签名，SmartScreen 拦下时点「更多信息 → 仍要运行」。
- **macOS**：只做了 ad-hoc 签名、没有公证。第一次打开被拦时，到「系统设置 → 隐私与安全性」底部点「仍要打开」（较早的系统也可以右键 → 打开）。
- **Linux**：AppImage 先 `chmod +x` 再运行；deb 用 `sudo apt install ./文件名.deb` 安装。

功能和用法见 [app/README.md](https://github.com/ItzCharlesBai/Knight/blob/{{tag}}/app/README.md)。
