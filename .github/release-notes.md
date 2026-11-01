## 下载

| 系统 | 直接下载 | 国内加速 |
| --- | --- | --- |
| Windows 10 / 11 | [win-x64-setup.exe](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-win-x64-setup.exe) | [加速下载](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-win-x64-setup.exe) |
| Windows · ARM | [win-arm64-setup.exe](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-win-arm64-setup.exe) | [加速下载](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-win-arm64-setup.exe) |
| macOS · Apple 芯片 | [mac-arm64.dmg](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-mac-arm64.dmg) | [加速下载](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-mac-arm64.dmg) |
| macOS · Intel | [mac-x64.dmg](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-mac-x64.dmg) | [加速下载](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-mac-x64.dmg) |
| Linux | [x86_64.AppImage](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-x86_64.AppImage) · [amd64.deb](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-amd64.deb) | [AppImage](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-x86_64.AppImage) · [deb](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-amd64.deb) |
| Linux · ARM | [arm64.AppImage](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-arm64.AppImage) · [arm64.deb](https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-arm64.deb) | [AppImage](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-arm64.AppImage) · [deb](https://ghfast.top/https://github.com/ItzCharlesBai/Knight/releases/download/{{tag}}/Ondine-{{version}}-linux-arm64.deb) |

国内直接下载慢、或者下到一半失败，就点「国内加速」。加速站是第三方的，下完可以核对一下文件的 sha256（下面文件列表里每个文件旁边都有）。

安装包自带 mihomo 内核和 GEO 数据，打开后在「订阅」页粘贴订阅链接就能用。

## 第一次打开

- **Windows**：安装包没有代码签名，SmartScreen 拦下时点「更多信息 → 仍要运行」。
- **macOS**：只做了 ad-hoc 签名、没有公证。第一次打开被拦时，到「系统设置 → 隐私与安全性」底部点「仍要打开」（较早的系统也可以右键 → 打开）。
- **Linux**：AppImage 先 `chmod +x` 再运行；deb 用 `sudo apt install ./文件名.deb` 安装。

功能和用法见 [app/README.md](https://github.com/ItzCharlesBai/Knight/blob/{{tag}}/app/README.md)。
