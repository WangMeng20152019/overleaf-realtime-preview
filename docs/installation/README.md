# 安装与部署

[English installation guide](README.en.md)

本教程从获取源码开始, 带你在**独立的 Overleaf CE 测试环境**中部署实时预览功能. 安装完成后, 编辑器右侧会提供"传统 PDF"和"LuaLaTeX 实时预览"两个选项. 首次部署请先用论文副本在测试环境中验证, 不要直接在正在写作的服务器上操作.

本项目的实时排版能力来自 [realtime-tex](https://github.com/HenryXiaoYang/realtime-tex), 我们的安装工具负责将其接入 Overleaf 的编辑器, 项目文件与右侧预览区. 非常感谢 realtime-tex 作者与贡献者将这套引擎开源, 也感谢 Overleaf 和 realtime-tex-vsc-plugin 的开源工作.

目前这套方案需要从源码构建并部署到自建环境中, 无法只靠安装浏览器插件启用, 也不能直接用于 overleaf.com 官网账号. 以下流程基于已完成安装与编辑验证的环境编写, 其他 Overleaf 版本不能直接照搬.

## 开始前准备什么

- 一台 Linux amd64 主机, 或能运行完整 amd64 Linux 环境的虚拟机. 本文使用的 CE 镜像为 amd64 架构; ARM 电脑需要准备对应的虚拟机或模拟环境.
- 主机已安装 Docker, Docker Compose v2, Node.js 24 与 npm, Python 3.10 及以上, Git, rustup. 构建引擎时会单独安装固定的 Rust 1.99.1, 不会修改系统默认的 Rust 版本.
- 能够正常下载 GitHub 源码, npm/Cargo/Yarn 依赖, 容器镜像和 TeX 包的网络环境.
- 充足的构建内存. 已验证通过的测试环境为 4 核, 8 GB 内存, 另加 4 GB swap, 且在构建 Overleaf 前端时暂停了该测试实例的应用服务. 这并非最低配置承诺; 内存不足时前端构建可能失败.

在**主机终端**运行以下命令, 检查上述工具是否正常可用:

```sh
docker version
docker compose version
node --version
npm --version
python3 --version
git --version
rustup --version
```

本文所有命令都在**主机终端**中输入: 带 `docker exec` 的命令会进入指定容器执行, 其余命令仍在主机上运行. 请全程保持在**同一个主机终端会话**里操作, 后续步骤会设置容器和项目变量; 如果中途更换了终端, 需要重新设置这些变量.

整体流程: 获取源码 → 启动 Overleaf → 构建实时引擎 → 准备 TeX 和编辑器 → 绑定项目副本 → 启用预览. 首次安装需要下载和编译大量依赖, 具体耗时取决于主机性能与网络状况.

## 1. 获取源码

在主机终端中克隆仓库, 进入源码根目录并创建 `.local` 目录:

```sh
git clone https://github.com/WangMeng20152019/overleaf-realtime-preview.git
cd overleaf-realtime-preview
mkdir -p .local
```

后续所有主机命令都在 `overleaf-realtime-preview` 目录下运行. 如果直接下载了发布页的 `source.tar.gz`, 解压后进入包含 `package.json` 的目录, 再执行 `mkdir -p .local` 即可, 无需再执行 `git clone`.

`.local` 目录用于存放本次构建产物和后续要导入的项目 ZIP 文件, 不属于公开源码.

## 2. 启动一套测试用 Overleaf

示例 [Compose 文件](../../examples/compose.yml) 已固定 Overleaf, MongoDB 和 Redis 镜像. 其中 Overleaf 镜像为:

```text
sharelatex/sharelatex@sha256:a745d0fa67c0d05d8c29bb68502aac52416d92f5631fd6876334314658e1e19e
```

该镜像版本为 CE 6.2.2. 安装工具还会校验需要修改的四个编辑器文件; 仅版本号相同并不代表任意修改过的镜像都能适配.

在主机源码根目录下, 先生成一次持久密钥, 再启动容器并记录 Overleaf 容器 ID:

```sh
python3 deployment/demo-env.py --output examples/.env
docker compose --env-file examples/.env -f examples/compose.yml up -d
RTEX_CE_CONTAINER="$(docker compose --env-file examples/.env -f examples/compose.yml ps -q overleaf)"
```

生成 `examples/.env` 时不会在终端打印密钥, 也不会覆盖已有文件. 请妥善保留 `examples/.env` 和 Compose 数据卷, 后续重启时不要重新生成密钥, 也不要把 `.env` 上传到 GitHub.

检查容器服务是否已正常启动:

```sh
docker compose --env-file examples/.env -f examples/compose.yml ps
```

在浏览器中打开 **http://127.0.0.1:18080/launchpad** 创建第一个管理员账号, 再从 **http://127.0.0.1:18080/login** 登录(即 [Overleaf 自带的管理员初始化流程](https://github.com/overleaf/overleaf/wiki/Creating-and-managing-users)). 登录后, 请先确认能进入项目列表, 且普通 PDF 编译功能可以正常工作.

如果容器运行在远程 Linux 服务器上, 示例端口默认只监听服务器自身的回环地址. 请在你的本地电脑上另开一个终端建立 SSH 隧道, 将下面命令中的 `USER` 和 `SERVER` 替换为你的 SSH 账号与服务器地址:

```sh
ssh -N -L 18080:127.0.0.1:18080 USER@SERVER
```

保持该隧道终端处于开启状态, 在本地电脑浏览器中仍访问 `http://127.0.0.1:18080`. 如果本机 `18080` 端口已被占用, 需要同步修改隧道本地端口, 浏览器访问地址以及后续步骤中的 `--origin` 参数, 不能只改其中一处. 本地示例不会自动配置公网 HTTPS, 域名和反向代理.

## 3. 构建实时预览和引擎

在主机源码根目录下依次执行:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:deployment

rustup toolchain install 1.99.1 --profile minimal
rustup target add --toolchain 1.99.1 x86_64-unknown-linux-musl
python3 engine/build.py prepare --workdir /tmp/rtex-public-engine-build --download-archive
python3 engine/build.py build --workdir /tmp/rtex-public-engine-build --target x86_64-unknown-linux-musl
python3 deployment/package.py \
  --engine-runtime /tmp/rtex-public-engine-build/runtime-x86_64-unknown-linux-musl \
  --output .local/rtex-runtime
```

这一步会先构建并测试本仓库, 再下载和构建固定版本的 `realtime-tex`, 最后将运行所需文件打包到 `.local/rtex-runtime`. 构建脚本会自动校验上游源码, 本项目补丁, 配套 TeX 文件和许可清单. 具体构建选项见[引擎说明](../../engine/README.md).

命令执行成功后, 会生成 `.local/rtex-runtime` 目录. 注意上面的 `/tmp/rtex-public-engine-build` 和输出目录 `.local/rtex-runtime` 都必须是尚未存在的新目录, 脚本不会覆盖旧的构建目录. 若构建失败, 请保留日志排查原因, 重试时改用新的构建路径, 不要跳过校验.

接着在主机源码根目录下执行以下命令, 将打包好的运行时与安装脚本复制进测试容器:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" mkdir -p /opt/overleaf-realtime/integration
tar -cf - deployment/*.py deployment/*.cjs integration/source-patch/*.py integration/source-patch/*.ts | \
  docker exec -i -u 0 "$RTEX_CE_CONTAINER" tar -xf - -C /opt/overleaf-realtime
docker cp .local/rtex-runtime "$RTEX_CE_CONTAINER":/opt/overleaf-realtime/runtime
docker exec -u 0 "$RTEX_CE_CONTAINER" chown -R 0:0 /opt/overleaf-realtime
```

最后一条 `chown` 命令用于修正容器内的文件所有者, 避免 `docker cp` 保留主机用户身份而导致后续安装检查失败.

## 4. 检查 CE 配置, 补齐 TeX 包

这套固定镜像存在一处上游后来已修复的配置问题: 邀请链接的加密选项被配置文件后文的导出语句覆盖. 我们提供了仅适用于原始默认配置的检查与修复脚本, 按照 [Overleaf 官方修复](https://github.com/overleaf/overleaf/blob/e039ad26c5bf5422eb57b89fc7e57c75055e631d/server-ce/hotfix/6.2.2/fix_invite_token_secret.patch)修正该问题, 不会更换现有密钥.

**先在主机终端只执行检查: **

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/ce-settings.py check
```

**只有当检查结果返回 `correctionNeeded: true` 时, 才执行下面两条修复与重启命令: **

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/ce-settings.py apply \
  --state /var/lib/rtex-ce-settings-backup
docker exec -u 0 "$RTEX_CE_CONTAINER" sv -w 45 restart \
  /etc/service/web-overleaf /etc/service/web-api-overleaf
```

如果检查结果表示无需修正, 请直接跳过修复和重启. 执行修复时工具会自动备份原配置; 如果提示配置已被自定义修改或文件不符合预期, 请先停止并排查原因, 不要强制覆盖.

接下来在主机终端执行以下命令, 为容器安装实时捕获所需的 `luatexbase`, 以及中文示例所需的 `ctex` 和 Fandol 字体, 并运行环境自检:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" tlmgr \
  --repository https://mirror.ctan.org/systems/texlive/tlnet update --self
docker exec -u 0 "$RTEX_CE_CONTAINER" tlmgr \
  --repository https://mirror.ctan.org/systems/texlive/tlnet --no-execute-actions install luatexbase ctex fandol
docker exec -u 0 "$RTEX_CE_CONTAINER" mktexlsr
docker exec -u 0 "$RTEX_CE_CONTAINER" env \
  RTEX_TEXDIR=/opt/overleaf-realtime/runtime/deployment/runtime-support/tex \
  /opt/overleaf-realtime/runtime/deployment/runtime-linux/bin/rtex doctor
```

最后一条 `rtex doctor` 应正常通过. 镜像内已自带 LuaLaTeX, 但你的文档模板可能还需要其他宏包或字体. 注意 TeX Live 软件源必须与容器中安装的 TeX Live 年份匹配: 如果执行时提示不支持跨年更新, 请先检查容器内的 `tlmgr --version`, 将 `--repository` 换成对应年份的软件源, 不要忽略错误继续执行. 这里使用 `--no-execute-actions` 跳过无关的格式重建, 再通过 `mktexlsr` 更新文件索引.

## 5. 构建带实时预览的 Overleaf 前端

在主机终端执行以下命令(请确保当前终端已设置好 `$RTEX_CE_CONTAINER` 变量). 脚本会在容器内另建一份前端源码副本, 检查版本兼容性, 然后打补丁并安装前端依赖:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/frontend.py \
  --source /overleaf --stage /var/lib/rtex-build --prepare
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/frontend.py \
  --source /overleaf --stage /var/lib/rtex-build --install
```

接着在主机终端执行前端构建. **注意: 下面的命令会暂时停止当前测试实例的 Overleaf 应用服务, 期间编辑器会中断连接; 请勿在多人共享的生产实例上直接运行. ** 命令结束时会自动恢复服务:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" /bin/sh -c '
  trap "sv up /etc/service/*-overleaf" EXIT
  sv down /etc/service/*-overleaf
  python3 -B /opt/overleaf-realtime/deployment/frontend.py \
    --source /overleaf --stage /var/lib/rtex-build --build
'
```

构建成功后, 容器内会生成 `/var/lib/rtex-build/frontend-public/manifest.json`(前文虚拟机配置下约 102 秒的耗时仅指这一步前端编译, 不是整个安装过程的总时间). 如果构建失败, 请先查看容器内 `/var/lib/rtex-build` 目录下的日志, 排查内存和网络状况, 不要直接跳去执行后面的激活步骤.

## 6. 准备要绑定的项目副本

1. 在浏览器中打开刚启动的 Overleaf, 新建或导入一个**项目副本**(初次测试也可以先用简单的中英文文档).
2. 从该项目左上角菜单下载完整的源码 ZIP 包, 保存到主机源码目录下的 `.local/project.zip`.
3. 查看浏览器地址栏, 记下 `/project/` 后面的 24 位项目 ID(注意这里需要的是项目副本的 ID).
4. 从下载 ZIP 包开始到首次激活完成之前, 暂时不要再编辑这个副本, 以免导出的 ZIP 包落后于 Overleaf 已保存的最新内容.

回到主机终端(保持在主机源码目录下), 把下面命令中的 `PASTE_COPIED_PROJECT_ID` 替换成你自己的 24 位项目 ID, 然后执行命令将 ZIP 包传入容器并导出项目文件结构信息:

```sh
# Replace this value with the copied project's actual 24-character ID.
RTEX_PROJECT_ID=PASTE_COPIED_PROJECT_ID

docker exec -u 0 "$RTEX_CE_CONTAINER" install -d -m 700 /var/lib/rtex-input
docker cp .local/project.zip "$RTEX_CE_CONTAINER":/var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" chown 0:0 /var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" chmod 600 /var/lib/rtex-input/project.zip
docker exec -u 0 "$RTEX_CE_CONTAINER" node /opt/overleaf-realtime/deployment/export-project.cjs \
  --project-id "$RTEX_PROJECT_ID" --web-root /overleaf/services/web \
  --output /var/lib/rtex-input/project-tree.json
```

执行后生成的 `/var/lib/rtex-input/project-tree.json` 仅包含文件 ID, 文件名称和主文件标识, 不包含文档正文. ZIP 包和导出的结构信息必须来自同一个完整项目副本. 导出工具不会覆盖已存在的结构文件; 需要重新导出时, 请在容器的私有输入目录下另选新的 ZIP 和元数据文件名, 并同步调整下载/复制步骤, 导出命令的 `--output`, 以及安装命令的 `--project-zip`, `--tree` 参数, 不要直接覆盖或混用旧文件. 如果后续安装提示 ZIP 包已落后于当前保存的内容, 请重新从 Overleaf 下载 ZIP 包并重新导出结构信息, 不要拿旧 ZIP 包覆盖回项目来迁就校验.

## 7. 安装并启用

在主机终端执行安装命令前, 先确认以下两个参数是否需要替换:

- `--main main.tex`: 换成你项目中实际的主文件路径.
- `--origin http://127.0.0.1:18080`: 必须与你在浏览器中访问 Overleaf 的地址完全一致(包括协议和非默认端口). 如果沿用本文示例配置或通过 SSH 隧道访问, 则无需改动.

命令中的状态目录(`--state`)和静态资源目录(`--assets`)专用于本次新安装, 不要拿其他服务的数据目录来替代. 确认无误后, 在主机终端执行:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py prepare \
  --state /var/lib/overleaf-realtime \
  --runtime /opt/overleaf-realtime/runtime \
  --source /overleaf \
  --frontend /var/lib/rtex-build/frontend-public \
  --manifest-before /overleaf/services/web/public/manifest.json \
  --assets /overleaf/services/web/public/rtex-app-assets \
  --project-zip /var/lib/rtex-input/project.zip \
  --tree /var/lib/rtex-input/project-tree.json \
  --project-id "$RTEX_PROJECT_ID" \
  --origin http://127.0.0.1:18080 \
  --main main.tex \
  --bridge-port 44175 --web-port 4000 --document-updater-port 3003 --nginx-port 80

docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py activate \
  --state /var/lib/overleaf-realtime
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py status \
  --state /var/lib/overleaf-realtime
```

其中, `prepare` 负责准备项目数据, 前端文件和代理配置, `activate` 负责启动服务并启用路由, `status` 用于检查当前安装与运行状态. 实时预览服务在容器内部使用本地回环端口, 由 Overleaf 自身的项目权限检查来授权访问, 无需将 `44175` 端口直接暴露到公网.

`status` 命令应成功退出, 输出中的 `status` 应为 `active`. 若命令报错或状态不同, 先排查, 不要把它当成已经启用.

确认状态正常后, 回到浏览器重新打开该项目的编辑器, 在右侧预览区选择 **LuaLaTeX 实时预览**. 正常情况下可以看到以下效果:

- 可以在传统 PDF 预览和实时预览之间切换.
- 在现有段落里修改中英文内容, 右侧预览会随之更新.
- 新增段落, 公式或删除内容最终会正确显示; 遇到复杂跨页变动时, 仍可能等待完整排版.
- 点击"诊断"按钮可下载运行状态与耗时记录到本地, 不会自动提交 GitHub 报错.

建议在项目副本里依次测试修改一段中文, 一段英文, 一个完整公式和一次删除操作. 实时预览固定使用 LuaLaTeX, 而正式 PDF 编译仍保留 Overleaf 原有的编译器设置; 如果使用 XeLaTeX 模板, 需要另行检查字体和排版兼容性.

## 8. 出问题时怎么恢复

### 先回到原有预览

如果需要停用实时预览并恢复原有预览, 在主机终端执行:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py rollback \
  --state /var/lib/overleaf-realtime
```

该命令会先恢复 nginx 路由, 再停掉本次安装的实时预览服务, 同时保留 Overleaf 已保存的正文, 安装状态和备份. 注意: `rollback` 只是回退路由与服务, 不是卸载, 也不会把论文正文回退成最初导入的 ZIP 包. 如果工具提示路由或进程状态无法核对, 请先查看日志排查, 不要用删除状态目录或强杀进程的方式绕过检查.

只要同一套安装文件保持完整, 后续再次运行 `activate` 即可重新启用实时预览.

### 切走实时模式后再打开, 提示快照不一致

<a id="refreshing-a-stale-preview"></a>

当前版本在离开实时模式后会停止编辑适配器. 如果你在传统 PDF 模式, 断线期间或另一个编辑会话里修改了正文, 再次打开实时预览时可能会出现 `Initial snapshot mismatch` 提示.

遇到该提示时, 请先在浏览器中暂停编辑, 等待 Overleaf 保存完成, 然后由管理员在主机终端执行:

```sh
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py rollback \
  --state /var/lib/overleaf-realtime
docker exec -u 0 "$RTEX_CE_CONTAINER" python3 -B /opt/overleaf-realtime/deployment/install.py activate \
  --state /var/lib/overleaf-realtime
```

命令执行完后, 回到浏览器刷新编辑器页面, 再重新打开实时模式即可. 这一过程会直接从 Overleaf 当前已保存的最新正文重新建立快照, 不会重新导入最初的旧 ZIP 包. 但如果项目的文件结构或资源绑定已经发生变化, 则需要另行检查并重新绑定.

### 重启与重建不是一回事

目前仅验证过同一容器直接重启后的服务恢复. **重新创建容器或升级镜像**不同于普通重启, 安装到容器内非数据卷位置的文件可能会丢失, 不能直接当作普通重启处理, 而需要重新安装或提前设计持久化方案. 无论哪种情况, Docker Compose 的密钥和数据卷都应保留.

## 常见卡点

| 现象 | 先检查什么 |
| --- | --- |
| 18080 打不开 | 检查 Compose 服务是否已启动; 若部署在远程电脑上, 检查本地是否已建立 SSH 隧道 |
| `RTEX_CE_CONTAINER` 为空 | 检查是否在当前同一终端设置过该变量; 检查 Compose 是否找到了 `overleaf` 服务 |
| 前端构建中途退出 | 查看构建日志, 可用内存, swap 和依赖下载情况; 不要在构建失败后继续执行激活 |
| 中文缺字或模板无法编译 | 检查容器内 LuaLaTeX 是否能找到模板要求的宏包与字体 |
| 提示不支持的源码版本 | 检查当前 CE 源码文件是否匹配固定兼容环境; 不要强行跳过检查 |
| 提示 ZIP 与当前正文不同 | 重新从同一项目副本下载最新 ZIP 包, 并重新导出匹配的目录结构文件 |
| 实时模式打不开或快照不匹配 | 等待编辑器保存完成后, 按上文"切走实时模式后再打开, 提示快照不一致"的流程刷新快照 |
| 内容更新或定位不对 | 尽量用小例子复现问题, 点击"诊断"导出记录并检查隐私信息后到 Issues 反馈 |

目前的安装流程仅针对单个可信项目副本和单个受控编辑会话完成验证, 不能作为多用户运行不可信 TeX 代码的隔离平台. 复杂环境和部分包含文件的定位仍不够精确, 真实拼音输入法, 更多模板和多人并发编辑仍有待继续验证. 具体测试结果与支持范围请见[验证记录](../VALIDATION.md)和[兼容范围](../COMPATIBILITY.md).
