# Personal AI Research Agent

每天自动获取并筛选 AI、RAG、Agent 方向论文，调用现有 RAG 项目的百炼 API 完成评分、正文证据分析和中文摘要，再生成 Markdown/JSON 日报并沉淀历史趋势。

## 第二阶段已实现

```text
n8n 每天 04:30 JST（业务低峰）
        ↓
Research Agent HTTP 服务
        ↓
arXiv + Hugging Face Daily Papers
        ↓
关键词与主题规则初筛（最多 12 篇）
        ↓
百炼 qwen3.7-max 批量评分与中文摘要
        ↓
GitHub 仓库发现与社区信号校验
        ↓
Top 3 PDF 正文证据与复现清单
        ↓
PostgreSQL 历史、去重与 14 日趋势
        ↓
飞书机器人推送指定群聊或用户（按日期去重、失败重试 3 次）
        ↓
reports/YYYY-MM-DD.md + JSON + latest.md
```

评分权重：方向匹配 40%、方法创新 25%、工程价值 25%、摘要证据充分度 10%。模型被明确要求不得虚构引用量、GitHub 热度、实验结果或顶会状态。

## 模型配置

- `scripts/stack.sh` 从 `RAG_ENV_FILE` 指向的外部私密文件读取 `BAILIAN_API_KEY`。
- 不复制密钥，也不把密钥写入本项目、镜像或 Git。
- 默认模型路线为百炼美国区 Anthropic 兼容端点 + 国内模型 `qwen3.7-max`。
- Hugging Face、GitHub 或 PDF 单源失败时会明确降级；不会阻断 arXiv + 百炼核心日报，也不会补写未经验证的数据。

## 启动

```bash
cp .env.example .env
# 编辑 .env，将 RAG_ENV_FILE 指向仓库外的私密环境文件
chmod +x scripts/stack.sh
./scripts/stack.sh up
```

启动后：

- n8n：<http://127.0.0.1:5678>
- Agent 健康检查：<http://127.0.0.1:8787/health>
- 手动跑一次：`./scripts/stack.sh run`
- 查看状态：`./scripts/stack.sh status`
- 查看日志：`./scripts/stack.sh logs`

n8n 工作流会自动导入并尝试激活。首次打开 n8n 时仍需完成本地管理员初始化；服务只绑定 `127.0.0.1`，不会暴露到局域网或公网。

## 本地验证

```bash
npm test

set -a
source /absolute/path/to/private/model.env
set +a
DATA_DIR="$PWD/data" REPORTS_DIR="$PWD/reports" npm run run:once
```

若百炼临时失败，流程会生成带明显警告的规则降级日报，不会把规则分数伪装成模型结论。所有数据库事件时间字段使用 `TIMESTAMPTZ`，避免本地与服务器时区造成跨日偏差。

## 服务器部署

服务器部署使用独立容器、Docker 网络和数据卷，不连接其他业务数据库。首次部署会从 `REMOTE_SOURCE_ENV` 指向的服务器私密环境文件读取所需凭据，并在权限为 `600` 的专属配置文件中生成 PostgreSQL 密码与 n8n 加密密钥。

作为内部低优先级服务，服务器侧硬限制为：总 CPU 上限 1 核（Agent 0.50、n8n 0.35、PostgreSQL 0.15），总内存上限约 1.6 GiB，禁止使用 swap，日志自动轮转，并把 OOM 淘汰优先级设置为先终止本服务。日报安排在每日 04:30 JST 的业务低峰。

```bash
cp .deploy.env.example .deploy.env
# 在 .deploy.env 中填写服务器、SSH key、私密环境文件与飞书目标
./scripts/deploy-server.sh
```

部署会依次执行测试、创建不可变版本目录、构建/启动、Agent 与 n8n 健康检查、完整日报冒烟测试和数据库验收；任一门禁失败会恢复到上一版本。

服务只监听服务器回环地址。如需查看 n8n，可建立 SSH 隧道：

```bash
ssh -i /absolute/path/to/ssh-key -L 5678:127.0.0.1:5678 deploy-user@example-host
```

浏览器访问 <http://127.0.0.1:5678>。

## 后续阶段

飞书群聊或私信推送可通过环境变量启用。第三阶段可增加 Notion、邮件等多渠道投递与阅读反馈闭环。
