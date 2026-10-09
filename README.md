# Personal AI Research Agent

每天自动获取并筛选 AI、RAG、Agent 方向论文，调用现有 RAG 项目的百炼 API 完成评分、正文证据分析和中文摘要，再生成 Markdown/JSON 日报并沉淀历史趋势。

## 第二阶段已实现

```text
n8n 每天 08:30 GMT+8 开始（低优先级，允许延迟投送）
        ↓
Research Agent HTTP 服务
        ↓
arXiv + Hugging Face Daily Papers
        ↓
关键词与主题规则初筛（最多 12 篇）
        ↓
百炼 qwen3.8-max 批量评分与中文摘要
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

原有质量评分保持不变：方向匹配 40%、方法创新 25%、工程价值 25%、摘要证据充分度 10%。在最终候选池中，另外按“现有 RAG 服务直接复用/适配价值 60% + 英语与技术精读价值 40%”选出一篇优先论文，必要时最多替换质量 Top 5 的最后一篇，并固定排在日报第 1 位。其余论文保持原质量排序，飞书仍只发送一条日报。模型被明确要求不得虚构引用量、GitHub 热度、实验结果或顶会状态。

## 空结果闸门（fail-closed）

日报管道是静默的：一份「0 篇」的日报如果被标成 `delivered`，从外面看和正常的一天没有区别。因此产出为空时一律按失败处理：

- **不投递**：`deliverReport` 与 `sendFeishuDigest` 两层都会拒绝 0 篇的日报，手动补投 `/deliver/latest` 同样拦得住。
- **不标 delivered**：投递记录写 `blocked-empty`，运行记录写 `failed`，都不会计入「今天已推送」。
- **不静默**：`POST /run` 返回 HTTP 500，n8n 执行转红；同时向飞书推一条带失败环节的告警（`FEISHU_ALERT_ON_EMPTY=0` 可关）。
- **可定位**：闸门会指出第一个变空的环节（`source` / `recency` / `topic-rules` / `ranking` / `selection`），运行元数据里带完整管道计数与 arXiv 返回结果的最新/最旧时间。

arXiv 会在后端降级时用 200 返回一页**丢掉了 submittedDate 排序**的结果，这正是 2026-09-09 的故障成因：采集到 100 篇，却没有一篇落在 4 天窗口内。现在 arXiv 请求带退避重试，排序异常会记入元数据并把该次运行标为降级。

需要纠正一次已经推错的投递时，用 `POST /run?force=1` 或 `POST /deliver/latest?force=1`：原记录保留为 `superseded`，不会被删。`force` 不会绕开空结果闸门。

## 模型配置

- `scripts/stack.sh` 从 `RAG_ENV_FILE` 指向的外部私密文件读取 `BAILIAN_API_KEY`。
- 不复制密钥，也不把密钥写入本项目、镜像或 Git。
- 默认模型路线为百炼美国区 Anthropic 兼容端点 + `qwen3.8-max`。
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

作为内部低优先级服务，服务器侧硬限制为：总 CPU 上限 1 核（Agent 0.50、n8n 0.35、PostgreSQL 0.15），总内存上限约 1.6 GiB，禁止使用 swap，日志自动轮转，并把 OOM 淘汰优先级设置为先终止本服务。日报每天 08:30 GMT+8 开始，完成后投送；工作流明确使用 `Asia/Shanghai`，不依赖服务器时区。

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

## Codex reset 独立提醒

服务器可启用 `CODEX_RESETS_ENABLED=1`，使用 [Codex Resets 公共 API](https://codex-resets.com/api/docs) 的已执行事件列表。`regular` 显示为 Full reset；`banked` 表示发放储备重置额度。预测、待执行公告和用户自行使用储备额度的行为不触发提醒。

- 每 300 秒检查一次，附加 0–60 秒随机错峰；使用 ETag 条件请求，尊重 `Retry-After`，失败时指数退避。
- 论文任务运行时暂缓检查。沿用原容器 CPU、内存限制，不调用模型。
- PostgreSQL 会话锁及共享下次检查时间防止多实例重复轮询。
- 首次成功抓取只建立历史基线。新事件按事件 ID、类型、目标去重，分别投递到现有群聊和配置的个人 `open_id`。
- 一路投递失败只重试该路；进程重启保留历史及待投递状态。飞书请求使用持久化 UUID。
- 飞书 UUID 去重窗口为一小时。网络结果不确定或发送后进程崩溃时，在 50 分钟内安全重试；超过窗口标为 `uncertain` 等待核对，避免盲目重复发送。
- `GET /codex-resets/status`（仅服务器回环地址）可查看基线、下一次检查、退避原因和投递计数，不返回凭据或目标 ID。

启用部署：`ENABLE_CODEX_RESETS=1 RUN_SMOKE=0 ./scripts/deploy-server.sh`。部署包只包含已提交的 Git 文件；不会打包 `.env` 或 `.deploy.env`。发布时间、源提交和配置备份共同构成回滚锚点。`RUN_SMOKE=0` 避免重新生成和投递论文日报；部署仍核验服务健康及监控初始化。

集成测试使用独立 PostgreSQL 数据库 `reset_monitor_test`，设置 `RESET_TEST_DATABASE_URL` 后运行 `npm test`。测试覆盖双渠道、双类型、并发、重启、304、429、跨页失败和延迟执行的旧公告。

## 后续阶段

第三阶段可增加 Notion、邮件等多渠道投递与阅读反馈闭环。
