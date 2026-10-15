# 人工执行"图片 → 结构化模板"操作手册（manual-extract）

本手册描述如何**不依赖 API 密钥、不在本机调用任何模型**，通过对话式 LLM 网页
（任意支持图片上传的聊天 UI）人工完成"图片→结构化模板"，并把结果交给本程序
生成可编辑模板包。全程本程序零模型调用。

> 适用场景：没有/不想使用 API 密钥；或希望人工把控识别质量。
> 与 API 自动化的关系：完全等价的替代路径——产物相同（同一 SceneSpec schema、
> 同一下游管线），仅"识别者"从 API 模型换成"对话模型 + 你"。

---

## 一、总览：五个步骤与一个迭代闭环

```text
步骤 1  生成提示词    img-to-template prompt <图片>          （本程序，秒级）
步骤 2  对话生成模板  把提示词+图片粘贴到对话 UI，得到 JSON    （人工，几分钟）
步骤 3  保存 spec     把 JSON 保存为 my-spec.json             （人工）
步骤 4  提取模板包    img-to-template extract <图片> <目录> --spec my-spec.json
步骤 5  检查结果      查看 preview.png / diff.png / report.json

迭代闭环（步骤 4/5 报错或不满意时）：
        把校验错误或 diff 图描述粘贴回对话 → 模型修复 → 重新保存 → 重跑步骤 4
```

---

## 二、逐步操作说明

### 步骤 1：生成提示词（程序完成）

```powershell
# 在仓库根目录
npx tsx src/cli.ts prompt input/travel_plan_page_0005.png
```

程序会测量图片真实尺寸并把尺寸、识别规则、输出 JSON Schema 组装成完整提示词，
打印到屏幕。**提示词必须由程序生成**，不要手写——里面的画布尺寸锚定
（如"画布实际尺寸是 1653 × 2339 像素"）来自程序对图片的真实测量，
手写极易写错，坐标就会全错。

也可以直接写入文件方便复制：

```powershell
npx tsx src/cli.ts prompt input/travel_plan_page_0005.png --output prompt.txt
```

### 步骤 2：对话生成模板（人工，在对话式 LLM 网页）

1. 打开你常用的、**支持上传图片**的对话式 LLM 网页（模型选择带视觉能力的）。
2. 新建对话，把步骤 1 的提示词**完整粘贴**为消息文本。
3. 把原始图片（就是步骤 1 用的那张，**不要截图、不要压缩、不要换版本**）
   作为附件添加到同一条消息。
4. 发送。模型会输出一个 JSON 对象（元素列表：文字、照片、色块及其坐标样式）。
5. 若回复被截断（长页面常见）：直接回复"继续"，模型会接着输出；
   把两段拼接成完整 JSON。

### 步骤 3：保存 spec 文件（人工）

1. 复制模型输出的 JSON（如果被 \`\`\`json \`\`\` 围栏包裹，**连围栏一起复制也可以**，
   程序会自动剥离；围栏外的寒暄文字也可以一起复制，程序会截取 JSON 主体）。
2. 保存为文件，如 `my-spec.json`：
   - 编码 UTF-8（Windows 记事本"另存为"时选择 UTF-8）；
   - 确认内容完整（首字符 `{`，末字符 `}`，没有中途截断）。

### 步骤 4：提取模板包（程序完成，零模型调用）

```powershell
npx tsx src/cli.ts extract input/travel_plan_page_0005.png output/travel --spec my-spec.json
```

程序将自动完成（不需要任何模型配置，`OPENAI_API_KEY` 可以完全不设）：

| 环节 | 说明 |
|---|---|
| spec 校验 | 剥围栏 → JSON 解析 → 结构校验（类型/字段/枚举）→ 几何校验（画布边界、唯一 ID） |
| 尺寸一致性 | spec 的 canvas 必须与图片真实尺寸一致（不一致会报错并说明原因） |
| 内容分离 | spec 里 text 元素带的正文自动移入 `content.json`，模板正文清空 |
| 素材裁剪 | image 元素按 x/y/width/height 从原图自动裁出 `assets/<id>.png` 并回填 src（**spec 里 src 留空即可**） |
| 渲染 | 生成 preview.html / preview.png |
| 对比 | 与原图对比生成 diff.png / overlay.png 与差异分数 |
| 报告 | report.json（布局诊断、复查项等） |

产物清单（`output/travel/`）：reference.png、template.json、content.json、
content.schema.json、manifest.json、assets/、preview.html/png、diff.png、
overlay.png、report.json。

### 步骤 5：检查结果

- **preview.png**：程序按你的 spec 重新画出来的页面——肉眼看主要文字、照片、
  色块位置是否与原图一致。
- **diff.png**：与原图的逐像素差异图（红/黄越密集差异越大）。
- **overlay.png**：原图与预览 50% 叠加，方便看出错位方向。
- **report.json**：`reviewItems`（需人工确认的项）、`layout.findings`
  （溢出/越界警告）。

---

## 三、出错时怎么办（迭代闭环）

### 情况 A：步骤 4 报校验错误

错误消息带具体路径与原因，例如：

```text
模板校验失败（my-spec.json）：[OUT_OF_CANVAS] elements[3]: 元素 hotel_name
下边界越出画布：y=2300 + height=60 > 2339（容差 1 px）；
[DUPLICATE_ID] elements[7]: 重复元素 ID：title

把上面这段错误信息粘贴回对话窗口，让模型修复对应元素后重新输出。
```

**操作：把整段错误信息复制回对话窗口**，让模型修复后重新输出 → 重新执行
步骤 3～4。程序已把"错误可回贴"设计进消息文案。

### 情况 B：画布尺寸不一致

```text
spec 画布尺寸（1060×1500）与图片实际尺寸（1653×2339）不一致：请确认提示词
中的画布尺寸锚定与图片为同一版本，或让对话模型修正 canvas 后重新输出
```

通常是图片传错了版本，或模型自己改了 canvas。让模型把 `canvas` 改成错误信息
里的"图片实际尺寸"即可。

### 情况 C：视觉差异大（diff 图红色区域多）

把 diff.png（或直接文字描述，如"标题偏下 20px""右侧照片往左偏了"）发回
对话窗口，让模型调整对应元素的 x/y/width/height 后重新输出。**同一模板反复
微调时**，只让模型改出问题的元素，不要让它重写整个 JSON（避免引入新错误）。

### 情况 D：想改文字内容

不需要再找模型。直接编辑 `output/travel/content.json`（键 = 元素 ID），
然后重渲染：

```powershell
npx tsx src/cli.ts render output/travel
```

改文案、换图片（assets 里换文件 + content 不变）都不需要模型参与。

---

## 四、spec 输入标准（给对话模型的输出要求，也是人工核对清单）

完整 schema 由程序在提示词里内嵌给模型；这里列出关键字段供人工核对：

| 字段 | 必填 | 说明 |
|---|---|---|
| `version` | 是 | 固定 `"1.0"` |
| `canvas.width` / `canvas.height` | 是 | 图片真实像素尺寸（提示词已锚定） |
| `canvas.background` | 是 | 页面底色 `#RRGGBB` |
| `elements[].id` | 是 | 全局唯一；字母/数字/`-`/`_`（如 `title`、`photo_1`、`navy_header`） |
| `elements[].type` | 是 | `text` / `image` / `box` 三选一 |
| `elements[].x,y,width,height` | 是 | 像素坐标（左上原点）；元素必须在画布内 |
| text 的 `text` | 建议 | 模型转录的正文放这里；程序会自动分离到 content.json |
| text 的 `fontSize/color/fontWeight/fontFamily/lineHeight/align/letterSpacing` | 否 | 缺省有默认值（14px/#333333/400/sans/1.4/left/0），模型估个大概即可 |
| image 的 `src` | 留空 | `""`；程序按坐标从原图裁剪并回填 |
| box 的 `fill/borderColor/borderWidth/radius` | 否 | 色块/边框/圆角（头部横条、卡片底、分隔线、徽章底色） |
| `elements[].zIndex` | 否 | 叠放顺序（底色 1、照片 1~2、文字 2+；默认 1） |
| `notes` | 否 | 模型对不确定项的说明 |

**元素划分原则**（提示词已写给模型，人工复核时对照）：
- 每个独立标题/段落/标签/时间/编号 = 一个 text；一段连续多行文字可合为一个 text；
- 照片与复杂图标 = image（坐标贴紧素材边缘）；
- 背景、线条、边框、圆形、标签底色 = box；
- **不允许**把整页或大段文字区域做成 image（那等于用截图伪装还原）；
- **不允许**同一文字既出现在 text 里又被裁进图片。

---

## 五、常见问题

| 问题 | 处理 |
|---|---|
| 模型输出被截断 | 回复"继续"拿到剩余部分，拼接后保存；或分两次让它输出前半/后半 |
| 模型用了归一化坐标（0~1） | 说明提示词没贴全（尺寸锚定段缺失）；重新完整粘贴提示词 |
| 模型加了 schema 外的字段 | 校验会报错；把错误回贴，让它删掉多余字段 |
| 想批量处理多张图 | 每张图重复步骤 1~4（每张图的提示词尺寸锚定不同，不能共用） |
| 模型识别的坐标整体偏差 | 先只让它修 canvas（如果尺寸错）；否则逐区域反馈（"头部区域整体偏下"比"全部重来"有效） |
| 提取成功但想微调样式 | 直接改 `template.json` 里对应元素的字段（fontSize/color/x/y…），重跑 render；不需要模型 |

## 六、安全与边界（与 API 路径一致）

- 模型只产出**数据**（JSON spec）；程序不执行模型返回的任何代码/HTML/CSS。
- spec 走与 API 识别完全相同的校验链路（schema + 几何 + 路径安全）；
  越界、重复 ID、非法路径都会被拒绝并给出可回贴的错误消息。
- spec 文件仅作为本次提取输入；模板包产物（template/content/assets）不依赖
  该文件，删掉不影响后续 render/compare。
