---
description: 快速在不修改代码的情况下，将 UI 样式直接推送到真实的 Telegram 客户端进行渲染和排版验收
---

# 动态测试 Telegram UI 渲染 (Live UI Mockup Rendering)

由于 Telegram 特定的排版限制（例如移动端的宽中文字符极易折行、或部分官方标签如 `<blockquote expandable>`在各端的表现有细微差异），经常需要绕过重启服务的过程，直接测试原始文本的排版效果。此流程用于快速向开发者下发多套 UI 排版供肉眼定稿。

## 步骤

1. **提取环境变量与凭证**
   通过读取系统或环境配置（通常位于 `~/.config/codex-telegram-bridge/bridge.env`）获取 `TELEGRAM_BOT_TOKEN`。同时通过读取 SQLite 或向用户请求获取 `CHAT_ID`。
   
2. **生成临时的 API 投递脚本**
   利用工具在 `/tmp/` 目录下生成一个临时 Bash 脚本（例如 `/tmp/test_ui_mockup.sh`）。
   > **关键实现技巧**：必须在 Bash 中使用严格的原样文本块（`read -r -d '' MOCKUP_TEXT <<'EOF'`）以防止 HTML 转义异常，同时使用 `jq` 安全地序列化 JSON：
   
   ```bash
   #!/bin/bash
   # 如果在特殊网络环境，需要自带 Proxy
   export HTTPS_PROXY=http://127.0.0.1:7897 
   TOKEN="..."
   CHAT_ID="..."
   
   read -r -d '' MOCKUP_TEXT <<'EOF'
   🎯 <b>【测试标题】</b>
   <blockquote expandable>输入极长的日志用于测试折叠能力...</blockquote>
   EOF
   
   curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
     -H "Content-Type: application/json" \
     -d "$(jq -n --arg chat_id "$CHAT_ID" --arg text "$MOCKUP_TEXT" '{chat_id: $chat_id, text: $text, parse_mode: "HTML"}')"
   ```

// turbo
3. **执行并下发**
   运行上述 Bash 脚本，将撰写的多套排版真实且直觉地展现在用户手机上。可同时写入多个 `curl` 重复请求。

4. **请求人工确认反馈**
   主动暂停并询问开发者的观感或屏幕折行情况，彻底打磨定稿后再进入 `ui-runtime.ts` 的实际代码重构阶段。
