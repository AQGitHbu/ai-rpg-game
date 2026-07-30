// ---------------------------------------------------------------------------
// 小镇 demo 试验工具：调 ModelScope 生图 API 为 8 种建筑类型各生成
// 一张俯视贴图，存到 public/assets/town-experiment/<type>.jpg，供
// /town-demo 的「实验：AI 建筑贴图」开关叠加到地图 footprint 上，
// 人工评估真实生图与格子地图的和谐度。运行时手动执行，不进构建；
// Token 读仓库根 .env.local 的 AI_MODEL_SCOPE，绝不打印。
// 用法：node scripts/genTownBuildingImages.mjs [type...]（缺省生成全部 8 种）
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "assets", "town-experiment");
const BASE_URL = "https://api-inference.modelscope.cn/";
const MODEL = "Tongyi-MAI/Z-Image-Turbo";
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 180000;

// 统一风格前后缀：单体建筑、垂直正俯视（只见屋顶平面）、铺满画面。
// 迭代1教训：泛泛说“俯视”会得到整片建筑群的等轴鸟瞰，必须强调
// “只有一座建筑”“垂直向下看”“屋顶占满画面、看不到地面”。
// 迭代2教训：即使说“占满画面”仍会留大片米色背景，要用“特写、裁剪、
// 屋顶超出画框、背景完全被遮挡”的说法逼近满幅。
const STYLE_PREFIX =
  "极近距离航拍正俯视特写：从正上方垂直向下拍摄一座中国古代建筑的屋顶，镜头贴得很近，屋顶边缘被画框裁剪、延伸到画面之外，背景完全被屋顶遮挡，画面每一个角落都是瓦片，没有任何留白，画面里只有这一座建筑，";
const STYLE_SUFFIX =
  "。2D游戏地图俯视贴图素材，手绘风格，深灰青瓦屋顶，暖棕木质细节，柔和均匀漫射光，无透视变形，无文字，无水印，无人物";

const PROMPTS = {
  tavern: "两层酒楼（福来酒楼），青瓦重檐屋顶，屋脊翘角，檐下挂一盏红灯笼",
  blacksmith: "铁匠铺，单层坡屋顶，一角有露天锻造炉与烟囱，屋前堆放铁器",
  house: "普通民居小院，青瓦双坡屋顶，带一个小天井院落",
  shop: "临街店铺，青瓦屋顶，屋前有布幡遮阳棚",
  workshop: "街坊工坊，青瓦屋顶带天窗，屋旁堆木料",
  warehouse: "货栈仓库，大跨度青瓦屋顶，屋顶朴素无装饰",
  well: "石砌水井井亭，小小的四角青瓦亭顶",
  gatehouse: "小镇城门楼，青瓦门楼屋顶，下方是城门洞通道"
};

async function loadToken() {
  const envText = await readFile(path.join(ROOT, ".env.local"), "utf8");
  const match = /^AI_MODEL_SCOPE=(.+)$/m.exec(envText);
  const token = match?.[1]?.trim();
  if (!token) throw new Error(".env.local 缺少 AI_MODEL_SCOPE");
  return token;
}

async function submitTask(token, prompt) {
  const response = await fetch(`${BASE_URL}v1/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-ModelScope-Async-Mode": "true"
    },
    body: JSON.stringify({ model: MODEL, prompt, size: "1024x1024" })
  });
  if (!response.ok) {
    throw new Error(`提交失败 HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json();
  if (!data.task_id) throw new Error(`提交响应缺少 task_id: ${JSON.stringify(data)}`);
  return data.task_id;
}

async function pollTask(token, taskId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE_URL}v1/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-ModelScope-Task-Type": "image_generation"
      }
    });
    if (!response.ok) {
      throw new Error(`轮询失败 HTTP ${response.status}: ${await response.text()}`);
    }
    const data = await response.json();
    if (data.task_status === "SUCCEED") {
      const url = data.output_images?.[0];
      if (!url) throw new Error(`SUCCEED 但缺少 output_images: ${JSON.stringify(data)}`);
      return url;
    }
    if (data.task_status === "FAILED") {
      throw new Error(`生成失败: ${JSON.stringify(data)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`轮询超时（${POLL_TIMEOUT_MS}ms）: task ${taskId}`);
}

async function downloadImage(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
}

async function main() {
  const token = await loadToken();
  await mkdir(OUT_DIR, { recursive: true });
  const requested = process.argv.slice(2);
  const types = requested.length > 0 ? requested : Object.keys(PROMPTS);

  for (const type of types) {
    const body = PROMPTS[type];
    if (!body) {
      console.error(`未知类型 ${type}，可选：${Object.keys(PROMPTS).join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    const prompt = `${STYLE_PREFIX}${body}${STYLE_SUFFIX}`;
    console.log(`[${type}] 提交生成任务…`);
    const startedAt = Date.now();
    try {
      const taskId = await submitTask(token, prompt);
      const imageUrl = await pollTask(token, taskId);
      const filePath = path.join(OUT_DIR, `${type}.jpg`);
      await downloadImage(imageUrl, filePath);
      console.log(`[${type}] 完成（${((Date.now() - startedAt) / 1000).toFixed(1)}s）→ ${path.relative(ROOT, filePath)}`);
    } catch (error) {
      console.error(`[${type}] 失败：${error.message}`);
      process.exitCode = 1;
    }
  }
}

await main();
